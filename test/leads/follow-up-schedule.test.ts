import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { followUpTargets } from '@/server/domain/followup-schedule';
import { onAlert, type RaisedAlert } from '@/server/jobs/alert';
import { followUpDedupeKey, scheduleFollowUpsInTx } from '@/server/services/followups/schedule';
import { useTestDb as setUpTestDb } from '../db/harness';
import { createLeadsRig, followUpJobs, leadRow, seedLeadAccount, seedNewLead, ZONE, type LeadsRig } from './support';

// The follow-up job rows of the "notified" transaction (PLAN §8.2, §8.5, §9.3 step 6, D-14, D-33):
// two rows at shiftToAllowed(T0 + 2 d / 5 d) in the portal's zone, keyed by the follow-up stream,
// with `targetAt` for the hop check; none for a test lead, with follow-ups off, or a stopped lead.

const getDb = setUpTestDb();

let rig: LeadsRig;
let alerts: RaisedAlert[];
let stopAlerts: () => void;

beforeEach(() => {
  // PLAN §12: nothing here may read the wall clock, so the system time is far from the test's Clock.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = createLeadsRig(getDb());
  alerts = [];
  stopAlerts = onAlert((alert) => alerts.push(alert));
});

afterEach(() => {
  stopAlerts();
  vi.useRealTimers();
});

async function seeded(options: { followupsEnabled?: boolean; isTest?: boolean } = {}) {
  const db = getDb();
  const accountId = await seedLeadAccount(db, { now: rig.clock.now(), followupsEnabled: options.followupsEnabled });
  const leadId = await seedNewLead(db, { accountId, now: rig.clock.now(), isTest: options.isTest });
  return { accountId, leadId };
}

function schedule(input: { accountId: string; leadId: string }, t0: Date = rig.clock.now()) {
  return getDb().tx((tx) => scheduleFollowUpsInTx(tx, { ...input, firstNotifiedAt: t0, now: rig.clock.now() }));
}

describe('scheduleFollowUpsInTx', () => {
  it('inserts follow-ups 1 and 2 at the shifted targets, keyed by the follow-up stream, with targetAt', async () => {
    const db = getDb();
    const lead = await seeded();
    await db.query(`update leads set followup_stream = 3 where id = $1`, [lead.leadId]);
    // Friday 18:30 in New York: day 2 is Sunday (weekend → Monday 08:00), day 5 is Wednesday 18:30 (allowed).
    const t0 = new Date('2026-10-09T22:30:00.000Z');

    const result = await schedule(lead, t0);

    const targets = followUpTargets(t0, { quietStartHour: 19, quietEndHour: 8, skipWeekends: true }, ZONE, lead.accountId);
    expect(result).toMatchObject({ type: 'scheduled', targets });
    expect(targets[0].shifted).toBe(true);
    expect(targets[1]).toMatchObject({ shifted: false, runAt: new Date('2026-10-14T22:30:00.000Z') });
    const jobs = await followUpJobs(db, lead.leadId);
    expect(jobs.map((job) => [job.dedupe_key, job.seq, job.run_at, job.payload])).toEqual([
      [followUpDedupeKey(lead.leadId, 1, 3), 1, targets[0].runAt, { leadId: lead.leadId, n: 1, followupStream: 3, targetAt: targets[0].runAt.toISOString() }],
      [followUpDedupeKey(lead.leadId, 2, 3), 2, targets[1].runAt, { leadId: lead.leadId, n: 2, followupStream: 3, targetAt: targets[1].runAt.toISOString() }],
    ]);
    expect(jobs[0]?.dedupe_key).toBe(`lead:${lead.leadId}:fu:1:s3`);
  });

  it('follows the account’s quiet hours and weekend setting', async () => {
    const db = getDb();
    const lead = await seeded();
    await db.query(`update settings set quiet_start_hour = 9, quiet_end_hour = 9, skip_weekends = false where account_id = $1`, [lead.accountId]);
    const t0 = new Date('2026-10-09T22:30:00.000Z');
    await schedule(lead, t0);
    // No quiet hours, weekends allowed: exactly T0 + 2 / 5 calendar days.
    expect((await followUpJobs(db, lead.leadId)).map((job) => job.run_at)).toEqual([new Date('2026-10-11T22:30:00.000Z'), new Date('2026-10-14T22:30:00.000Z')]);
  });

  it('is idempotent: a second call inserts nothing new', async () => {
    const db = getDb();
    const lead = await seeded();
    await schedule(lead);
    const again = await schedule(lead);
    expect(again).toMatchObject({ type: 'scheduled', jobs: [null, null] });
    expect(await followUpJobs(db, lead.leadId)).toHaveLength(2);
  });

  it('never schedules follow-ups for a test lead', async () => {
    const db = getDb();
    const lead = await seeded({ isTest: true });
    expect(await schedule(lead)).toEqual({ type: 'test_lead' });
    expect(await followUpJobs(db, lead.leadId)).toEqual([]);
  });

  it('with follow-ups off: no rows, and the lead is marked followups_off', async () => {
    const db = getDb();
    const lead = await seeded({ followupsEnabled: false });
    expect(await schedule(lead)).toEqual({ type: 'followups_off' });
    expect(await followUpJobs(db, lead.leadId)).toEqual([]);
    expect((await leadRow(db, lead.leadId)).stop_reason).toBe('followups_off');
  });

  it('a lead dismissed before its email was marked sent gets no follow-ups', async () => {
    const db = getDb();
    const lead = await seeded();
    await db.query(`update leads set dismissed_at = $2, stop_reason = 'dismissed' where id = $1`, [lead.leadId, rig.clock.now()]);
    expect(await schedule(lead)).toEqual({ type: 'stopped' });
    expect(await followUpJobs(db, lead.leadId)).toEqual([]);
    expect((await leadRow(db, lead.leadId)).stop_reason).toBe('dismissed');
  });

  it('falls back to UTC for an unusable stored timezone', async () => {
    const db = getDb();
    const lead = await seeded();
    await db.query(`update accounts set timezone = 'Not/AZone' where id = $1`, [lead.accountId]);
    const t0 = new Date('2026-10-06T14:00:00.000Z');
    const result = await schedule(lead, t0);
    const utc = followUpTargets(t0, { quietStartHour: 19, quietEndHour: 8, skipWeekends: true }, 'UTC', lead.accountId);
    expect(result).toMatchObject({ type: 'scheduled', targets: utc });
    expect(alerts).toEqual([]);
  });

  it('a lead that no longer exists gets nothing', async () => {
    const lead = await seeded();
    expect(await schedule({ accountId: lead.accountId, leadId: '00000000-0000-4000-8000-000000000000' })).toEqual({ type: 'lead_missing' });
  });
});
