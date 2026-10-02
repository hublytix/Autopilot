import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@/server/db';
import { REQUIRED_SCOPES } from '@/server/hubspot/scopes';
import { seedSubscription } from '@/server/services/accounts/testing';
import { NotificationKeys } from '@/server/services/notifications/predicates';
import { pauseAll, resumeAll } from '@/server/services/owner-controls';
import { dashboardView, type DashboardBanner, type DashboardView } from '@/server/views/dashboard';
import { useTestDb as setUpTestDb } from '../db/harness';
import { deliver, scheduleLeadProcess } from '../leads/support';
import { at, createLeadsRig, DAY, HOUR, PORTAL_ID, purgeContent, seedLeadIn, seedOwnedAccount, type LeadsRig, type OwnedAccount } from './support';

// The /dashboard read model (PLAN §7.5, §6.1, §9.6, D-32, D-42, D-48, D-73): the status card in
// each processing state, every banner from the rows that cause it, and the recent leads with one
// status each (deferred leads listed as "Not processed", purged leads by contact id, test leads
// never). The system time is far from the test's Clock (PLAN §12): nothing reads the wall clock.

const getDb = setUpTestDb();
let rig: LeadsRig;
let owned: OwnedAccount;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = createLeadsRig(getDb());
  owned = await seedOwnedAccount(getDb(), { now: rig.clock.now() });
  await grantScopes(getDb(), owned.accountId);
});

afterEach(() => {
  vi.useRealTimers();
});

async function grantScopes(db: Db, accountId: string, scopes: readonly string[] = REQUIRED_SCOPES): Promise<void> {
  await db.query(`update hubspot_connections set scopes = $2 where account_id = $1`, [accountId, scopes]);
}

async function view(options: { reconnectRequested?: boolean } = {}): Promise<DashboardView> {
  return dashboardView(owned.scope, rig.deps, options);
}

function types(banners: readonly DashboardBanner[]): string[] {
  return banners.map((banner) => banner.type);
}

function banner<T extends DashboardBanner['type']>(v: DashboardView, type: T): Extract<DashboardBanner, { type: T }> | undefined {
  return v.banners.find((b): b is Extract<DashboardBanner, { type: T }> => b.type === type);
}

describe('the status card', () => {
  it('an active account in its trial: Active, trial days left, no banners', async () => {
    const v = await view();
    expect(v.status).toEqual({ state: 'active', trialDaysLeft: 14, reconnectDaysLeft: null, purgeOn: null, pausedSince: null });
    expect(v.onboardingComplete).toBe(true);
    expect(v.banners).toEqual([]);
    expect(v.zone).toBe('America/New_York');
  });

  it('paused: Paused since the pause, in the portal zone', async () => {
    await pauseAll(rig.deps, owned.scope);
    const v = await view();
    expect(v.status).toMatchObject({ state: 'paused', pausedSince: 'Tue 6 Oct, 10:00' });
    expect(banner(v, 'paused')).toEqual({ type: 'paused', since: 'Tue 6 Oct, 10:00', skippedLeads: 0 });
  });

  it('revoked: HubSpot disconnected with the days left to reconnect before the data is deleted, and the reconnect banner', async () => {
    const db = getDb();
    const purgeAfter = at(rig.clock.now(), 30 * DAY);
    await db.query(`update hubspot_connections set status = 'revoked', access_token_enc = null, refresh_token_enc = null where account_id = $1`, [owned.accountId]);
    await db.query(`update accounts set processing_state = 'revoked', purge_after = $2 where id = $1`, [owned.accountId, purgeAfter]);
    rig.clock.advance({ days: 3, hours: 1 });
    const v = await view();
    expect(v.status).toMatchObject({ state: 'disconnected', reconnectDaysLeft: 27, purgeOn: '5 Nov 2026' });
    expect(banner(v, 'reconnect')).toEqual({ type: 'reconnect', connected: false, daysLeft: 27, purgeOn: '5 Nov 2026' });
    expect(v.connectionActive).toBe(false);
  });

  it('inactive after the trial: Billing inactive, no trial days, the billing banner', async () => {
    const db = getDb();
    await db.query(`update accounts set processing_state = 'inactive', trial_started_at = $2, trial_ends_at = $3 where id = $1`, [
      owned.accountId,
      at(rig.clock.now(), -20 * DAY),
      at(rig.clock.now(), -6 * DAY),
    ]);
    const v = await view();
    expect(v.status).toMatchObject({ state: 'billing_inactive', trialDaysLeft: null });
    expect(types(v.banners)).toContain('billing_inactive');
  });

  it('setup not finished: Setup incomplete, with the setup banner', async () => {
    await getDb().query(`update accounts set processing_state = 'onboarding', onboarding_completed_at = null where id = $1`, [owned.accountId]);
    const v = await view();
    expect(v.status.state).toBe('setup_incomplete');
    expect(v.onboardingComplete).toBe(false);
    expect(types(v.banners)).toEqual(['setup_incomplete']);
  });
});

