import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransientError } from '@/server/domain/errors';
import { createOwnerScopeForTest, type OwnerScope } from '@/server/services/auth/owner-scope';
import {
  ACCOUNT_REFRESH_BUDGET,
  claimRefreshSlot,
  leadDetailView,
  REFRESH_BUDGET_MS,
  refreshLeadSignals,
  REFRESH_INTERVAL_MS,
  type LeadRefreshOptions,
} from '@/server/views/dashboard';
import { useTestDb as setUpTestDb } from '../db/harness';
import { at, createSignalsRig, DAY, LEAD_EMAIL, MINUTE, seedNotifiedLead, signalRow, type SignalsRig } from '../signals/support';
import { seedOtherAccount } from './support';

// The lead page's refresh on view (PLAN §7.5, §9.5, D-08, D-73, D-77): applySignals with caller
// 'refresh' on the owner's lead, at most once per 5-minute window per lead and ACCOUNT_REFRESH_BUDGET
// per account, never for a test lead, never thrown into the page, and honest when HubSpot's logged
// emails could not all be read.

const getDb = setUpTestDb();
let rig: SignalsRig;
let scope: OwnerScope;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = await createSignalsRig(getDb());
  const owner = await getDb().one<{ owner_user_id: string }>(`select owner_user_id from accounts where id = $1`, [rig.accountId]);
  scope = createOwnerScopeForTest(rig.accountId, owner.owner_user_id);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function options(): LeadRefreshOptions {
  return { applyOptions: { sleep: rig.sleep, notifications: rig.notifications } };
}

