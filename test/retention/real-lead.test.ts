import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markRealLead } from '@/server/services/owner-controls';
import { useTestDb as setUpTestDb } from '../db/harness';
import { createLeadsRig, seedFilteredLead, seedOwnedAccount, type LeadsRig } from '../owner-controls/support';

// "This is a real lead" never re-drafts content past its purge time (D-49, D-77): the lead page no
// longer offers it, and the service refuses it too, before the purge has deleted the row.

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

describe('markRealLead and the purge time', () => {
  it('refuses a filtered lead whose message is past purge_at but not deleted yet', async () => {
    const db = getDb();
    const owned = await seedOwnedAccount(db, { now: rig.clock.now() });
    const leadId = await seedFilteredLead(db, { accountId: owned.accountId, now: rig.clock.now() });
    await db.query(`update lead_messages set purge_at = $2 where lead_id = $1`, [leadId, rig.clock.now()]);

    expect(await markRealLead(rig.deps, owned.scope, leadId)).toEqual({ type: 'refused', reason: 'content_gone' });
    expect(await db.one(`select processing_state, process_rev from leads where id = $1`, [leadId])).toEqual({ processing_state: 'filtered', process_rev: 0 });
    expect(await db.query(`select id from scheduled_jobs where lead_id = $1`, [leadId])).toEqual([]);
  });

  it('still accepts one whose message is inside its retention', async () => {
    const db = getDb();
    const owned = await seedOwnedAccount(db, { now: rig.clock.now() });
    const leadId = await seedFilteredLead(db, { accountId: owned.accountId, now: rig.clock.now() });
    await db.query(`update lead_messages set purge_at = $2 where lead_id = $1`, [leadId, new Date(rig.clock.now().getTime() + 60_000)]);
    expect(await markRealLead(rig.deps, owned.scope, leadId)).toEqual({ type: 'queued', processRev: 1 });
  });
});