describe('the banners', () => {
  it('a reconnect sign-in link (?reconnect=1) shows Reconnect HubSpot even while the connection works', async () => {
    const v = await view({ reconnectRequested: true });
    expect(banner(v, 'reconnect')).toEqual({ type: 'reconnect', connected: true, daysLeft: null, purgeOn: null });
  });

  it("the trial's last days without a subscription; none once subscribed", async () => {
    const db = getDb();
    await db.query(`update accounts set trial_ends_at = $2 where id = $1`, [owned.accountId, at(rig.clock.now(), 2 * DAY)]);
    expect(banner(await view(), 'trial_ending')).toEqual({ type: 'trial_ending', daysLeft: 2 });
    await seedSubscription(db, { accountId: owned.accountId, status: 'authenticated', createdAt: rig.clock.now() });
    expect(banner(await view(), 'trial_ending')).toBeUndefined();
  });

  it('a failed payment inside its grace period', async () => {
    const db = getDb();
    await db.query(`update accounts set trial_started_at = $2, trial_ends_at = $3 where id = $1`, [owned.accountId, at(rig.clock.now(), -30 * DAY), at(rig.clock.now(), -16 * DAY)]);
    await seedSubscription(db, { accountId: owned.accountId, status: 'pending', createdAt: at(rig.clock.now(), -16 * DAY), graceUntil: at(rig.clock.now(), 2 * DAY) });
    expect(banner(await view(), 'payment_grace')).toEqual({ type: 'payment_grace', until: 'Thu 8 Oct, 10:00' });
  });

  it.each([
    ['none', 'none'],
    ['sends_only', 'sends_only'],
    ['unknown', 'unknown'],
  ] as const)('logging mode %s: what Autopilot cannot confirm', async (mode, expected) => {
    await getDb().query(`update accounts set logging_mode = $2 where id = $1`, [owned.accountId, mode]);
    expect(banner(await view(), 'logging')).toEqual({ type: 'logging', mode: expected });
  });

  it('an inbox check still running replaces the logging warning; a missing email scope replaces both', async () => {
    const db = getDb();
    await db.query(`update accounts set logging_mode = 'unknown' where id = $1`, [owned.accountId]);
    await db.query(`insert into inbox_checks (account_id, test_address_hmac, status, created_at) values ($1, $2, 'open', $3)`, [
      owned.accountId,
      'a'.repeat(64),
      rig.clock.now(),
    ]);
    expect(types((await view()).banners)).toEqual(['inbox_check_pending']);
    await grantScopes(db, owned.accountId, ['oauth', 'crm.objects.contacts.read', 'forms']);
    expect(types((await view()).banners)).toEqual(['email_scope_missing']);
  });

  it('the daily cap: deferred leads today, and earlier ones in the last 7 days', async () => {
    const db = getDb();
    const now = rig.clock.now();
    await seedLeadIn(db, { accountId: owned.accountId, receivedAt: at(now, -HOUR), state: 'deferred', set: { classification: 'lead', classified_at: at(now, -HOUR) } });
    await db.query(
      `insert into notifications_sent (dedupe_key, account_id, kind, status, first_reserved_at, reserved_at, sent_at) values ($1, $2, 'lead_cap', 'sent', $3, $3, $3)`,
      [NotificationKeys.leadCap(owned.accountId, '2026-10-06'), owned.accountId, at(now, -HOUR)],
    );
    await seedLeadIn(db, { accountId: owned.accountId, receivedAt: at(now, -3 * DAY), state: 'deferred', set: { classification: 'lead', classified_at: at(now, -3 * DAY) } });
    expect(banner(await view(), 'daily_cap')).toEqual({ type: 'daily_cap', limit: 50, reachedToday: true, deferredToday: 1, deferredEarlier: 1 });
  });

  it('no cap banner without deferred leads or a lead_cap email', async () => {
    expect(banner(await view(), 'daily_cap')).toBeUndefined();
  });

  it('leads skipped while paused are counted since the pause, and after Resume the banner says what the pause left out', async () => {
    const db = getDb();
    const leadId = await seedLeadIn(db, { accountId: owned.accountId, receivedAt: rig.clock.now() });
    const job = await scheduleLeadProcess(rig, { accountId: owned.accountId, leadId });
    await pauseAll(rig.deps, owned.scope);
    rig.clock.advance({ minutes: 1 });
    expect(await deliver(rig, job)).toMatchObject({ outcome: 'skipped' });
    expect(banner(await view(), 'paused')).toEqual({ type: 'paused', since: 'Tue 6 Oct, 10:00', skippedLeads: 1 });

    rig.clock.advance({ days: 1 });
    await resumeAll(rig.deps, owned.scope);
    const resumed = await view();
    expect(resumed.status.state).toBe('active');
    expect(banner(resumed, 'resumed')).toEqual({ type: 'resumed', pausedFrom: 'Tue 6 Oct, 10:00', skippedLeads: 1 });
    expect(banner(resumed, 'paused')).toBeUndefined();

    rig.clock.advance({ days: 8 });
    expect(banner(await view(), 'resumed')).toBeUndefined();
  });

  it('recent drafts that need the owner\'s touch, and the AI limit reached today', async () => {
    const db = getDb();
    const now = rig.clock.now();
    await seedLeadIn(db, { accountId: owned.accountId, receivedAt: at(now, -HOUR), state: 'notified', set: { needs_touch: true, first_notified_at: at(now, -HOUR), classification: 'lead' } });
    expect(banner(await view(), 'needs_touch')).toEqual({ type: 'needs_touch', count: 1 });
    expect(banner(await view(), 'ai_limit')).toBeUndefined();
    await db.query(
      `insert into ai_calls (account_id, purpose, model, cost_micro_usd, outcome, created_at) values ($1, 'draft', 'claude-test', 25000000, 'ok', $2)`,
      [owned.accountId, at(now, -HOUR)],
    );
    expect(banner(await view(), 'ai_limit')).toEqual({ type: 'ai_limit' });
  });
});

