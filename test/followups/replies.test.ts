import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOwnerScopeForTest, type OwnerScope } from '@/server/services/auth/owner-scope';
import { resumeFollowUps } from '@/server/services/owner-controls';
import { applySignals } from '@/server/services/signals';
import { useTestDb as setUpTestDb } from '../db/harness';
import { interceptBefore } from '../db/intercept';
import {
  at,
  createFollowUpRig,
  DAY,
  deliver,
  deliverWhenDue,
  followUpJob,
  followUpJobs,
  HOUR,
  LEAD_EMAIL,
  leadRow,
  MINUTE,
  notifications,
  seedFollowUpLead,
  sent,
  type FollowUpLeadSeed,
  type FollowUpRig,
} from './support';

// Replies through the follow-up job (PLAN §9.5 steps 1 and 4, §9.6, D-08, D-42): a reply logged in
// HubSpot stops the follow-ups with exactly one reply_detected email and cancels the remaining job;
// a lost reply email is sent by the retry (step 1); an out-of-office reply, "Resume follow-ups",
// a follow-up sent, then a real reply → one more reply_detected email and the remaining job cancelled.

const getDb = setUpTestDb();
let rig: FollowUpRig;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = await createFollowUpRig(getDb());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function ownerScope(): Promise<OwnerScope> {
  const row = await getDb().one<{ owner_user_id: string }>(`select owner_user_id from accounts where id = $1`, [rig.accountId]);
  return createOwnerScopeForTest(rig.accountId, row.owner_user_id);
}

function fu(lead: FollowUpLeadSeed, n: 1 | 2): { id: string } {
  const job = lead.jobs[n - 1];
  if (job === undefined) throw new Error(`no fu${n} job`);
  return job;
}

describe('followup job: the lead replied', () => {
  it('a reply logged in HubSpot: one reply_detected email, no follow-up, follow-up 2 cancelled', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    rig.hubspot.logLeadReply({ from: LEAD_EMAIL, at: at(lead.t0, 5 * HOUR) });

    expect(await deliverWhenDue(rig, fu(lead, 1))).toEqual({ status: 200, outcome: 'done' });

    expect(sent(rig).map((m) => [m.kind, m.subject])).toEqual([['reply_detected', 'Maya replied — follow-ups stopped']]);
    expect(rig.fakes.llm.callsFor('followup')).toEqual([]);
    expect(await leadRow(db, lead.leadId)).toMatchObject({ replied_at: at(lead.t0, 5 * HOUR), stop_reason: 'replied', fu1_notified_at: null });
    expect(await notifications(db, lead.leadId)).toEqual([{ dedupe_key: `reply:${lead.leadId}:s0`, kind: 'reply_detected', status: 'sent' }]);
    expect(await followUpJobs(db, lead.leadId)).toMatchObject([
      { status: 'done', cancel_reason: null },
      { status: 'cancelled', cancel_reason: 'replied' },
    ]);

    // A late copy of either message changes nothing.
    expect(await deliver(rig, fu(lead, 1), { retried: 1 })).toEqual({ status: 200, outcome: 'already_finished' });
    expect(await deliverWhenDue(rig, fu(lead, 2))).toEqual({ status: 200, outcome: 'already_finished' });
    expect(sent(rig)).toHaveLength(1);
  });

  it('a reply email lost to a Resend error is sent by the retry (step 1), once, without reading HubSpot again', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    rig.hubspot.logLeadReply({ from: LEAD_EMAIL, at: at(lead.t0, 5 * HOUR) });
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error' });

    expect(await deliverWhenDue(rig, fu(lead, 1))).toMatchObject({ status: 500, outcome: 'transient', code: 'followup_reply_email_pending' });
    expect(sent(rig)).toEqual([]);
    expect(await notifications(db, lead.leadId)).toEqual([{ dedupe_key: `reply:${lead.leadId}:s0`, kind: 'reply_detected', status: 'sending' }]);
    const getContact = vi.spyOn(rig.hubspot, 'getContact');

    rig.clock.advance({ seconds: 10 });
    expect(await deliver(rig, fu(lead, 1), { retried: 1 })).toEqual({ status: 200, outcome: 'done' });

    expect(getContact).not.toHaveBeenCalled();
    expect(sent(rig).map((m) => m.kind)).toEqual(['reply_detected']);
    expect(await notifications(db, lead.leadId)).toEqual([{ dedupe_key: `reply:${lead.leadId}:s0`, kind: 'reply_detected', status: 'sent' }]);
  });

  it('a crash after the reply email went out: the retry finds it out (409) and sends nothing more', async () => {
    const lead = await seedFollowUpLead(rig);
    rig.hubspot.logLeadReply({ from: LEAD_EMAIL, at: at(lead.t0, 5 * HOUR) });
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error', afterSend: true });

    expect(await deliverWhenDue(rig, fu(lead, 1))).toMatchObject({ status: 500 });
    rig.clock.advance({ seconds: 10 });
    expect(await deliver(rig, fu(lead, 1), { retried: 1 })).toEqual({ status: 200, outcome: 'done' });

    expect(sent(rig).map((m) => m.kind)).toEqual(['reply_detected']);
  });
});

