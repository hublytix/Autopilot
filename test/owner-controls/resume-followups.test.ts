import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resumeTargets } from '@/server/domain/followup-schedule';
import { followUpDedupeKey } from '@/server/services/followups/schedule';
import { NotificationKeys, NotificationPredicates } from '@/server/services/notifications/predicates';
import { pauseAll, resumeFollowUps } from '@/server/services/owner-controls';
import { useTestDb as setUpTestDb } from '../db/harness';
import { ZONE } from '../leads/support';
import {
  auditRows,
  createLeadsRig,
  leadJobs,
  markFollowUpSent,
  markRepliedLikeTheJob,
  predicateHolds,
  seedNotifiedLead,
  seedOtherAccount,
  seedOwnedAccount,
  type LeadsRig,
} from './support';

// "Resume follow-ups" (D-42, PLAN §9.6): one transaction clears the reply (its time kept in the audit
// log), bumps the follow-up stream, ignores replies before now, and schedules only the follow-ups not
// yet sent under the new stream's keys; the jobs are published after commit.

const getDb = setUpTestDb();
let rig: LeadsRig;

const SETTINGS = { quietStartHour: 19, quietEndHour: 8, skipWeekends: true };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = createLeadsRig(getDb());
});

afterEach(() => {
  vi.useRealTimers();
});

async function leadState(leadId: string) {
  return getDb().one<{ replied_at: Date | null; stop_reason: string | null; replies_ignored_before: Date | null; followup_stream: number }>(
    `select replied_at, stop_reason, replies_ignored_before, followup_stream from leads where id = $1`,
    [leadId],
  );
}

/** T0 = the rig's start (Tuesday 10:00 in New York); a lead notified then, with both follow-up rows. */
async function notifiedLead() {
  const owned = await seedOwnedAccount(getDb(), { now: rig.clock.now() });
  const t0 = rig.clock.now();
  const lead = await seedNotifiedLead(rig, { accountId: owned.accountId, firstNotifiedAt: t0 });
  return { ...owned, ...lead, t0 };
}

