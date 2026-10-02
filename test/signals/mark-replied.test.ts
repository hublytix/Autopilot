import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeSentMail } from '@/server/adapters/fake/mailer/fake-mailer';
import { runSweeper } from '@/server/jobs/sweeper';
import { createOwnerScopeForTest } from '@/server/services/auth/owner-scope';
import { resumeFollowUps } from '@/server/services/owner-controls';
import { markReplied, markRepliedInTx } from '@/server/services/signals';
import { interceptBefore } from '../db/intercept';
import { useTestDb as setUpTestDb } from '../db/harness';
import { apply, at, createSignalsRig, DAY, HOUR, jobStatuses, LEAD_EMAIL, MINUTE, replyReservations, seedNotifiedLead, signalRow, type SignalsRig } from './support';

// markReplied (PLAN §9.5 step 4, §8.4, D-08, D-45): one transaction that records the reply, cancels
// the remaining follow-ups and reserves the reply_detected email only while follow-ups were still
// scheduled; the email after commit, exactly once, through crashes, retries and the sweeper.

const getDb = setUpTestDb();
let rig: SignalsRig;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = await createSignalsRig(getDb());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function replyEmails(): FakeSentMail[] {
  return rig.fakes.mailer.sent.filter((mail) => mail.kind === 'reply_detected');
}

/** The lead replied 30 h after T0; the clock is at T0 + 2 days (follow-up 1's run). */
async function repliedLead(options: { followUps?: boolean } = {}) {
  const t0 = rig.clock.now();
  const lead = await seedNotifiedLead(rig, { followUps: options.followUps });
  rig.clock.set(at(t0, 2 * DAY));
  rig.hubspot.logLeadReply({ from: LEAD_EMAIL, at: at(t0, 30 * HOUR) });
  return { ...lead, t0, replyAt: at(t0, 30 * HOUR) };
}