describe('followup job: out-of-office → Resume follow-ups → a real reply (D-42)', () => {
  async function outOfOfficeThenResume() {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    // An auto-reply an hour after the first email; follow-up 1 finds it.
    rig.hubspot.logLeadReply({ from: LEAD_EMAIL, at: at(lead.t0, HOUR) });
    expect(await deliverWhenDue(rig, fu(lead, 1))).toMatchObject({ outcome: 'done' });
    expect(sent(rig).map((m) => m.kind)).toEqual(['reply_detected']);

    // The owner sees it was an out-of-office and resumes follow-ups an hour later.
    rig.clock.advance({ hours: 1 });
    const resumed = await resumeFollowUps(rig.deps, await ownerScope(), lead.leadId);
    expect(resumed).toMatchObject({ type: 'resumed', followupStream: 1 });
    expect(await leadRow(db, lead.leadId)).toMatchObject({ replied_at: null, stop_reason: null, followup_stream: 1 });
    return { lead, fu1: await followUpJob(db, lead.leadId, 1, 1), fu2: await followUpJob(db, lead.leadId, 2, 1) };
  }

  it('the resumed follow-up 1 goes out (the auto-reply is ignored); a real reply then stops follow-up 2 with one reply_detected', async () => {
    const db = getDb();
    const { lead, fu1, fu2 } = await outOfOfficeThenResume();

    expect(await deliverWhenDue(rig, fu1)).toEqual({ status: 200, outcome: 'done' });
    expect(sent(rig).map((m) => m.kind)).toEqual(['reply_detected', 'follow_up']);
    expect(await notifications(db, lead.leadId)).toContainEqual({ dedupe_key: `notify:${lead.leadId}:fu1:s1`, kind: 'follow_up', status: 'sent' });

    // The real reply, a day after follow-up 1; the lead page's refresh finds it first.
    rig.clock.advance({ days: 1 });
    rig.hubspot.logLeadReply({ from: LEAD_EMAIL, at: at(rig.clock.now(), -10 * MINUTE) });
    const refreshed = await applySignals(rig.deps, lead.leadId, { caller: 'refresh', accountId: rig.accountId, sleep: rig.sleep, notifications: rig.notifications });
    expect(refreshed).toMatchObject({ replied: true, markedReplied: true, replyEmail: 'sent' });

    expect(sent(rig).map((m) => m.kind)).toEqual(['reply_detected', 'follow_up', 'reply_detected']);
    expect(await notifications(db, lead.leadId)).toContainEqual({ dedupe_key: `reply:${lead.leadId}:s1`, kind: 'reply_detected', status: 'sent' });
    expect((await followUpJob(db, lead.leadId, 2, 1)).status).toBe('cancelled');
    expect((await followUpJob(db, lead.leadId, 2, 1)).cancelReason).toBe('replied');

    // Follow-up 2's message still arrives: the job is cancelled, nothing more is sent.
    expect(await deliverWhenDue(rig, fu2)).toEqual({ status: 200, outcome: 'already_finished' });
    expect(sent(rig)).toHaveLength(3);
  });

  it('a real reply before the resumed follow-up 1: that job records it, one reply_detected, follow-up 2 cancelled', async () => {
    const db = getDb();
    const { lead, fu1 } = await outOfOfficeThenResume();
    rig.clock.advance({ hours: 2 });
    rig.hubspot.logLeadReply({ from: LEAD_EMAIL, at: at(rig.clock.now(), -5 * MINUTE) });

    expect(await deliverWhenDue(rig, fu1)).toEqual({ status: 200, outcome: 'done' });

    expect(sent(rig).map((m) => m.kind)).toEqual(['reply_detected', 'reply_detected']);
    expect(rig.fakes.llm.callsFor('followup')).toEqual([]);
    expect((await notifications(db, lead.leadId)).filter((n) => n.kind === 'reply_detected')).toEqual([
      { dedupe_key: `reply:${lead.leadId}:s0`, kind: 'reply_detected', status: 'sent' },
      { dedupe_key: `reply:${lead.leadId}:s1`, kind: 'reply_detected', status: 'sent' },
    ]);
    expect(await followUpJobs(db, lead.leadId)).toMatchObject([
      { status: 'done' },
      { status: 'cancelled', cancel_reason: 'replied' },
      { status: 'done' },
      { status: 'cancelled', cancel_reason: 'replied' },
    ]);
    expect((await leadRow(db, lead.leadId)).stop_reason).toBe('replied');
  });

  it('the resumed follow-up 2 finds the real reply after follow-up 1 went out: one reply_detected and nothing else', async () => {
    const { lead, fu1, fu2 } = await outOfOfficeThenResume();
    expect(await deliverWhenDue(rig, fu1)).toMatchObject({ outcome: 'done' });
    rig.hubspot.logLeadReply({ from: LEAD_EMAIL, at: at(rig.clock.now(), DAY) });

    expect(await deliverWhenDue(rig, fu2)).toEqual({ status: 200, outcome: 'done' });

    expect(sent(rig).map((m) => m.kind)).toEqual(['reply_detected', 'follow_up', 'reply_detected']);
    expect((await leadRow(getDb(), lead.leadId)).fu2_notified_at).toBeNull();
  });
});

