import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onAlert, type RaisedAlert } from '@/server/jobs/alert';
import { handleFailureCallback } from '@/server/jobs/failure';
import { runSweeper } from '@/server/jobs/sweeper';
import { FOLLOW_UP_FAILED_ACTIONS, followUpFailurePath, followUpReservationExpired, loadFollowUpNotes } from '@/server/services/followups';
import { NotificationKeys } from '@/server/services/notifications';
import { useTestDb as setUpTestDb } from '../db/harness';
import { interceptBefore } from '../db/intercept';
import {
  auditActions,
  createFollowUpRig,
  deliver,
  deliverWhenDue,
  followUpJobs,
  jobById,
  leadRow,
  notifications,
  onlyEmail,
  seedFollowUpLead,
  sent,
  type FollowUpLeadSeed,
  type FollowUpRig,
} from './support';

// The `followup` failure path (PLAN §8.3 step 6, D-15): a lead-page note (a code in audit_log), never
// an email; a follow-up email still on its way is resumed instead; and a failed last follow-up ends
// the stream, so the lead's status reaches "No reply from lead" (D-66 open point (2)).

const getDb = setUpTestDb();
let rig: FollowUpRig;
let alerts: RaisedAlert[];
let stopAlerts: () => void;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = await createFollowUpRig(getDb());
  alerts = [];
  stopAlerts = onAlert((alert) => alerts.push(alert));
});