describe('markReplied: the winner', () => {
  it('records the reply, cancels the other follow-up (QStash too) and emails the owner once', async () => {
    const db = getDb();
    const lead = await repliedLead();
    const [fu1, fu2] = await jobStatuses(db, lead.leadId);

    const result = await apply(rig, lead.leadId, { caller: 'followup_job', jobId: lead.jobIds[0] });

    expect(result).toMatchObject({ outcome: 'checked', stop: 'replied', replied: true, markedReplied: true, replyEmail: 'sent' });
    expect(await signalRow(db, lead.leadId)).toMatchObject({ replied_at: lead.replyAt, stop_reason: 'replied' });
    // The calling job (follow-up 1) is left to finish; follow-up 2 is cancelled, in QStash too.
    expect(await jobStatuses(db, lead.leadId)).toMatchObject([
      { seq: 1, status: 'scheduled', cancel_reason: null },
      { seq: 2, status: 'cancelled', cancel_reason: 'replied' },
    ]);
    expect(rig.fakes.scheduler.cancelled).toEqual([fu2?.external_id]);
    expect(rig.fakes.scheduler.cancelled).not.toContain(fu1?.external_id);

    expect(await replyReservations(db, lead.leadId)).toEqual([{ dedupe_key: `reply:${lead.leadId}:s0`, kind: 'reply_detected', status: 'sent' }]);
    const [mail] = replyEmails();
    expect(replyEmails()).toHaveLength(1);
    expect(mail?.subject).toBe('Maya replied — follow-ups stopped');
    expect(mail?.to).toEqual(['owner@example.com']);
    expect(mail?.html).toContain(`https://app.hubspot.com/contacts/${rig.portalId}/record/0-1/${lead.contactId}`);
    // No lead content beyond the safe first name (D-31): neither the message nor the address.
    expect(mail?.html).not.toContain(LEAD_EMAIL);
    expect(mail?.text).not.toContain('leaking');
  });

  it('emails from the last follow-up job even with nothing left to cancel (D-08: the caller is a follow-up job)', async () => {
    const db = getDb();
    const lead = await repliedLead();
    await db.query(`update scheduled_jobs set status = 'done' where id = $1`, [lead.jobIds[0]]);

    const result = await apply(rig, lead.leadId, { caller: 'followup_job', jobId: lead.jobIds[1] });

    expect(result).toMatchObject({ markedReplied: true, replyEmail: 'sent' });
    expect(rig.fakes.scheduler.cancelled).toEqual([]);
    expect(replyEmails()).toHaveLength(1);
  });

  it('emails from a refresh only when it cancels a follow-up still scheduled', async () => {
    const lead = await repliedLead();
    const result = await apply(rig, lead.leadId, { caller: 'refresh' });
    expect(result).toMatchObject({ markedReplied: true, replyEmail: 'sent' });
    expect(await jobStatuses(getDb(), lead.leadId)).toMatchObject([{ status: 'cancelled' }, { status: 'cancelled' }]);
    expect(replyEmails()).toHaveLength(1);
  });

  it('only updates the status when a refresh finds the reply after the follow-ups finished', async () => {
    const db = getDb();
    const lead = await repliedLead();
    await db.query(`update scheduled_jobs set status = 'done' where lead_id = $1`, [lead.leadId]);
    await db.query(`update leads set fu1_notified_at = $2, fu2_notified_at = $3 where id = $1`, [lead.leadId, at(lead.t0, 2 * DAY), at(lead.t0, 5 * DAY)]);

    const result = await apply(rig, lead.leadId, { caller: 'refresh' });

    expect(result).toMatchObject({ markedReplied: true, replied: true, stop: 'replied', replyEmail: 'none' });
    expect(await signalRow(db, lead.leadId)).toMatchObject({ replied_at: lead.replyAt, stop_reason: 'replied' });
    expect(await replyReservations(db, lead.leadId)).toEqual([]);
    expect(replyEmails()).toEqual([]);
  });

  it('records the reply but sends nothing when the email\'s predicates fail (dismissed, account paused)', async () => {
    const db = getDb();
    const dismissed = await repliedLead();
    await db.query(`update leads set dismissed_at = $2, stop_reason = 'dismissed' where id = $1`, [dismissed.leadId, at(dismissed.t0, HOUR)]);
    expect(await apply(rig, dismissed.leadId, { caller: 'followup_job' })).toMatchObject({ markedReplied: true, replyEmail: 'none' });
    expect(await signalRow(db, dismissed.leadId)).toMatchObject({ replied_at: dismissed.replyAt, stop_reason: 'replied' });

    const second = await seedNotifiedLead(rig, { email: 'sam@riverton-dental.example', firstName: 'Sam' });
    await db.query(`update accounts set processing_state = 'paused' where id = $1`, [rig.accountId]);
    rig.clock.advance(MINUTE);
    rig.hubspot.logLeadReply({ from: 'sam@riverton-dental.example', at: rig.clock.now() });
    rig.clock.advance(MINUTE);
    expect(await apply(rig, second.leadId, { caller: 'followup_job' })).toMatchObject({ markedReplied: true, replyEmail: 'none' });

    expect(await replyReservations(db, dismissed.leadId)).toEqual([]);
    expect(await replyReservations(db, second.leadId)).toEqual([]);
    expect(replyEmails()).toEqual([]);
  });
});

describe('markReplied: later callers', () => {
  it('a second caller gets no row back: no cancellation, no email', async () => {
    const lead = await repliedLead();
    expect(await apply(rig, lead.leadId, { caller: 'followup_job', jobId: lead.jobIds[0] })).toMatchObject({ markedReplied: true });
    const cancelledBefore = rig.fakes.scheduler.cancelled.length;

    const second = await apply(rig, lead.leadId, { caller: 'followup_job', jobId: lead.jobIds[1] });
    const third = await markReplied(rig.deps, { accountId: rig.accountId, leadId: lead.leadId, repliedAt: lead.replyAt, followUpStillScheduled: true });

    expect(second).toMatchObject({ markedReplied: false, replied: true, stop: 'replied', replyEmail: 'none' });
    expect(third).toEqual({ won: false, repliedAt: lead.replyAt, cancelledJobs: 0, replyEmail: 'none' });
    expect(rig.fakes.scheduler.cancelled).toHaveLength(cancelledBefore);
    expect(replyEmails()).toHaveLength(1);
  });

  it('two callers racing for the same reply: exactly one wins (sequential replay, PLAN §12)', async () => {
    const db = getDb();
    const lead = await repliedLead();
    // The competing follow-up job records the reply just before this caller's UPDATE runs.
    const competing = interceptBefore(db, /update leads set replied_at = \$3, stop_reason = 'replied'/, async (handle) => {
      const won = await handle.tx((tx) =>
        markRepliedInTx(tx, { accountId: rig.accountId, leadId: lead.leadId, repliedAt: lead.replyAt, followUpStillScheduled: true, now: rig.clock.now() }),
      );
      expect(won.won).toBe(true);
    });

    const loser = await markReplied(
      { ...rig.deps, db: competing.db },
      { accountId: rig.accountId, leadId: lead.leadId, repliedAt: lead.replyAt, followUpStillScheduled: true },
      { notifications: rig.notifications },
    );

    expect(competing.fired()).toBe(1);
    expect(loser).toEqual({ won: false, repliedAt: lead.replyAt, cancelledJobs: 0, replyEmail: 'none' });
    // The winner's reservation is the only one; the loser did not send it.
    expect(await replyReservations(db, lead.leadId)).toEqual([{ dedupe_key: `reply:${lead.leadId}:s0`, kind: 'reply_detected', status: 'sending' }]);
    expect(replyEmails()).toEqual([]);
  });
});