describe('followup job: a reply and a resume while follow-up 1 is being drafted (D-73)', () => {
  it('the cancelled old-stream job never reserves: follow-up 1 is emailed once, by the new stream (sequential replay)', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    const scope = await ownerScope();
    // Between follow-up 1's stored draft and its reservation: the lead page's refresh finds an
    // out-of-office reply (cancelling the running job) and the owner resumes follow-ups at once.
    const racing = interceptBefore(db, /d\.flags as draft_flags/, async (handle) => {
      rig.hubspot.logLeadReply({ from: LEAD_EMAIL, at: at(lead.t0, HOUR) });
      const deps = { ...rig.deps, db: handle };
      const refreshed = await applySignals(deps, lead.leadId, { caller: 'refresh', accountId: rig.accountId, sleep: rig.sleep, notifications: rig.notifications });
      expect(refreshed).toMatchObject({ markedReplied: true, replyEmail: 'sent' });
      expect(await resumeFollowUps(deps, scope, lead.leadId)).toMatchObject({ type: 'resumed', followupStream: 1, scheduled: [{ n: 1 }, { n: 2 }] });
    });

    expect(await deliverWhenDue(rig, fu(lead, 1), { deps: { ...rig.deps, db: racing.db } })).toMatchObject({ outcome: 'lease_lost' });

    expect(racing.fired()).toBe(1);
    expect(sent(rig).map((m) => m.kind)).toEqual(['reply_detected']);
    expect((await notifications(db, lead.leadId)).filter((n) => n.kind !== 'reply_detected')).toEqual([]);

    expect(await deliverWhenDue(rig, await followUpJob(db, lead.leadId, 1, 1))).toEqual({ status: 200, outcome: 'done' });
    expect(sent(rig).map((m) => m.kind)).toEqual(['reply_detected', 'follow_up']);
    expect((await notifications(db, lead.leadId)).filter((n) => n.kind === 'follow_up')).toEqual([
      { dedupe_key: `notify:${lead.leadId}:fu1:s1`, kind: 'follow_up', status: 'sent' },
    ]);
  });

  it('a follow-up already emailed (an older stream\'s email the sweeper finished) is never sent again by the new stream\'s job', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    rig.hubspot.logLeadReply({ from: LEAD_EMAIL, at: at(lead.t0, HOUR) });
    expect(await deliverWhenDue(rig, fu(lead, 1))).toMatchObject({ outcome: 'done' });
    rig.clock.advance({ hours: 1 });
    expect(await resumeFollowUps(rig.deps, await ownerScope(), lead.leadId)).toMatchObject({ type: 'resumed', followupStream: 1 });
    // Follow-up 1 went out meanwhile (stamped by an older stream's `sent` transaction).
    await db.query(`update leads set fu1_notified_at = $2 where id = $1`, [lead.leadId, rig.clock.now()]);
    const getContact = vi.spyOn(rig.hubspot, 'getContact');

    expect(await deliverWhenDue(rig, await followUpJob(db, lead.leadId, 1, 1))).toEqual({ status: 200, outcome: 'done' });

    expect(getContact).not.toHaveBeenCalled();
    expect(sent(rig).map((m) => m.kind)).toEqual(['reply_detected']);
    expect((await notifications(db, lead.leadId)).filter((n) => n.kind === 'follow_up')).toEqual([]);
  });
});
