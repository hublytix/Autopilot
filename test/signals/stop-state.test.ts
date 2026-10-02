import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateStops } from '@/server/domain/stops';
import { loadStopState } from '@/server/services/signals';
import { useTestDb as setUpTestDb } from '../db/harness';
import { at, createSignalsRig, DAY, HOUR, seedNotifiedLead, type SignalsRig } from './support';

// The database half of the stop table (PLAN §6.2, §9.5 step 2): stored stops, the account and its
// connection, the follow-up setting, and D-44's dynamic supersede, as evaluateStops sees them.

const getDb = setUpTestDb();
let rig: SignalsRig;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = await createSignalsRig(getDb());
});

afterEach(() => {
  vi.useRealTimers();
});

async function stopOf(leadId: string, followUpNumber = 1) {
  const state = await loadStopState(getDb(), { leadId, followUpNumber });
  if (state === null) throw new Error('lead gone');
  return evaluateStops(state).stop;
}

describe('loadStopState + evaluateStops', () => {
  it('lets a notified lead on an active account go ahead', async () => {
    const lead = await seedNotifiedLead(rig);
    const state = await loadStopState(getDb(), { leadId: lead.leadId, followUpNumber: 2 });
    expect(state).toEqual({
      isTest: false,
      stopReason: null,
      dismissedAt: null,
      repliedAt: null,
      accountState: 'active',
      connectionStatus: 'active',
      followupsEnabled: true,
      followUpNumber: 2,
      superseded: false,
      contact: null,
    });
    expect(state === null ? null : evaluateStops(state)).toEqual({ stop: null });
    expect(await stopOf(lead.leadId, 3)).toBe('max_followups');
  });

  it('is superseded by a newer non-test lead of the same contact once that one is notified (D-44)', async () => {
    const db = getDb();
    const t0 = rig.clock.now();
    const older = await seedNotifiedLead(rig, { firstNotifiedAt: at(t0, -3 * DAY) });
    expect(await stopOf(older.leadId)).toBeNull();

    // A newer lead of the same contact, not notified yet (filtered, or still processing): no stop.
    const newer = await seedNotifiedLead(rig, { contactId: older.contactId, followUps: false });
    await db.query(`update leads set first_notified_at = null, processing_state = 'filtered', classification = 'spam' where id = $1`, [newer.leadId]);
    expect(await stopOf(older.leadId)).toBeNull();

    // A newer test lead never supersedes (D-14).
    await seedNotifiedLead(rig, { contactId: older.contactId, isTest: true, submittedAt: at(t0, HOUR) });
    expect(await stopOf(older.leadId)).toBeNull();

    await db.query(`update leads set first_notified_at = $2, processing_state = 'notified' where id = $1`, [newer.leadId, t0]);
    expect(await stopOf(older.leadId)).toBe('superseded');
    // The newer lead is not superseded by the older one.
    expect(await stopOf(newer.leadId)).toBeNull();
  });

  it('stops for the account, its connection and the follow-up setting', async () => {
    const db = getDb();
    const lead = await seedNotifiedLead(rig);
    await db.query(`update settings set followups_enabled = false where account_id = $1`, [rig.accountId]);
    expect(await stopOf(lead.leadId)).toBe('followups_off');
    await db.query(`update hubspot_connections set status = 'revoked' where account_id = $1`, [rig.accountId]);
    expect(await stopOf(lead.leadId)).toBe('account_inactive');
    await db.query(`update hubspot_connections set status = 'active' where account_id = $1`, [rig.accountId]);
    await db.query(`update accounts set processing_state = 'paused' where id = $1`, [rig.accountId]);
    expect(await stopOf(lead.leadId)).toBe('account_inactive');
  });

  it('reads the lead\'s own stops: stored reason, dismissal, reply, test lead', async () => {
    const db = getDb();
    const t0 = rig.clock.now();
    const stored = await seedNotifiedLead(rig);
    await db.query(`update leads set stop_reason = 'opted_out' where id = $1`, [stored.leadId]);
    expect(await stopOf(stored.leadId)).toBe('opted_out');

    const dismissed = await seedNotifiedLead(rig, { email: 'sam@riverton-dental.example' });
    await db.query(`update leads set dismissed_at = $2, replied_at = $2 where id = $1`, [dismissed.leadId, t0]);
    expect(await stopOf(dismissed.leadId)).toBe('dismissed');

    const replied = await seedNotifiedLead(rig, { email: 'kim@riverton-dental.example' });
    await db.query(`update leads set replied_at = $2 where id = $1`, [replied.leadId, t0]);
    expect(await stopOf(replied.leadId)).toBe('replied');

    const testLead = await seedNotifiedLead(rig, { email: 'owner.personal@example.net', isTest: true });
    expect(await stopOf(testLead.leadId)).toBe('test_lead');
  });

  it('adds the contact facts from the HubSpot read, and finds nothing for another account or a missing lead', async () => {
    const lead = await seedNotifiedLead(rig);
    const state = await loadStopState(getDb(), { leadId: lead.leadId, followUpNumber: 1, contact: { deleted: false, optedOut: false, bounced: true } });
    expect(state === null ? null : evaluateStops(state)).toEqual({ stop: 'bounced' });
    expect(await loadStopState(getDb(), { leadId: lead.leadId, accountId: '00000000-0000-4000-8000-000000000000', followUpNumber: 1 })).toBeNull();
    expect(await loadStopState(getDb(), { leadId: '00000000-0000-4000-8000-000000000001', followUpNumber: 1 })).toBeNull();
  });
});