describe('markReplied: a lost send is sent once', () => {
  it('after a transient Resend error, the retry sends the reserved email once', async () => {
    const db = getDb();
    const lead = await repliedLead();
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error' });

    const first = await apply(rig, lead.leadId, { caller: 'followup_job', jobId: lead.jobIds[0] });
    expect(first).toMatchObject({ markedReplied: true, replyEmail: 'pending' });
    expect(await replyReservations(db, lead.leadId)).toMatchObject([{ status: 'sending' }]);
    expect(replyEmails()).toEqual([]);

    // The job's redelivery runs applySignals again: it loses markReplied and sends the pending email.
    const retry = await apply(rig, lead.leadId, { caller: 'followup_job', jobId: lead.jobIds[0] });
    expect(retry).toMatchObject({ markedReplied: false, replyEmail: 'sent' });
    expect(await replyReservations(db, lead.leadId)).toMatchObject([{ status: 'sent' }]);
    expect(replyEmails()).toHaveLength(1);

    // Nothing is left for the sweeper or another check.
    rig.clock.advance(3 * HOUR);
    const swept = await runSweeper(rig.deps, { jobRegistry: rig.registry, notificationRegistry: rig.notifications });
    expect(swept.notificationsResumed).toBe(0);
    expect(await apply(rig, lead.leadId, { caller: 'refresh' })).toMatchObject({ replyEmail: 'none' });
    expect(replyEmails()).toHaveLength(1);
  });

  it('after a transient Resend error, the sweeper sends it once when no retry comes', async () => {
    const db = getDb();
    const lead = await repliedLead();
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'rate_limit_exceeded' });
    expect(await apply(rig, lead.leadId, { caller: 'followup_job', jobId: lead.jobIds[0] })).toMatchObject({ replyEmail: 'pending' });

    rig.clock.advance(5 * MINUTE);
    expect((await runSweeper(rig.deps, { jobRegistry: rig.registry, notificationRegistry: rig.notifications })).notificationsResumed).toBe(0);
    rig.clock.advance(6 * MINUTE);
    expect((await runSweeper(rig.deps, { jobRegistry: rig.registry, notificationRegistry: rig.notifications })).notificationsResumed).toBe(1);

    expect(await replyReservations(db, lead.leadId)).toMatchObject([{ status: 'sent' }]);
    expect(replyEmails()).toHaveLength(1);
    expect(replyEmails()[0]?.subject).toBe('Maya replied — follow-ups stopped');
    rig.clock.advance(3 * HOUR);
    await runSweeper(rig.deps, { jobRegistry: rig.registry, notificationRegistry: rig.notifications });
    expect(await apply(rig, lead.leadId, { caller: 'refresh' })).toMatchObject({ replyEmail: 'none' });
    expect(replyEmails()).toHaveLength(1);
  });

  it('when the email went out but the response was lost, the retry sees Resend\'s 409 and sends nothing more', async () => {
    const db = getDb();
    const lead = await repliedLead();
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error', afterSend: true });

    expect(await apply(rig, lead.leadId, { caller: 'followup_job', jobId: lead.jobIds[0] })).toMatchObject({ replyEmail: 'pending' });
    expect(replyEmails()).toHaveLength(1);

    expect(await apply(rig, lead.leadId, { caller: 'followup_job', jobId: lead.jobIds[0] })).toMatchObject({ replyEmail: 'sent' });
    expect(await replyReservations(db, lead.leadId)).toMatchObject([{ status: 'sent' }]);
    expect(replyEmails()).toHaveLength(1);
  });

  it('a crash between the commit and the send leaves the reservation for the next check', async () => {
    const db = getDb();
    const lead = await repliedLead();
    // markRepliedInTx alone is the committed transaction of a process that died before sending.
    const committed = await db.tx((tx) =>
      markRepliedInTx(tx, { accountId: rig.accountId, leadId: lead.leadId, repliedAt: lead.replyAt, followUpStillScheduled: true, exceptJobId: lead.jobIds[0], now: rig.clock.now() }),
    );
    expect(committed).toMatchObject({ won: true, reservationKey: `reply:${lead.leadId}:s0` });

    expect(await apply(rig, lead.leadId, { caller: 'followup_job', jobId: lead.jobIds[0] })).toMatchObject({ markedReplied: false, replyEmail: 'sent' });
    expect(replyEmails()).toHaveLength(1);
  });
});