describe('resumeFollowUps', () => {
  it('after an out-of-office reply, reschedules only the unsent follow-up under the new stream key', async () => {
    const db = getDb();
    const lead = await notifiedLead();
    // Follow-up 1 went out on Thursday; the auto-reply came on Friday and stopped follow-up 2.
    await markFollowUpSent(db, lead.leadId, 1, new Date(lead.t0.getTime() + 2 * DAY));
    const repliedAt = new Date(lead.t0.getTime() + 3 * DAY - HOUR);
    rig.clock.set(new Date(lead.t0.getTime() + 3 * DAY));
    await markRepliedLikeTheJob(db, lead.leadId, repliedAt, rig.clock.now());
    rig.clock.advance({ hours: 1 });
    const now = rig.clock.now();

    const result = await resumeFollowUps(rig.deps, lead.scope, lead.leadId);

    const [expected] = resumeTargets(lead.t0, now, [1], SETTINGS, ZONE, lead.accountId);
    if (expected === undefined) throw new Error('no target');
    expect(result).toEqual({ type: 'resumed', followupStream: 1, scheduled: [{ n: 2, runAt: expected.runAt }] });
    expect(await leadState(lead.leadId)).toEqual({ replied_at: null, stop_reason: null, replies_ignored_before: now, followup_stream: 1 });

    const jobs = (await leadJobs(db, lead.leadId)).map((job) => [job.dedupe_key, job.status, job.cancel_reason]);
    expect(jobs).toEqual([
      [followUpDedupeKey(lead.leadId, 1, 0), 'done', null],
      [followUpDedupeKey(lead.leadId, 2, 0), 'cancelled', 'replied'],
      [followUpDedupeKey(lead.leadId, 2, 1), 'scheduled', null],
    ]);
    const fresh = (await leadJobs(db, lead.leadId)).find((job) => job.dedupe_key === followUpDedupeKey(lead.leadId, 2, 1));
    expect(fresh?.payload).toEqual({ leadId: lead.leadId, n: 2, followupStream: 1, targetAt: expected.runAt.toISOString() });
    expect(fresh?.run_at).toEqual(expected.runAt);
    expect(fresh?.external_id).not.toBeNull();

    expect(await auditRows(db, lead.accountId)).toEqual([
      { actor: 'owner', action: 'lead.followups_resumed', meta: { leadId: lead.leadId, repliedAt: repliedAt.toISOString(), followupStream: 1 } },
    ]);
    // The new stream's follow-up 2 may be reserved again.
    expect(await predicateHolds(db, NotificationPredicates.followUp({ accountId: lead.accountId, leadId: lead.leadId }, 2))).toBe(true);
  });

  it('after day 5 with neither follow-up sent, puts follow-up 1 an hour out and follow-up 2 three days later', async () => {
    const db = getDb();
    const lead = await notifiedLead();
    // The reply was found by follow-up 1's job on Thursday, before it sent anything.
    rig.clock.set(new Date(lead.t0.getTime() + 2 * DAY));
    await markRepliedLikeTheJob(db, lead.leadId, new Date(lead.t0.getTime() + DAY), rig.clock.now());
    rig.clock.set(new Date('2026-10-12T15:00:00.000Z')); // Monday 11:00 in New York

    const result = await resumeFollowUps(rig.deps, lead.scope, lead.leadId);

    expect(result).toEqual({
      type: 'resumed',
      followupStream: 1,
      scheduled: [
        { n: 1, runAt: new Date('2026-10-12T16:00:00.000Z') },
        { n: 2, runAt: new Date('2026-10-15T16:00:00.000Z') },
      ],
    });
    const fresh = (await leadJobs(db, lead.leadId)).filter((job) => job.status === 'scheduled');
    expect(fresh.map((job) => [job.dedupe_key, job.run_at])).toEqual([
      [followUpDedupeKey(lead.leadId, 1, 1), new Date('2026-10-12T16:00:00.000Z')],
      [followUpDedupeKey(lead.leadId, 2, 1), new Date('2026-10-15T16:00:00.000Z')],
    ]);
  });

  it('leaves a follow-up whose email of the old stream is still being sent to the sweeper', async () => {
    const db = getDb();
    const lead = await notifiedLead();
    rig.clock.set(new Date(lead.t0.getTime() + 2 * DAY));
    // Follow-up 1's email was reserved (passed its predicates) just before the reply was recorded.
    await db.query(
      `insert into notifications_sent (dedupe_key, account_id, lead_id, kind, status, first_reserved_at, reserved_at, send_attempts, sweeper_resumes, recipients_count)
       values ($1, $2, $3, 'follow_up', 'sending', $4, $4, 1, 0, 0)`,
      [NotificationKeys.followUp(lead.leadId, 1, 0), lead.accountId, lead.leadId, rig.clock.now()],
    );
    await markRepliedLikeTheJob(db, lead.leadId, rig.clock.now(), rig.clock.now());
    rig.clock.advance({ hours: 2 });

    const result = await resumeFollowUps(rig.deps, lead.scope, lead.leadId);

    expect(result).toMatchObject({ type: 'resumed', followupStream: 1 });
    expect(result.type === 'resumed' ? result.scheduled.map((target) => target.n) : []).toEqual([2]);
    const expected = resumeTargets(lead.t0, rig.clock.now(), [1], SETTINGS, ZONE, lead.accountId);
    expect(result.type === 'resumed' ? result.scheduled : []).toEqual(expected.map((target) => ({ n: target.n, runAt: target.runAt })));
  });

  it('resumed after day 5 while the old follow-up 1 is still being sent: follow-up 2 keeps 3 days after it (D-73)', async () => {
    const db = getDb();
    const lead = await notifiedLead();
    rig.clock.set(new Date(lead.t0.getTime() + 6 * DAY));
    const reservedAt = rig.clock.now();
    await db.query(
      `insert into notifications_sent (dedupe_key, account_id, lead_id, kind, status, first_reserved_at, reserved_at, send_attempts, sweeper_resumes, recipients_count)
       values ($1, $2, $3, 'follow_up', 'sending', $4, $4, 1, 0, 0)`,
      [NotificationKeys.followUp(lead.leadId, 1, 0), lead.accountId, lead.leadId, reservedAt],
    );
    await markRepliedLikeTheJob(db, lead.leadId, rig.clock.now(), rig.clock.now());
    rig.clock.advance({ hours: 1 });

    const result = await resumeFollowUps(rig.deps, lead.scope, lead.leadId);

    if (result.type !== 'resumed') throw new Error('not resumed');
    expect(result.scheduled.map((target) => target.n)).toEqual([2]);
    expect(result.scheduled[0]?.runAt.getTime()).toBeGreaterThanOrEqual(reservedAt.getTime() + 3 * DAY - HOUR);
    expect(result.scheduled).toEqual(
      resumeTargets(lead.t0, rig.clock.now(), [1], SETTINGS, ZONE, lead.accountId, { 1: reservedAt }).map((target) => ({ n: target.n, runAt: target.runAt })),
    );
  });

  it('cancels a follow-up job of the old stream still pending (the reply should have) before scheduling the new ones', async () => {
    const db = getDb();
    const lead = await notifiedLead();
    rig.clock.set(new Date(lead.t0.getTime() + DAY));
    await db.query(`update leads set replied_at = $2, stop_reason = 'replied' where id = $1`, [lead.leadId, rig.clock.now()]);
    const oldMessages = lead.jobs.map((job) => job.externalId);

    const result = await resumeFollowUps(rig.deps, lead.scope, lead.leadId);

    expect(result).toMatchObject({ type: 'resumed', followupStream: 1 });
    const jobs = (await leadJobs(db, lead.leadId)).map((job) => [job.dedupe_key, job.status, job.cancel_reason]);
    expect(jobs).toEqual([
      [followUpDedupeKey(lead.leadId, 1, 0), 'cancelled', 'replied'],
      [followUpDedupeKey(lead.leadId, 1, 1), 'scheduled', null],
      [followUpDedupeKey(lead.leadId, 2, 0), 'cancelled', 'replied'],
      [followUpDedupeKey(lead.leadId, 2, 1), 'scheduled', null],
    ]);
    expect(rig.fakes.scheduler.cancelled).toEqual(oldMessages);
  });

  it('clears the reply but schedules nothing when both follow-ups were already sent', async () => {
    const db = getDb();
    const lead = await notifiedLead();
    await markFollowUpSent(db, lead.leadId, 1, new Date(lead.t0.getTime() + 2 * DAY));
    await markFollowUpSent(db, lead.leadId, 2, new Date(lead.t0.getTime() + 5 * DAY));
    rig.clock.set(new Date(lead.t0.getTime() + 6 * DAY));
    await db.query(`update leads set replied_at = $2 where id = $1`, [lead.leadId, rig.clock.now()]);

    expect(await resumeFollowUps(rig.deps, lead.scope, lead.leadId)).toEqual({ type: 'resumed', followupStream: 1, scheduled: [] });
    expect(await leadState(lead.leadId)).toMatchObject({ replied_at: null, stop_reason: null, followup_stream: 1 });
  });

  it('is refused the second time: the reply is already cleared', async () => {
    const db = getDb();
    const lead = await notifiedLead();
    rig.clock.set(new Date(lead.t0.getTime() + DAY));
    await markRepliedLikeTheJob(db, lead.leadId, rig.clock.now(), rig.clock.now());
    await resumeFollowUps(rig.deps, lead.scope, lead.leadId);

    expect(await resumeFollowUps(rig.deps, lead.scope, lead.leadId)).toEqual({ type: 'refused', reason: 'not_replied' });
    expect((await leadState(lead.leadId)).followup_stream).toBe(1);
    expect(await auditRows(db, lead.accountId)).toHaveLength(1);
  });

  it.each([
    ['dismissed', `dismissed_at = $2, stop_reason = 'replied'`, 'dismissed'],
    ['a test lead', `is_test = true, stop_reason = 'test_lead'`, 'test_lead'],
    ['privacy-deleted', `stop_reason = 'privacy_deletion'`, 'privacy_deleted'],
    ['opted out after replying', `stop_reason = 'opted_out'`, 'stopped'],
    ['never emailed', `first_notified_at = null, stop_reason = 'replied'`, 'not_notified'],
  ] as const)('refuses a lead that is %s and changes nothing', async (_label, set, reason) => {
    const db = getDb();
    const lead = await notifiedLead();
    rig.clock.set(new Date(lead.t0.getTime() + DAY));
    await markRepliedLikeTheJob(db, lead.leadId, rig.clock.now(), rig.clock.now());
    await db.query(`update leads set ${set} where id = $1`, set.includes('$2') ? [lead.leadId, rig.clock.now()] : [lead.leadId]);
    const before = await leadState(lead.leadId);

    expect(await resumeFollowUps(rig.deps, lead.scope, lead.leadId)).toEqual({ type: 'refused', reason });
    expect(await leadState(lead.leadId)).toEqual(before);
    expect((await leadJobs(db, lead.leadId)).filter((job) => job.status === 'scheduled')).toEqual([]);
    expect(await auditRows(db, lead.accountId)).toEqual([]);
  });

  it('refuses a lead that has not replied', async () => {
    const lead = await notifiedLead();
    expect(await resumeFollowUps(rig.deps, lead.scope, lead.leadId)).toEqual({ type: 'refused', reason: 'not_replied' });
    expect((await leadState(lead.leadId)).followup_stream).toBe(0);
  });

  it('refuses while the account is paused, and while follow-ups are switched off', async () => {
    const db = getDb();
    const lead = await notifiedLead();
    rig.clock.set(new Date(lead.t0.getTime() + DAY));
    await markRepliedLikeTheJob(db, lead.leadId, rig.clock.now(), rig.clock.now());

    await db.query(`update settings set followups_enabled = false where account_id = $1`, [lead.accountId]);
    expect(await resumeFollowUps(rig.deps, lead.scope, lead.leadId)).toEqual({ type: 'refused', reason: 'followups_off' });

    await db.query(`update settings set followups_enabled = true where account_id = $1`, [lead.accountId]);
    await pauseAll(rig.deps, lead.scope);
    expect(await resumeFollowUps(rig.deps, lead.scope, lead.leadId)).toEqual({ type: 'refused', reason: 'account_not_active' });
    expect(await leadState(lead.leadId)).toMatchObject({ stop_reason: 'replied', followup_stream: 0 });
  });

  it("never touches another account's lead", async () => {
    const db = getDb();
    const lead = await notifiedLead();
    rig.clock.set(new Date(lead.t0.getTime() + DAY));
    await markRepliedLikeTheJob(db, lead.leadId, rig.clock.now(), rig.clock.now());
    const other = await seedOtherAccount(db, rig.clock.now());

    expect(await resumeFollowUps(rig.deps, other.scope, lead.leadId)).toEqual({ type: 'refused', reason: 'not_found' });
    expect(await leadState(lead.leadId)).toMatchObject({ stop_reason: 'replied', followup_stream: 0 });
  });
});