describe('the recent leads', () => {
  it('lists the latest leads newest first with one status each; deferred leads show "Not processed"; test leads never', async () => {
    const db = getDb();
    const now = rig.clock.now();
    const filtered = await seedLeadIn(db, { accountId: owned.accountId, receivedAt: at(now, -3 * HOUR), state: 'filtered', set: { classification: 'spam', classified_at: at(now, -3 * HOUR) } });
    const deferred = await seedLeadIn(db, { accountId: owned.accountId, receivedAt: at(now, -2 * HOUR), state: 'deferred', set: { classification: 'lead' } });
    const clicked = await seedLeadIn(db, {
      accountId: owned.accountId,
      receivedAt: at(now, -HOUR),
      state: 'notified',
      set: { classification: 'lead', first_notified_at: at(now, -50 * 60_000), first_send_clicked_at: at(now, -40 * 60_000) },
    });
    await seedLeadIn(db, { accountId: owned.accountId, receivedAt: at(now, -10 * 60_000), isTest: true });

    const v = await view();
    expect(v.leads.map((lead) => lead.id)).toEqual([clicked, deferred, filtered]);
    expect(v.leads.map((lead) => [lead.statusLabel, lead.notProcessed])).toEqual([
      ['Send link opened', null],
      ['Not processed', 'daily_cap'],
      ['Filtered', null],
    ]);
    const [first] = v.leads;
    expect(first).toMatchObject({ name: { kind: 'name', name: 'Maya' }, receivedAt: 'Tue 6 Oct, 09:00' });
    expect(first?.recordUrl).toMatch(new RegExp(`^https://app\\.hubspot\\.com/contacts/${PORTAL_ID}/record/0-1/\\d+$`));
  });

  it('shows "Contact #id" once the details are purged or deleted at the contact\'s request, and when the name is unusable', async () => {
    const db = getDb();
    const now = rig.clock.now();
    const purged = await seedLeadIn(db, { accountId: owned.accountId, receivedAt: at(now, -31 * DAY), state: 'notified', contactId: '5001' });
    await purgeContent(db, purged, now);
    const deleted = await seedLeadIn(db, { accountId: owned.accountId, receivedAt: at(now, -2 * DAY), state: 'notified', contactId: '5002', set: { stop_reason: 'privacy_deletion' } });
    await db.query(`delete from lead_messages where lead_id = $1`, [deleted]);
    await seedLeadIn(db, { accountId: owned.accountId, receivedAt: at(now, -DAY), state: 'notified', contactId: '5003', firstName: 'visit evil.example now' });

    const names = (await view()).leads.map((lead) => lead.name);
    expect(names).toEqual([
      { kind: 'contact', contactId: '5003', removed: null },
      { kind: 'contact', contactId: '5002', removed: 'privacy_deleted' },
      { kind: 'contact', contactId: '5001', removed: 'purged' },
    ]);
  });

  it('keeps at most 50 leads', async () => {
    const db = getDb();
    await db.query(
      `insert into leads (account_id, hubspot_contact_id, form_id, submitted_at, intake_trigger, received_at)
       select $1, (900000 + g)::text, 'form-1', $2::timestamptz - g * interval '1 minute', 'webhook', $2::timestamptz - g * interval '1 minute'
         from generate_series(1, 55) g`,
      [owned.accountId, rig.clock.now()],
    );
    const v = await view();
    expect(v.leads).toHaveLength(50);
    expect(v.leads[0]?.name).toEqual({ kind: 'contact', contactId: '900001', removed: 'purged' });
  });

  it('says "No reply from lead (none logged)" only after HubSpot was read in full (D-73)', async () => {
    const db = getDb();
    const now = rig.clock.now();
    const t0 = at(now, -10 * DAY);
    const leadId = await seedLeadIn(db, {
      accountId: owned.accountId,
      receivedAt: at(t0, -5 * 60_000),
      state: 'notified',
      set: { classification: 'lead', first_notified_at: t0, first_send_clicked_at: at(t0, 10 * 60_000), fu1_notified_at: at(t0, 2 * DAY), fu2_notified_at: at(t0, 5 * DAY) },
    });
    expect((await view()).leads[0]?.statusLabel).toBe('Send link opened');
    await db.query(`update leads set signals_checked_at = $2 where id = $1`, [leadId, at(t0, 5 * DAY - 60_000)]);
    expect((await view()).leads[0]?.statusLabel).toBe('No reply from lead (none logged)');
  });
});