afterEach(() => {
  stopAlerts();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fu(lead: FollowUpLeadSeed, n: 1 | 2): { id: string } {
  const job = lead.jobs[n - 1];
  if (job === undefined) throw new Error(`no fu${n} job`);
  return job;
}

/** HubSpot fails on every delivery (5 of them, the last is final): the failure path runs inline. */
async function failByHubSpotOutage(job: { id: string }): Promise<void> {
  rig.hubspot.injectFailure('getContact', { kind: 'server_error', times: 5 });
  for (let retried = 0; retried <= 4; retried += 1) {
    const result = retried === 0 ? await deliverWhenDue(rig, job) : await deliver(rig, job, { retried });
    expect(result.status).toBe(retried < 4 ? 500 : 200);
    rig.clock.advance({ seconds: 10 * 2 ** retried });
  }
}

describe('followup failure path', () => {
  it('a HubSpot outage on every delivery fails follow-up 1 with a lead-page note and no email; follow-up 2 still runs', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);

    await failByHubSpotOutage(fu(lead, 1));

    expect((await jobById(db, fu(lead, 1).id)).status).toBe('failed');
    expect(sent(rig)).toEqual([]);
    expect(alerts.map((a) => a.code)).toEqual(['job_failed']);
    expect(await auditActions(db, rig.accountId)).toEqual([{ action: FOLLOW_UP_FAILED_ACTIONS[1], meta: { leadId: lead.leadId, followupStream: 0 } }]);
    const notes = await loadFollowUpNotes(db, { accountId: rig.accountId, leadId: lead.leadId });
    expect(notes).toMatchObject([{ n: 1, followupStream: 0 }]);
    // Follow-up 2 is still coming: the stream is not over.
    expect((await leadRow(db, lead.leadId)).stop_reason).toBeNull();

    expect(await deliverWhenDue(rig, fu(lead, 2))).toMatchObject({ outcome: 'done' });
    expect(onlyEmail(rig, 'follow_up').subject).toBe('Follow-up 2 for Maya — your draft is ready');
  });

  it('a permanent send error on the last follow-up: the note, and the stream ends (max_followups)', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    expect(await deliverWhenDue(rig, fu(lead, 1))).toMatchObject({ outcome: 'done' });
    rig.fakes.mailer.injectFailure({ kind: 'permanent', code: 'validation_error' });

    expect(await deliverWhenDue(rig, fu(lead, 2))).toMatchObject({ status: 489, outcome: 'permanent', code: 'followup_notification_failed' });

    expect(sent(rig).map((m) => m.kind)).toEqual(['follow_up']);
    expect((await notifications(db, lead.leadId)).sort((a, b) => a.dedupe_key.localeCompare(b.dedupe_key))).toEqual([
      { dedupe_key: `notify:${lead.leadId}:fu1:s0`, kind: 'follow_up', status: 'sent' },
      { dedupe_key: `notify:${lead.leadId}:fu2:s0`, kind: 'follow_up', status: 'failed' },
    ]);
    expect(alerts.map((a) => a.code).sort()).toEqual(['job_failed', 'notification_send_failed']);
    expect((await auditActions(db, rig.accountId)).map((a) => a.action)).toEqual([FOLLOW_UP_FAILED_ACTIONS[2]]);
    expect(await leadRow(db, lead.leadId)).toMatchObject({ stop_reason: 'max_followups', fu2_notified_at: null });
  });

  it('the failure callback after a crash past the send resumes that email instead of leaving a note', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error', afterSend: true });
    expect(await deliverWhenDue(rig, fu(lead, 1))).toMatchObject({ status: 500 });
    const first = onlyEmail(rig, 'follow_up');
    const job = await jobById(db, fu(lead, 1).id);

    expect(await handleFailureCallback(rig.deps, { jobId: job.id, sourceMessageId: job.externalId ?? '' }, rig.registry)).toBe('won');

    expect(sent(rig)).toEqual([first]);
    expect(await notifications(db, lead.leadId)).toMatchObject([{ status: 'sent' }]);
    expect((await leadRow(db, lead.leadId)).fu1_notified_at).toEqual(rig.clock.now());
    expect(await auditActions(db, rig.accountId)).toEqual([]);
  });

  it('runs any number of times with one note', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig, { followUps: true });
    const job = await jobById(db, fu(lead, 2).id);
    await db.query(`update scheduled_jobs set status = 'done' where id = $1`, [fu(lead, 1).id]);

    for (let i = 0; i < 3; i += 1) await followUpFailurePath(rig.deps, job, { reason: 'sweeper', code: 'job_too_many_attempts' }, { notifications: rig.notifications });

    expect((await auditActions(db, rig.accountId)).map((a) => a.action)).toEqual([FOLLOW_UP_FAILED_ACTIONS[2]]);
    expect((await leadRow(db, lead.leadId)).stop_reason).toBe('max_followups');
    expect(sent(rig)).toEqual([]);
  });

  it('a stop that arrived meanwhile is the reason, not the failure: no note', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    await db.query(`update leads set dismissed_at = $2, stop_reason = 'dismissed' where id = $1`, [lead.leadId, rig.clock.now()]);

    await followUpFailurePath(rig.deps, await jobById(db, fu(lead, 1).id), { reason: 'failure_callback', code: 'qstash_retries_exhausted' }, { notifications: rig.notifications });

    expect(await auditActions(db, rig.accountId)).toEqual([]);
    expect((await leadRow(db, lead.leadId)).stop_reason).toBe('dismissed');
  });

  it('a job of an older stream, or of a test lead, leaves nothing', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    await db.query(`update leads set followup_stream = 1 where id = $1`, [lead.leadId]);

    await followUpFailurePath(rig.deps, await jobById(db, fu(lead, 1).id), { reason: 'permanent', code: 'x_failed' }, { notifications: rig.notifications });

    expect(await auditActions(db, rig.accountId)).toEqual([]);
    expect((await leadRow(db, lead.leadId)).stop_reason).toBeNull();
  });

  it('the sweeper failing a job claimed too often runs the same path', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    rig.clock.set(new Date((await jobById(db, fu(lead, 1).id)).runAt.getTime() + 31 * 60 * 1000));
    await db.query(`update scheduled_jobs set attempts = 6 where id = $1`, [fu(lead, 1).id]);

    await runSweeper(rig.deps, { jobRegistry: rig.registry, notificationRegistry: rig.notifications });

    expect((await jobById(db, fu(lead, 1).id)).status).toBe('failed');
    expect((await auditActions(db, rig.accountId)).map((a) => a.action)).toEqual([FOLLOW_UP_FAILED_ACTIONS[1]]);
    expect(await followUpJobs(db, lead.leadId)).toMatchObject([{ status: 'failed' }, { status: 'scheduled' }]);
  });
});