describe('refreshLeadSignals', () => {
  it('reads HubSpot on view and records a logged send; a second view in the same 5-minute window does not read again; the next window does', async () => {
    const t0 = rig.clock.now();
    const lead = await seedNotifiedLead(rig);
    rig.clock.set(at(t0, DAY));
    rig.hubspot.logOwnerSend({ to: LEAD_EMAIL, at: at(t0, 10 * MINUTE) });
    const reads = vi.spyOn(rig.hubspot, 'getContact');

    expect(await refreshLeadSignals(scope, rig.deps, lead.leadId, options())).toEqual({ type: 'checked', emailsAvailable: true, replied: false, markedReplied: false });
    expect(await signalRow(getDb(), lead.leadId)).toMatchObject({ send_confirmed_at: at(t0, 10 * MINUTE), signals_checked_at: at(t0, DAY) });
    expect(reads).toHaveBeenCalledTimes(1);

    rig.clock.advance(REFRESH_INTERVAL_MS - 1000);
    expect(await refreshLeadSignals(scope, rig.deps, lead.leadId, options())).toEqual({ type: 'rate_limited' });
    expect(reads).toHaveBeenCalledTimes(1);

    rig.clock.advance(1000);
    expect(await refreshLeadSignals(scope, rig.deps, lead.leadId, options())).toMatchObject({ type: 'checked' });
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('the limit is per lead: another lead is read at once', async () => {
    const first = await seedNotifiedLead(rig);
    const second = await seedNotifiedLead(rig, { email: 'riley.chen@example.net', firstName: 'Riley' });
    expect(await refreshLeadSignals(scope, rig.deps, first.leadId, options())).toMatchObject({ type: 'checked' });
    expect(await refreshLeadSignals(scope, rig.deps, second.leadId, options())).toMatchObject({ type: 'checked' });
  });

  it('records the lead\'s reply and stops the follow-ups (the lead page then offers Resume follow-ups)', async () => {
    const t0 = rig.clock.now();
    const lead = await seedNotifiedLead(rig);
    rig.clock.set(at(t0, DAY));
    rig.hubspot.logLeadReply({ from: LEAD_EMAIL, at: at(t0, 3 * 60 * MINUTE) });

    expect(await refreshLeadSignals(scope, rig.deps, lead.leadId, options())).toEqual({ type: 'checked', emailsAvailable: true, replied: true, markedReplied: true });
    expect(await signalRow(getDb(), lead.leadId)).toMatchObject({ replied_at: at(t0, 3 * 60 * MINUTE), stop_reason: 'replied' });
    const view = await leadDetailView(scope, rig.deps, lead.leadId);
    expect(view).toMatchObject({ status: 'replied', controls: { resumeFollowUps: 'available' } });
  });

  it('never reads HubSpot for a test lead', async () => {
    const lead = await seedNotifiedLead(rig, { isTest: true });
    const reads = vi.spyOn(rig.hubspot, 'getContact');
    expect(await refreshLeadSignals(scope, rig.deps, lead.leadId, options())).toEqual({ type: 'not_eligible' });
    expect(reads).not.toHaveBeenCalled();
    const marker = await getDb().query(`select 1 from rate_limits`);
    expect(marker).toEqual([]);
  });

  it('does not read for a lead never emailed to the owner, a dismissed one, or while the connection is not active', async () => {
    const db = getDb();
    const reads = vi.spyOn(rig.hubspot, 'getContact');
    const lead = await seedNotifiedLead(rig);
    await db.query(`update leads set dismissed_at = $2 where id = $1`, [lead.leadId, rig.clock.now()]);
    expect(await refreshLeadSignals(scope, rig.deps, lead.leadId, options())).toEqual({ type: 'not_eligible' });
    await db.query(`update leads set dismissed_at = null, first_notified_at = null where id = $1`, [lead.leadId]);
    expect(await refreshLeadSignals(scope, rig.deps, lead.leadId, options())).toEqual({ type: 'not_eligible' });
    await db.query(`update leads set first_notified_at = $2 where id = $1`, [lead.leadId, rig.clock.now()]);
    await db.query(`update hubspot_connections set status = 'revoked', access_token_enc = null, refresh_token_enc = null where account_id = $1`, [rig.accountId]);
    expect(await refreshLeadSignals(scope, rig.deps, lead.leadId, options())).toEqual({ type: 'not_eligible' });
    expect(reads).not.toHaveBeenCalled();
  });

  it('says so when HubSpot\'s logged emails could not be read (no check time recorded)', async () => {
    const t0 = rig.clock.now();
    const lead = await seedNotifiedLead(rig);
    rig.clock.set(at(t0, DAY));
    rig.hubspot.logOwnerSend({ to: LEAD_EMAIL, at: at(t0, 10 * MINUTE) });
    // The portal no longer grants the email scope: HubSpot answers the email read with 403 MISSING_SCOPES.
    rig.hubspot.setGrantedScopes(['oauth', 'crm.objects.contacts.read', 'forms']);
    expect(await refreshLeadSignals(scope, rig.deps, lead.leadId, options())).toEqual({ type: 'checked', emailsAvailable: false, replied: false, markedReplied: false });
    expect((await signalRow(getDb(), lead.leadId)).signals_checked_at).toBeNull();
  });

  it('never throws into the page: a HubSpot outage is "failed", and the slot is still used', async () => {
    const lead = await seedNotifiedLead(rig);
    rig.hubspot.injectFailure('*', { kind: 'server_error', times: 5 });
    expect(await refreshLeadSignals(scope, rig.deps, lead.leadId, options())).toEqual({ type: 'failed' });
    expect(await refreshLeadSignals(scope, rig.deps, lead.leadId, options())).toEqual({ type: 'rate_limited' });
  });

  it('is not found for another account\'s lead or a malformed id, reads nothing and claims no slot', async () => {
    const reads = vi.spyOn(rig.hubspot, 'getContact');
    const lead = await seedNotifiedLead(rig);
    const other = await seedOtherAccount(getDb(), rig.clock.now());
    expect(await refreshLeadSignals(other.scope, rig.deps, lead.leadId, options())).toEqual({ type: 'not_found' });
    expect(await refreshLeadSignals(scope, rig.deps, 'nope', options())).toEqual({ type: 'not_found' });
    expect(reads).not.toHaveBeenCalled();
    // Nothing was claimed, so another account can never rate-limit this lead's page.
    expect(await getDb().one<{ count: number }>(`select count(*)::int as count from rate_limits`)).toEqual({ count: 0 });
    expect(await refreshLeadSignals(scope, rig.deps, lead.leadId, options())).toMatchObject({ type: 'checked' });
  });

  it('does not read for a lead whose data was deleted at the contact\'s request, and claims no slot', async () => {
    const db = getDb();
    const reads = vi.spyOn(rig.hubspot, 'getContact');
    const deleted = await seedNotifiedLead(rig);
    await db.query(`update leads set stop_reason = 'privacy_deletion' where id = $1`, [deleted.leadId]);
    expect(await refreshLeadSignals(scope, rig.deps, deleted.leadId, options())).toEqual({ type: 'not_eligible' });
    expect(reads).not.toHaveBeenCalled();
    expect(await db.one<{ count: number }>(`select count(*)::int as count from rate_limits`)).toEqual({ count: 0 });
    // A lead without a HubSpot contact can only be the inbox check's test lead (leads_contact_required_check),
    // which "never reads HubSpot for a test lead" covers.
    await expect(db.query(`update leads set hubspot_contact_id = null where id = $1`, [deleted.leadId])).rejects.toThrow();
  });

  it('gives up after REFRESH_BUDGET_MS by default (an 8 s signal) and renders what it knew', async () => {
    const lead = await seedNotifiedLead(rig);
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    vi.spyOn(rig.hubspot, 'getContact').mockImplementation(
      (_token, _id, callOptions) =>
        new Promise((_resolve, reject) => {
          callOptions.signal?.addEventListener('abort', () => reject(new TransientError('hubspot_timeout')));
        }),
    );
    const pending = refreshLeadSignals(scope, rig.deps, lead.leadId, options());
    await vi.waitFor(() => expect(timeout).toHaveBeenCalledWith(REFRESH_BUDGET_MS));
    controller.abort();
    expect(await pending).toEqual({ type: 'failed' });
    expect(REFRESH_BUDGET_MS).toBe(8000);
  });
});

describe('claimRefreshSlot: one read per lead per window', () => {
  const KEY = 'a'.repeat(64);

  it('lets exactly one of two overlapping loads win, whatever order they commit in', async () => {
    const db = getDb();
    const t = at(rig.clock.now(), 2 * MINUTE);
    // The load that read the clock 1 ms later commits first; the earlier one must still lose.
    expect(await claimRefreshSlot(db, KEY, at(t, 1))).toBe(true);
    expect(await claimRefreshSlot(db, KEY, t)).toBe(false);
    expect(await claimRefreshSlot(db, KEY, at(t, 2 * MINUTE))).toBe(false);
  });

  it('allows the next window\'s read, so at most two reads fall within any 5 minutes', async () => {
    const db = getDb();
    const boundary = at(rig.clock.now(), REFRESH_INTERVAL_MS);
    expect(await claimRefreshSlot(db, KEY, at(boundary, -1))).toBe(true);
    expect(await claimRefreshSlot(db, KEY, boundary)).toBe(true);
    expect(await claimRefreshSlot(db, KEY, at(boundary, REFRESH_INTERVAL_MS - 1))).toBe(false);
  });
});

describe('refreshLeadSignals: the account\'s budget', () => {
  it(`reads at most ${ACCOUNT_REFRESH_BUDGET} leads per 5-minute window for one account; reloads cost nothing; the next window reads again`, async () => {
    const leads = [];
    for (let i = 0; i <= ACCOUNT_REFRESH_BUDGET; i += 1) leads.push(await seedNotifiedLead(rig, { email: `lead${i}@example.net`, firstName: 'Riley' }));
    const reads = vi.spyOn(rig.hubspot, 'getContact');
    const first = leads[0];
    const last = leads.at(-1);
    if (first === undefined || last === undefined) throw new Error('no leads');

    for (const lead of leads.slice(0, ACCOUNT_REFRESH_BUDGET)) {
      expect(await refreshLeadSignals(scope, rig.deps, lead.leadId, options())).toMatchObject({ type: 'checked' });
      // A reload of a lead already read in this window costs the account nothing.
      expect(await refreshLeadSignals(scope, rig.deps, lead.leadId, options())).toEqual({ type: 'rate_limited' });
    }
    const readsSoFar = reads.mock.calls.length;
    expect(await refreshLeadSignals(scope, rig.deps, last.leadId, options())).toEqual({ type: 'rate_limited' });
    expect(reads.mock.calls.length).toBe(readsSoFar);

    // The refused lead's own slot was not used up: it is read in the next window.
    rig.clock.advance(REFRESH_INTERVAL_MS);
    expect(await refreshLeadSignals(scope, rig.deps, last.leadId, options())).toMatchObject({ type: 'checked' });
  });
});
