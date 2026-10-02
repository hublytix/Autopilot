import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyProcessingStateInTx } from '@/server/services/accounts/apply-processing-state';
import { createOwnerScopeForTest, type OwnerScope } from '@/server/services/auth/owner-scope';
import { endFollowUpInTx } from '@/server/services/followups';
import { followUpDedupeKey } from '@/server/services/followups/schedule';
import { NotificationKeys } from '@/server/services/notifications';
import { dismissLeadForOwner, markRealLead, resumeFollowUps } from '@/server/services/owner-controls';
import { applySignals, markReplied, markRepliedInTx } from '@/server/services/signals';
import { runSweeper } from '@/server/jobs/sweeper';
import { useTestDb as setUpTestDb } from '../db/harness';
import { forbidNetworkInTransactions, interceptBefore, recordStatements } from '../db/intercept';
import { seedNewLead } from '../leads/support';
import {
  at,
  createFollowUpRig,
  deliverWhenDue,
  followUpJob,
  followUpJobs,
  HOUR,
  LEAD_EMAIL,
  leadRow,
  notifications,
  seedFollowUpLead,
  sent,
  type FollowUpLeadSeed,
  type FollowUpRig,
} from './support';

// The transactions behind the M5 controls and the follow-up job (PLAN §12 "Locking and race
// semantics", CLAUDE.md "No transaction is held across network I/O", D-73): each is atomic, holds no
// network call open, keeps its compare-and-set, takes row locks leads before scheduled_jobs, and
// writes only while the job is still its own. PGlite serialises transactions, so races are sequential
// replays (interceptBefore) and lock order is the order of the statements (recordStatements).

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

/** A lead whose follow-up 1 found an out-of-office reply (reply_detected sent, follow-up 2 cancelled). */
async function repliedLead(): Promise<FollowUpLeadSeed> {
  const lead = await seedFollowUpLead(rig);
  rig.hubspot.logLeadReply({ from: LEAD_EMAIL, at: at(lead.t0, HOUR) });
  expect(await deliverWhenDue(rig, fu(lead, 1))).toMatchObject({ outcome: 'done' });
  rig.clock.advance({ hours: 1 });
  return lead;
}