describe('"No reply from lead (none logged)" needs reply logging (D-37, D-77)', () => {
  it.each([
    ['none', REQUIRED_SCOPES],
    ['sends_only', REQUIRED_SCOPES],
    ['unknown', REQUIRED_SCOPES],
    ['log_all', REQUIRED_SCOPES.filter((scope) => scope !== 'sales-email-read')],
  ] as const)('is never claimed with logging_mode %s and scopes %j: the lead keeps its send status', async (mode, scopes) => {
    const db = getDb();
    const now = rig.clock.now();
    const t0 = at(now, -10 * DAY);
    const leadId = await seedLeadIn(db, {
      accountId: owned.accountId,
      receivedAt: at(t0, -5 * 60_000),
      state: 'notified',
      set: {
        classification: 'lead',
        first_notified_at: t0,
        send_confirmed_at: at(t0, 10 * 60_000),
        fu1_notified_at: at(t0, 2 * DAY),
        fu2_notified_at: at(t0, 5 * DAY),
        signals_checked_at: at(t0, 6 * DAY),
      },
    });
    expect((await view()).leads[0]?.statusLabel).toBe('No reply from lead (none logged)');
    await db.query(`update accounts set logging_mode = $2 where id = $1`, [owned.accountId, mode]);
    await grantScopes(db, owned.accountId, scopes);
    expect((await view()).leads[0]).toMatchObject({ status: 'send_confirmed', statusLabel: 'Send confirmed in HubSpot' });
    expect(leadId).toBeTruthy();
  });
});

