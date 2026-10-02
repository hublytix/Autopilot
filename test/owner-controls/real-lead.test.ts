import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getJob } from '@/server/jobs/rows';
import { leadProcessDedupeKey } from '@/server/services/leads/process';
import { markRealLead, pauseAll } from '@/server/services/owner-controls';
import { useTestDb as setUpTestDb } from '../db/harness';
import { deliver, notifications } from '../leads/support';
import { createLeadsRig, leadJobs, seedFilteredLead, seedNotifiedLead, seedOtherAccount, seedOwnedAccount, type LeadsRig } from './support';

// "This is a real lead" (D-42, PLAN §6.2, §9.6): a filtered lead gets process_rev + 1, the override
// and a new lead_process job keyed :r{rev} in one transaction; the job then drafts and emails it once.

const getDb = setUpTestDb();
let rig: LeadsRig;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = createLeadsRig(getDb());
});

afterEach(() => {
  vi.useRealTimers();
});

async function lead(leadId: string) {
  return getDb().one<{ processing_state: string; process_rev: number; classification: string; classification_override: string | null; first_notified_at: Date | null }>(
    `select processing_state, process_rev, classification, classification_override, first_notified_at from leads where id = $1`,
    [leadId],
  );
}

describe('markRealLead', () => {
  it('bumps process_rev, overrides the class and queues lead_process r1 in one go, published after commit', async () => {
    const owned = await seedOwnedAccount(getDb(), { now: rig.clock.now() });
    const leadId = await seedFilteredLead(getDb(), { accountId: owned.accountId, now: rig.clock.now() });

    expect(await markRealLead(rig.deps, owned.scope, leadId)).toEqual({ type: 'queued', processRev: 1 });

    expect(await lead(leadId)).toMatchObject({ processing_state: 'new', process_rev: 1, classification: 'spam', classification_override: 'lead' });
    const jobs = await leadJobs(getDb(), leadId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: 'lead_process', dedupe_key: leadProcessDedupeKey(leadId, 1), status: 'scheduled', payload: { processRev: 1 } });
    expect(jobs[0]?.external_id).not.toBeNull();
  });

  it('re-runs lead_process once: a second tap changes nothing, and the job drafts and emails the lead under r1', async () => {
    const db = getDb();
    const owned = await seedOwnedAccount(db, { now: rig.clock.now() });
    const leadId = await seedFilteredLead(db, { accountId: owned.accountId, now: rig.clock.now() });
    await markRealLead(rig.deps, owned.scope, leadId);

    expect(await markRealLead(rig.deps, owned.scope, leadId)).toEqual({ type: 'refused', reason: 'not_filtered' });
    const jobs = await db.query<{ id: string }>(`select id from scheduled_jobs where lead_id = $1 and kind = 'lead_process'`, [leadId]);
    expect(jobs).toHaveLength(1);

    rig.clock.advance({ seconds: 5 });
    const job = await getJob(db, jobs[0]?.id ?? '');
    if (job === null) throw new Error('job missing');
    await deliver(rig, job);

    expect(await lead(leadId)).toMatchObject({ processing_state: 'notified', process_rev: 1 });
    expect(await notifications(db, leadId)).toEqual([{ dedupe_key: `notify:${leadId}:initial:r1`, kind: 'new_lead', status: 'sent' }]);
    expect(rig.fakes.mailer.sent.filter((mail) => mail.kind === 'new_lead')).toHaveLength(1);
    expect((await leadJobs(db, leadId)).filter((row) => row.kind === 'followup')).toHaveLength(2);

    // Notified now: a later tap is refused, and no second job or email follows.
    expect(await markRealLead(rig.deps, owned.scope, leadId)).toEqual({ type: 'refused', reason: 'not_filtered' });
    expect(await db.query(`select id from scheduled_jobs where lead_id = $1 and kind = 'lead_process'`, [leadId])).toHaveLength(1);
  });

  it('refuses a lead that is not filtered, a test lead, a dismissed or privacy-deleted one, and one whose content is gone', async () => {
    const db = getDb();
    const owned = await seedOwnedAccount(db, { now: rig.clock.now() });
    const now = rig.clock.now();
    const notified = await seedNotifiedLead(rig, { accountId: owned.accountId, firstNotifiedAt: now });
    const test = await seedFilteredLead(db, { accountId: owned.accountId, now });
    await db.query(`update leads set is_test = true, stop_reason = 'test_lead' where id = $1`, [test]);
    const dismissed = await seedFilteredLead(db, { accountId: owned.accountId, now });
    await db.query(`update leads set dismissed_at = $2, stop_reason = 'dismissed' where id = $1`, [dismissed, now]);
    const deleted = await seedFilteredLead(db, { accountId: owned.accountId, now });
    await db.query(`update leads set stop_reason = 'privacy_deletion' where id = $1`, [deleted]);
    await db.query(`delete from lead_messages where lead_id = $1`, [deleted]);
    const purged = await seedFilteredLead(db, { accountId: owned.accountId, now });
    await db.query(`delete from lead_messages where lead_id = $1`, [purged]);

    expect(await markRealLead(rig.deps, owned.scope, notified.leadId)).toEqual({ type: 'refused', reason: 'not_filtered' });
    expect(await markRealLead(rig.deps, owned.scope, test)).toEqual({ type: 'refused', reason: 'test_lead' });
    expect(await markRealLead(rig.deps, owned.scope, dismissed)).toEqual({ type: 'refused', reason: 'dismissed' });
    expect(await markRealLead(rig.deps, owned.scope, deleted)).toEqual({ type: 'refused', reason: 'privacy_deleted' });
    expect(await markRealLead(rig.deps, owned.scope, purged)).toEqual({ type: 'refused', reason: 'content_gone' });
    const revs = await db.query<{ process_rev: number }>(`select process_rev from leads where account_id = $1`, [owned.accountId]);
    expect(revs.every((row) => row.process_rev === 0)).toBe(true);
    expect(await db.query(`select id from scheduled_jobs where kind = 'lead_process'`)).toEqual([]);
  });

  it('refuses while the account is paused (lead_process would only skip it)', async () => {
    const owned = await seedOwnedAccount(getDb(), { now: rig.clock.now() });
    const leadId = await seedFilteredLead(getDb(), { accountId: owned.accountId, now: rig.clock.now() });
    await pauseAll(rig.deps, owned.scope);

    expect(await markRealLead(rig.deps, owned.scope, leadId)).toEqual({ type: 'refused', reason: 'account_not_active' });
    expect(await lead(leadId)).toMatchObject({ processing_state: 'filtered', process_rev: 0, classification_override: null });
  });

  it("never touches another account's lead", async () => {
    const db = getDb();
    const mine = await seedOwnedAccount(db, { now: rig.clock.now() });
    const other = await seedOtherAccount(db, rig.clock.now());
    const theirs = await seedFilteredLead(db, { accountId: other.accountId, now: rig.clock.now() });

    expect(await markRealLead(rig.deps, mine.scope, theirs)).toEqual({ type: 'refused', reason: 'not_found' });
    expect(await lead(theirs)).toMatchObject({ processing_state: 'filtered', process_rev: 0 });
    expect(await markRealLead(rig.deps, other.scope, theirs)).toEqual({ type: 'queued', processRev: 1 });
  });
});