describe('no network call inside a transaction', () => {
  it('markReplied: the QStash cancels and the reply email run after its commit', async () => {
    const lead = await seedFollowUpLead(rig);
    rig.clock.set(at(lead.t0, 2 * 24 * HOUR));
    rig.hubspot.logLeadReply({ from: LEAD_EMAIL, at: at(lead.t0, HOUR) });
    const guarded = forbidNetworkInTransactions(rig.deps);

    const result = await applySignals(guarded.deps, lead.leadId, { caller: 'refresh', sleep: rig.sleep, notifications: rig.notifications });

    expect(result).toMatchObject({ markedReplied: true, replyEmail: 'sent' });
    expect(guarded.calls).toEqual(expect.arrayContaining(['scheduler.cancel', 'mailer.send']));
  });

  it('"Resume follow-ups": the old cancels and the new jobs are published after its commit', async () => {
    const lead = await repliedLead();
    const guarded = forbidNetworkInTransactions(rig.deps);

    expect(await resumeFollowUps(guarded.deps, await ownerScope(), lead.leadId)).toMatchObject({ type: 'resumed' });

    expect(guarded.calls).toContain('scheduler.publish');
  });

  it('dismiss: the QStash cancels run after its commit', async () => {
    const lead = await seedFollowUpLead(rig);
    const guarded = forbidNetworkInTransactions(rig.deps);

    expect(await dismissLeadForOwner(guarded.deps, await ownerScope(), lead.leadId)).toMatchObject({ type: 'dismissed' });

    expect(guarded.calls).toContain('scheduler.cancel');
  });

  it('"This is a real lead": the lead_process job is published after its commit', async () => {
    const db = getDb();
    const leadId = await seedNewLead(db, { accountId: rig.accountId, now: rig.clock.now() });
    await db.query(`update leads set classification = 'spam', classified_at = $2, processing_state = 'filtered' where id = $1`, [leadId, rig.clock.now()]);
    const guarded = forbidNetworkInTransactions(rig.deps);

    expect(await markRealLead(guarded.deps, await ownerScope(), leadId)).toMatchObject({ type: 'queued', processRev: 1 });

    expect(guarded.calls).toContain('scheduler.publish');
  });

  it('a follow-up job that stops for a lead stop: the read before, the cancels after its transaction', async () => {
    const lead = await seedFollowUpLead(rig);
    rig.hubspot.optOut(lead.contactId);
    const guarded = forbidNetworkInTransactions(rig.deps);

    expect(await deliverWhenDue(rig, fu(lead, 1), { deps: guarded.deps })).toMatchObject({ outcome: 'skipped' });

    expect((await leadRow(getDb(), lead.leadId)).stop_reason).toBe('opted_out');
    expect(guarded.calls).toEqual(expect.arrayContaining(['hubspot.getContact', 'scheduler.cancel']));
  });

  it('a follow-up job that sends: the draft, the email and the next publish all outside its transactions', async () => {
    const lead = await seedFollowUpLead(rig);
    const guarded = forbidNetworkInTransactions(rig.deps);

    expect(await deliverWhenDue(rig, fu(lead, 1), { deps: guarded.deps })).toMatchObject({ outcome: 'done' });

    expect(guarded.calls).toEqual(expect.arrayContaining(['hubspot.getContact', 'llm.draftFollowUp', 'mailer.send']));
  });

  it('the sweeper\'s expiry of a follow-up email: the stop is written in its transaction, the cancels after', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    await db.query(`update scheduled_jobs set status = 'done' where id = $1`, [fu(lead, 1).id]);
    await db.query(
      `insert into notifications_sent (dedupe_key, account_id, lead_id, kind, status, first_reserved_at, reserved_at, send_attempts, sweeper_resumes, recipients_count)
       values ($1, $2, $3, 'follow_up', 'sending', $4, $4, 1, 3, 0)`,
      [NotificationKeys.followUp(lead.leadId, 1, 0), rig.accountId, lead.leadId, rig.clock.now()],
    );
    // An earlier read stored a lead stop: the expiry's hook cancels follow-up 2 with it.
    await db.query(`update leads set stop_reason = 'opted_out' where id = $1`, [lead.leadId]);
    rig.clock.advance({ hours: 23 });
    const guarded = forbidNetworkInTransactions(rig.deps);

    expect(await runSweeper(guarded.deps, { jobRegistry: rig.registry, notificationRegistry: rig.notifications })).toMatchObject({ notificationsExpired: 1, errors: 0 });

    expect(await followUpJobs(db, lead.leadId)).toMatchObject([{ status: 'done' }, { status: 'cancelled', cancel_reason: 'opted_out' }]);
    expect(guarded.calls).toContain('scheduler.cancel');
  });
});