describe('content past its purge_at', () => {
  it('is never shown: the list names the contact, even before the hourly purge deletes the row', async () => {
    const db = getDb();
    const now = rig.clock.now();
    const leadId = await seedLeadIn(db, { accountId: owned.accountId, receivedAt: at(now, -31 * DAY), contactId: '880001', state: 'notified', set: { first_notified_at: at(now, -31 * DAY) } });
    await db.query(`update lead_messages set purge_at = $2 where lead_id = $1`, [leadId, at(now, -1)]);
    const v = await view();
    expect(v.leads[0]?.name).toEqual({ kind: 'contact', contactId: '880001', removed: 'purged' });
    expect(JSON.stringify(v)).not.toContain('Maya');
  });
});

describe('a deferred lead from the real daily cap (D-68: the lead_cap email promises the dashboard lists it)', () => {
  it('with MAX_DRAFTED_LEADS_PER_DAY=1 the second lead is deferred and listed as "Not processed"', async () => {
    const capped = createLeadsRig(getDb(), { env: { MAX_DRAFTED_LEADS_PER_DAY: '1' } });
    const db = getDb();
    const now = capped.clock.now();
    const first = await seedLeadIn(db, { accountId: owned.accountId, receivedAt: now, firstName: 'Maya' });
    const second = await seedLeadIn(db, { accountId: owned.accountId, receivedAt: at(now, 60_000), firstName: 'Riley' });
    expect(await deliver(capped, await scheduleLeadProcess(capped, { accountId: owned.accountId, leadId: first }))).toMatchObject({ outcome: 'done' });
    capped.clock.advance({ minutes: 2 });
    expect(await deliver(capped, await scheduleLeadProcess(capped, { accountId: owned.accountId, leadId: second }))).toMatchObject({ outcome: 'done' });
    expect(capped.fakes.mailer.sent.map((mail) => mail.kind)).toEqual(['new_lead', 'lead_cap']);

    const v = await dashboardView(owned.scope, capped.deps);
    const listed = v.leads.find((lead) => lead.id === second);
    expect(listed).toMatchObject({ status: 'not_processed', statusLabel: 'Not processed', notProcessed: 'daily_cap', name: { kind: 'name', name: 'Riley' } });
    expect(v.leads.find((lead) => lead.id === first)?.statusLabel).toBe('Drafted');
    expect(banner(v, 'daily_cap')).toEqual({ type: 'daily_cap', limit: 1, reachedToday: true, deferredToday: 1, deferredEarlier: 0 });
  });
});