describe('followUpReservationExpired (for the sweeper\'s 23 h expiry)', () => {
  it('notes the follow-up that never went out and ends the stream when it was the last', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    await db.query(`update scheduled_jobs set status = 'done' where lead_id = $1`, [lead.leadId]);
    await db.query(`update leads set fu1_notified_at = $2 where id = $1`, [lead.leadId, rig.clock.now()]);

    await followUpReservationExpired(rig.deps, { leadId: lead.leadId, n: 2, followupStream: 0 });
    await followUpReservationExpired(rig.deps, { leadId: lead.leadId, n: 2, followupStream: 0 });

    expect((await auditActions(db, rig.accountId)).map((a) => a.action)).toEqual([FOLLOW_UP_FAILED_ACTIONS[2]]);
    expect((await leadRow(db, lead.leadId)).stop_reason).toBe('max_followups');
  });

  it('the sweeper expiring a follow-up email 23 h after it was reserved runs it (the registered expiry hook)', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    await db.query(`update scheduled_jobs set status = 'done' where lead_id = $1`, [lead.leadId]);
    await db.query(`update leads set fu1_notified_at = $2 where id = $1`, [lead.leadId, rig.clock.now()]);
    const key = NotificationKeys.followUp(lead.leadId, 2, 0);
    await db.query(
      `insert into notifications_sent (dedupe_key, account_id, lead_id, kind, status, first_reserved_at, reserved_at, send_attempts, sweeper_resumes, recipients_count)
       values ($1, $2, $3, 'follow_up', 'sending', $4, $4, 1, 3, 0)`,
      [key, rig.accountId, lead.leadId, rig.clock.now()],
    );
    rig.clock.advance({ hours: 23 });

    const summary = await runSweeper(rig.deps, { jobRegistry: rig.registry, notificationRegistry: rig.notifications });

    expect(summary).toMatchObject({ notificationsExpired: 1, errors: 0 });
    expect(alerts.map((alert) => alert.code)).toContain('notification_expired');
    expect((await notifications(db, lead.leadId)).find((row) => row.dedupe_key === key)?.status).toBe('failed');
    expect((await auditActions(db, rig.accountId)).map((a) => a.action)).toEqual([FOLLOW_UP_FAILED_ACTIONS[2]]);
    expect((await leadRow(db, lead.leadId)).stop_reason).toBe('max_followups');
    expect(sent(rig)).toHaveLength(0);
  });

  it('a follow-up that did go out (stamped) gets no note', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    await db.query(`update leads set fu1_notified_at = $2 where id = $1`, [lead.leadId, rig.clock.now()]);

    await followUpReservationExpired(rig.deps, { leadId: lead.leadId, n: 1, followupStream: 0 });

    expect(await auditActions(db, rig.accountId)).toEqual([]);
  });
});