describe('atomic and compare-and-set (sequential replays)', () => {
  it('markReplied is one transaction: a failure at its reservation leaves no reply recorded and the jobs scheduled', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    const failing = interceptBefore(db, /insert into notifications_sent/, () => Promise.reject(new Error('db blip')));

    await expect(
      markReplied({ ...rig.deps, db: failing.db }, { accountId: rig.accountId, leadId: lead.leadId, repliedAt: at(lead.t0, HOUR), followUpStillScheduled: true }, { notifications: rig.notifications }),
    ).rejects.toThrow('db blip');

    expect(failing.fired()).toBe(1);
    expect(await leadRow(db, lead.leadId)).toMatchObject({ replied_at: null, stop_reason: null });
    expect(await followUpJobs(db, lead.leadId)).toMatchObject([{ status: 'scheduled' }, { status: 'scheduled' }]);
    expect(rig.fakes.scheduler.cancelled).toEqual([]);
    expect(sent(rig)).toEqual([]);
  });

  it('"Resume follow-ups": a second resume committing just before the UPDATE leaves one stream bump', async () => {
    const db = getDb();
    const lead = await repliedLead();
    const scope = await ownerScope();
    const competing = interceptBefore(db, /update leads\s+set replied_at = null/, async (handle) => {
      expect(await resumeFollowUps({ ...rig.deps, db: handle }, scope, lead.leadId)).toMatchObject({ type: 'resumed', followupStream: 1 });
    });

    expect(await resumeFollowUps({ ...rig.deps, db: competing.db }, scope, lead.leadId)).toEqual({ type: 'refused', reason: 'not_replied' });

    expect(competing.fired()).toBe(1);
    expect((await leadRow(db, lead.leadId)).followup_stream).toBe(1);
    expect((await followUpJobs(db, lead.leadId)).filter((job) => job.dedupe_key.endsWith(':s1'))).toHaveLength(2);
    expect((await followUpJobs(db, lead.leadId)).filter((job) => job.dedupe_key.endsWith(':s2'))).toEqual([]);
  });

  it('"Resume follow-ups": a reply recorded just before the UPDATE (a new stream already) makes it change nothing', async () => {
    const db = getDb();
    const lead = await repliedLead();
    const scope = await ownerScope();
    // Between the read and the UPDATE: another resume and then a new reply bump the stream and set the reply again.
    const competing = interceptBefore(db, /update leads\s+set replied_at = null/, async (handle) => {
      await resumeFollowUps({ ...rig.deps, db: handle }, scope, lead.leadId);
      rig.clock.advance({ minutes: 10 });
      await handle.tx((tx) =>
        markRepliedInTx(tx, { accountId: rig.accountId, leadId: lead.leadId, repliedAt: at(rig.clock.now(), -5 * 60_000), followUpStillScheduled: false, now: rig.clock.now() }),
      );
    });

    expect(await resumeFollowUps({ ...rig.deps, db: competing.db }, scope, lead.leadId)).toEqual({ type: 'refused', reason: 'not_replied' });

    expect(await leadRow(db, lead.leadId)).toMatchObject({ followup_stream: 1, stop_reason: 'replied' });
  });

  it('"This is a real lead": the lead leaving `filtered` at the same revision just before the UPDATE makes it change nothing', async () => {
    const db = getDb();
    const leadId = await seedNewLead(db, { accountId: rig.accountId, now: rig.clock.now() });
    await db.query(`update leads set classification = 'spam', classified_at = $2, processing_state = 'filtered' where id = $1`, [leadId, rig.clock.now()]);
    const competing = interceptBefore(db, /update leads set process_rev = process_rev \+ 1/, async (handle) => {
      await handle.query(`update leads set processing_state = 'skipped' where id = $1`, [leadId]);
    });

    expect(await markRealLead({ ...rig.deps, db: competing.db }, await ownerScope(), leadId)).toEqual({ type: 'refused', reason: 'not_filtered' });

    expect(await db.query(`select id from scheduled_jobs where lead_id = $1 and kind = 'lead_process'`, [leadId])).toEqual([]);
    expect(await db.one(`select process_rev, processing_state from leads where id = $1`, [leadId])).toEqual({ process_rev: 0, processing_state: 'skipped' });
  });

  it('"This is a real lead": a competing override just before the UPDATE leaves one lead_process job', async () => {
    const db = getDb();
    const leadId = await seedNewLead(db, { accountId: rig.accountId, now: rig.clock.now() });
    await db.query(`update leads set classification = 'spam', classified_at = $2, processing_state = 'filtered' where id = $1`, [leadId, rig.clock.now()]);
    const scope = await ownerScope();
    const competing = interceptBefore(db, /update leads set process_rev = process_rev \+ 1/, async (handle) => {
      expect(await markRealLead({ ...rig.deps, db: handle }, scope, leadId)).toMatchObject({ type: 'queued', processRev: 1 });
    });

    expect(await markRealLead({ ...rig.deps, db: competing.db }, scope, leadId)).toEqual({ type: 'refused', reason: 'not_filtered' });

    expect(await db.query(`select dedupe_key from scheduled_jobs where lead_id = $1 and kind = 'lead_process'`, [leadId])).toEqual([
      { dedupe_key: `lead:${leadId}:process:r1` },
    ]);
  });
});

describe('the stream end and job ownership', () => {
  it('endFollowUpInTx records no end while a follow-up email of the stream is still being sent', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    await db.query(`update scheduled_jobs set status = 'done' where lead_id = $1`, [lead.leadId]);
    await db.query(
      `insert into notifications_sent (dedupe_key, account_id, lead_id, kind, status, first_reserved_at, reserved_at, send_attempts, sweeper_resumes, recipients_count)
       values ($1, $2, $3, 'follow_up', 'sending', $4, $4, 1, 0, 0)`,
      [NotificationKeys.followUp(lead.leadId, 2, 0), rig.accountId, lead.leadId, rig.clock.now()],
    );
    const input = { accountId: rig.accountId, leadId: lead.leadId, followupStream: 0, jobId: null, stop: null, now: rig.clock.now() };

    expect(await db.tx((tx) => endFollowUpInTx(tx, input))).toMatchObject({ stored: null });
    expect((await leadRow(db, lead.leadId)).stop_reason).toBeNull();

    await db.query(`update notifications_sent set status = 'failed' where lead_id = $1`, [lead.leadId]);
    expect(await db.tx((tx) => endFollowUpInTx(tx, input))).toMatchObject({ stored: 'max_followups' });
  });

  it('a job cancelled while it read HubSpot writes nothing for the stop it then finds (lease lost)', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    rig.hubspot.optOut(lead.contactId);
    // The job is cancelled (an account-wide cancel, say) after its claim, while it reads the contact.
    const cancelling = interceptBefore(db, /update leads set send_confirmed_at = least/, async (handle) => {
      await handle.query(`update scheduled_jobs set status = 'cancelled', cancel_reason = 'disconnected', lease_until = null where id = $1`, [fu(lead, 1).id]);
    });

    expect(await deliverWhenDue(rig, fu(lead, 1), { deps: { ...rig.deps, db: cancelling.db } })).toMatchObject({ outcome: 'lease_lost' });

    expect(cancelling.fired()).toBe(1);
    expect((await leadRow(db, lead.leadId)).stop_reason).toBeNull();
    expect((await followUpJob(db, lead.leadId, 2)).status).toBe('scheduled');
    expect(await notifications(db, lead.leadId)).toEqual([]);
  });
});