describe('markReplied after "Resume follow-ups" (D-42, D-73)', () => {
  async function ownerScope() {
    const owner = await getDb().one<{ owner_user_id: string }>(`select owner_user_id from accounts where id = $1`, [rig.accountId]);
    return createOwnerScopeForTest(rig.accountId, owner.owner_user_id);
  }

  /** The out-of-office reply was recorded by follow-up 1's job (reply_detected sent), and that job ended. */
  async function autoReplied() {
    const lead = await repliedLead();
    expect(await apply(rig, lead.leadId, { caller: 'followup_job', jobId: lead.jobIds[0] })).toMatchObject({ markedReplied: true, replyEmail: 'sent' });
    await getDb().query(`update scheduled_jobs set status = 'done' where id = $1`, [lead.jobIds[0]]);
    return lead;
  }

  it('a check that read HubSpot before the resume committed never records the ignored auto-reply again (sequential replay)', async () => {
    const db = getDb();
    const lead = await autoReplied();
    const scope = await ownerScope();
    // The owner's "Resume follow-ups" commits just before the refresh's markReplied UPDATE runs.
    const resumed = interceptBefore(db, /update leads set replied_at = \$3, stop_reason = 'replied'/, async (handle) => {
      expect(await resumeFollowUps({ ...rig.deps, db: handle }, scope, lead.leadId)).toMatchObject({ type: 'resumed', followupStream: 1 });
    });

    const stale = await apply({ ...rig, deps: { ...rig.deps, db: resumed.db } }, lead.leadId, { caller: 'refresh' });

    expect(resumed.fired()).toBe(1);
    expect(stale).toMatchObject({ markedReplied: false, replied: false, replyEmail: 'none' });
    expect(await signalRow(db, lead.leadId)).toMatchObject({ replied_at: null, stop_reason: null, followup_stream: 1 });
    expect(
      await db.query(`select dedupe_key, status from scheduled_jobs where lead_id = $1 and kind = 'followup' and dedupe_key like '%:s1' order by seq`, [lead.leadId]),
    ).toEqual([
      { dedupe_key: `lead:${lead.leadId}:fu:1:s1`, status: 'scheduled' },
      { dedupe_key: `lead:${lead.leadId}:fu:2:s1`, status: 'scheduled' },
    ]);
    expect(replyEmails()).toHaveLength(1);
    expect(await replyReservations(db, lead.leadId)).toEqual([{ dedupe_key: `reply:${lead.leadId}:s0`, kind: 'reply_detected', status: 'sent' }]);
  });

  it('a stale caller never moves a real post-resume reply back to the ignored one (LEAST)', async () => {
    const db = getDb();
    const lead = await autoReplied();
    expect(await resumeFollowUps(rig.deps, await ownerScope(), lead.leadId)).toMatchObject({ type: 'resumed' });
    const realReplyAt = at(rig.clock.now(), 2 * HOUR);
    rig.clock.set(at(realReplyAt, HOUR));
    rig.hubspot.logLeadReply({ from: LEAD_EMAIL, at: realReplyAt });
    expect(await apply(rig, lead.leadId, { caller: 'refresh' })).toMatchObject({ markedReplied: true });

    const stale = await markReplied(rig.deps, { accountId: rig.accountId, leadId: lead.leadId, repliedAt: lead.replyAt, followUpStillScheduled: true });

    expect(stale).toEqual({ won: false, repliedAt: realReplyAt, cancelledJobs: 0, replyEmail: 'none' });
    expect((await signalRow(db, lead.leadId)).replied_at).toEqual(realReplyAt);
  });
});