describe('a follow-up email that fails after its job ended (the sweeper resumes it; D-73)', () => {
  /** fu1 went out; fu2's final delivery hits a Resend outage, so the job ends done with the email still `sending`. */
  async function fu2LeftSending(): Promise<FollowUpLeadSeed> {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    expect(await deliverWhenDue(rig, fu(lead, 1))).toMatchObject({ outcome: 'done' });
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error' });
    expect(await deliverWhenDue(rig, fu(lead, 2), { retried: 4 })).toEqual({ status: 200, outcome: 'done' });
    expect((await notifications(db, lead.leadId)).map((row) => row.status).sort()).toEqual(['sending', 'sent']);
    expect((await leadRow(db, lead.leadId)).stop_reason).toBeNull();
    return lead;
  }

  const fu2Status = async (lead: FollowUpLeadSeed): Promise<string | undefined> =>
    (await notifications(getDb(), lead.leadId)).find((row) => row.dedupe_key === NotificationKeys.followUp(lead.leadId, 2, 0))?.status;

  it('the owner pauses before the sweeper resumes it: the takeover fails its predicates and the stream ends with the stop (account_inactive), no note', async () => {
    const db = getDb();
    const lead = await fu2LeftSending();
    await db.query(`update accounts set paused_at = $2, processing_state = 'paused' where id = $1`, [rig.accountId, rig.clock.now()]);

    rig.clock.advance({ minutes: 11 });
    const summary = await runSweeper(rig.deps, { jobRegistry: rig.registry, notificationRegistry: rig.notifications });

    expect(summary).toMatchObject({ notificationsResumed: 0, errors: 0 });
    expect(await fu2Status(lead)).toBe('failed');
    expect(sent(rig).map((m) => m.kind)).toEqual(['follow_up']);
    expect(await auditActions(db, rig.accountId)).toEqual([]);
    expect(await leadRow(db, lead.leadId)).toMatchObject({ stop_reason: 'account_inactive', fu2_notified_at: null });
  });

  it('a permanent Resend error on the sweeper resume: the lead-page note and the stream ends (max_followups)', async () => {
    const db = getDb();
    const lead = await fu2LeftSending();
    rig.fakes.mailer.injectFailure({ kind: 'permanent', code: 'validation_error' });

    rig.clock.advance({ minutes: 11 });
    await runSweeper(rig.deps, { jobRegistry: rig.registry, notificationRegistry: rig.notifications });

    expect(await fu2Status(lead)).toBe('failed');
    expect(alerts.map((a) => a.code)).toContain('notification_send_failed');
    expect((await auditActions(db, rig.accountId)).map((a) => a.action)).toEqual([FOLLOW_UP_FAILED_ACTIONS[2]]);
    expect(await leadRow(db, lead.leadId)).toMatchObject({ stop_reason: 'max_followups', fu2_notified_at: null });
  });

  it('a resume that can no longer rebuild it (the draft is gone): the note and the stream ends', async () => {
    const db = getDb();
    const lead = await fu2LeftSending();
    await db.query(`delete from drafts where lead_id = $1 and kind = 'fu2'`, [lead.leadId]);

    rig.clock.advance({ minutes: 11 });
    await runSweeper(rig.deps, { jobRegistry: rig.registry, notificationRegistry: rig.notifications });

    expect(await fu2Status(lead)).toBe('failed');
    expect((await auditActions(db, rig.accountId)).map((a) => a.action)).toEqual([FOLLOW_UP_FAILED_ACTIONS[2]]);
    expect((await leadRow(db, lead.leadId)).stop_reason).toBe('max_followups');
  });

  it('the hook runs in the expiry\'s transaction: a database error rolls the expiry back and the next sweep records it all', async () => {
    const db = getDb();
    const lead = await fu2LeftSending();
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error', times: 1000 });
    const failing = interceptBefore(db, /insert into audit_log/, () => Promise.reject(new Error('db blip')));
    rig.clock.advance({ hours: 23 });

    const first = await runSweeper({ ...rig.deps, db: failing.db }, { jobRegistry: rig.registry, notificationRegistry: rig.notifications });

    expect(failing.fired()).toBe(1);
    expect(first).toMatchObject({ notificationsExpired: 0, errors: 1 });
    expect(await fu2Status(lead)).toBe('sending');
    expect(await auditActions(db, rig.accountId)).toEqual([]);
    expect((await leadRow(db, lead.leadId)).stop_reason).toBeNull();

    const second = await runSweeper(rig.deps, { jobRegistry: rig.registry, notificationRegistry: rig.notifications });

    expect(second).toMatchObject({ notificationsExpired: 1, errors: 0 });
    expect(await fu2Status(lead)).toBe('failed');
    expect((await auditActions(db, rig.accountId)).map((a) => a.action)).toEqual([FOLLOW_UP_FAILED_ACTIONS[2]]);
    expect((await leadRow(db, lead.leadId)).stop_reason).toBe('max_followups');
  });
});