describe('row lock order: leads before scheduled_jobs (docs/ARCHITECTURE.md)', () => {
  it('a job\'s ownership check locks its lead before its own row', async () => {
    const lead = await seedFollowUpLead(rig);
    rig.hubspot.optOut(lead.contactId);
    const recorded = recordStatements(getDb());

    expect(await deliverWhenDue(rig, fu(lead, 1), { deps: { ...rig.deps, db: recorded.db } })).toMatchObject({ outcome: 'skipped' });

    const jobLocks = recorded.statements.flatMap((sql, i) => (/from scheduled_jobs where id = \$1 and attempt_id = \$2 and status = 'running' for update/.test(sql) ? [i] : []));
    expect(jobLocks.length).toBeGreaterThan(0);
    for (const i of jobLocks) expect(recorded.statements[i - 1]).toMatch(/select 1 from leads where id = \$1 for no key update/);
    const leadWrite = recorded.statements.findIndex((sql) => /update leads set stop_reason = \$3/.test(sql));
    const siblingCancel = recorded.statements.findIndex((sql, i) => i > leadWrite && /update scheduled_jobs\s+set status = 'cancelled'/.test(sql));
    expect(leadWrite).toBeGreaterThan(jobLocks[0] ?? -1);
    expect(siblingCancel).toBeGreaterThan(leadWrite);
  });

  it('"Resume follow-ups" locks the lead row before it cancels or inserts jobs', async () => {
    const lead = await repliedLead();
    const recorded = recordStatements(getDb());

    expect(await resumeFollowUps({ ...rig.deps, db: recorded.db }, await ownerScope(), lead.leadId)).toMatchObject({ type: 'resumed' });

    const leadLock = recorded.statements.findIndex((sql) => /from leads l[\s\S]*for no key update of l/.test(sql));
    const jobWrite = recorded.statements.findIndex((sql) => /update scheduled_jobs|insert into scheduled_jobs/.test(sql));
    expect(leadLock).toBeGreaterThanOrEqual(0);
    expect(jobWrite).toBeGreaterThan(leadLock);
  });

  it('the revoke transition writes the leads\' stream end before it cancels their jobs', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    await db.query(`update hubspot_connections set status = 'revoked', status_changed_at = $2 where account_id = $1`, [rig.accountId, rig.clock.now()]);
    const recorded = recordStatements(db);

    const applied = await recorded.db.tx((tx) => applyProcessingStateInTx(tx, rig.clock.now(), rig.accountId));

    expect(applied).toMatchObject({ next: 'revoked', transitioned: true });
    const leadWrite = recorded.statements.findIndex((sql) => /update leads set stop_reason = 'account_inactive'/.test(sql));
    const jobCancel = recorded.statements.findIndex((sql) => /update scheduled_jobs\s+set status = 'cancelled'/.test(sql));
    expect(leadWrite).toBeGreaterThanOrEqual(0);
    expect(jobCancel).toBeGreaterThan(leadWrite);
    expect((await leadRow(db, lead.leadId)).stop_reason).toBe('account_inactive');
    expect(await followUpJobs(db, lead.leadId)).toMatchObject([{ status: 'cancelled', cancel_reason: 'revoked' }, { status: 'cancelled', cancel_reason: 'revoked' }]);
    expect(followUpDedupeKey(lead.leadId, 1, 0)).toBe((await followUpJobs(db, lead.leadId))[0]?.dedupe_key);
  });
});
