import { describe, expect, it } from 'vitest';
import type { FakeRazorpayWebhook } from '@/server/adapters/fake/billing';
import { handleRazorpayWebhook } from '@/server/http/razorpay-webhook';
import { computeRazorpaySignature } from '@/server/security/razorpay-signature';
import { applyProcessingState } from '@/server/services/accounts';
import { runBillingControl, startCheckout } from '@/server/services/billing';
import { reconcileAccountSubscriptions } from '@/server/services/daily/reconcile';
import { billingPageView } from '@/server/views/billing';
import { useTestDb as setUpTestDb } from '../db/harness';
import {
  accountState,
  alertCodes,
  billingEmails,
  DAY,
  deliver,
  deliverQueued,
  insertSubscription,
  onlySubscription,
  seedBillingAccount,
  subscriptions,
  setUpBillingRig,
  WEBHOOK_URL,
  type BillingRig,
} from './support';

// POST /api/razorpay/webhook end to end (PLAN §7.3, §9.9, D-05, D-19) with FakeBilling's signed
// webhooks: replays and dedupe, the created_at window, fetch-and-apply only if newer, the status
// mapping (resumed, unknown, pending grace), the processing state and its one billing email, the
// second-live-subscription safety net, tombstones and unknown subscriptions, and retries.

const getDb = setUpTestDb();
const getRig = setUpBillingRig(getDb);

/** An account with a checkout the owner has authorised (trial running): returns the Razorpay id. */
async function subscribed(rig: BillingRig): Promise<{ accountId: string; id: string }> {
  const { accountId, scope } = await seedBillingAccount(rig);
  await startCheckout(rig.deps, scope);
  const id = rig.fakes.billing.subscriptionIds()[0] ?? '';
  rig.fakes.billing.authenticate(id);
  await deliverQueued(rig);
  return { accountId, id };
}

/** The webhook as Razorpay would POST it, with a fresh signed body. */
function signed(rawBody: string, headers: Record<string, string> = {}, secret = 'fake-only-razorpay-webhook-secret'): Request {
  return new Request(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-razorpay-signature': computeRazorpaySignature(rawBody, secret), ...headers },
    body: rawBody,
  });
}

function eventBody(event: string, subscriptionId: string, createdAt: Date, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    entity: 'event',
    account_id: 'acc_FakeAutopilot1',
    event,
    contains: ['subscription'],
    payload: { subscription: { entity: { id: subscriptionId, entity: 'subscription', status: 'active', short_url: null, notes: [] } } },
    created_at: Math.floor(createdAt.getTime() / 1000),
    ...extra,
  });
}

async function post(rig: BillingRig, request: Request): Promise<{ status: number; outcome: string }> {
  const response = await handleRazorpayWebhook(request, rig.deps);
  const body = (await response.json()) as { outcome?: string; code?: string };
  return { status: response.status, outcome: body.outcome ?? body.code ?? '' };
}

async function webhookRows(rig: BillingRig): Promise<{ dedupe_key: string; outcome: string | null; account_id: string | null; event_type: string | null }[]> {
  return rig.deps.db.query(`select dedupe_key, outcome, account_id, event_type from webhook_events where provider = 'razorpay' order by id`);
}

describe('applying a subscription through its webhooks', () => {
  it('authorised during the trial → authenticated, then active when billing starts; the account stays active throughout', async () => {
    const rig = getRig();
    const { accountId, id } = await subscribed(rig);
    expect(await onlySubscription(getDb(), accountId)).toMatchObject({ status: 'authenticated', lastSyncedAt: rig.clock.now() });

    rig.clock.advance({ days: 14 });
    rig.fakes.billing.sync();
    const results = await deliverQueued(rig);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const row = await onlySubscription(getDb(), accountId);
    expect(row).toMatchObject({ status: 'active', paymentFailedAt: null, graceUntil: null });
    expect(row.currentEnd).not.toBeNull();
    expect(await accountState(getDb(), accountId)).toMatchObject({ processing_state: 'active', entitlement_lost_at: null });
    expect(billingEmails(rig)).toHaveLength(0);
    expect(id).toMatch(/^sub_/);
  });

  it('records each event with its account and outcome', async () => {
    const rig = getRig();
    const { accountId } = await subscribed(rig);
    expect(await webhookRows(rig)).toEqual([expect.objectContaining({ outcome: 'applied', account_id: accountId, event_type: 'subscription.authenticated' })]);
  });

  it('pending keeps the account running until the grace ends (first pending event + 3 d), then halted stops it with one email', async () => {
    const rig = getRig();
    const { accountId, id } = await subscribed(rig);
    rig.clock.advance({ days: 14 });
    rig.fakes.billing.sync();
    await deliverQueued(rig);

    rig.clock.advance({ days: 30 });
    rig.fakes.billing.sync();
    await deliverQueued(rig);
    const failedAt = rig.clock.now();
    rig.fakes.billing.failPayment(id);
    rig.clock.advance({ hours: 1 });
    await deliverQueued(rig);
    expect(await onlySubscription(getDb(), accountId)).toMatchObject({ status: 'pending', paymentFailedAt: failedAt, graceUntil: new Date(failedAt.getTime() + 3 * DAY) });
    expect(await accountState(getDb(), accountId)).toMatchObject({ processing_state: 'active' });

    // A second failed retry: the first failure still counts.
    rig.clock.advance({ days: 1 });
    rig.fakes.billing.failPayment(id);
    await deliverQueued(rig);
    expect(await onlySubscription(getDb(), accountId)).toMatchObject({ paymentFailedAt: failedAt });

    rig.clock.advance({ days: 2 });
    rig.fakes.billing.halt(id);
    await deliverQueued(rig);
    expect(await onlySubscription(getDb(), accountId)).toMatchObject({ status: 'halted' });
    expect(await accountState(getDb(), accountId)).toMatchObject({ processing_state: 'inactive' });
    expect(billingEmails(rig)).toHaveLength(1);

    // Card updated: active again, the grace cleared.
    rig.fakes.billing.activate(id);
    await deliverQueued(rig);
    expect(await onlySubscription(getDb(), accountId)).toMatchObject({ status: 'active', paymentFailedAt: null, graceUntil: null });
    expect(await accountState(getDb(), accountId)).toMatchObject({ processing_state: 'active', entitlement_lost_at: null });
  });

  it('maps resumed to active', async () => {
    const rig = getRig();
    const { accountId } = await seedBillingAccount(rig);
    await insertSubscription(getDb(), { accountId, providerId: 'sub_Resumed00001', status: 'paused', createdAt: rig.clock.now() });
    const fetch = rig.fakes.billing.fetchSubscription.bind(rig.fakes.billing);
    rig.fakes.billing.fetchSubscription = async () => ({ ...(await fakeSnapshot(rig)), id: 'sub_Resumed00001', status: 'resumed' });
    rig.clock.advance({ minutes: 1 });
    expect(await post(rig, signed(eventBody('subscription.resumed', 'sub_Resumed00001', rig.clock.now())))).toEqual({ status: 200, outcome: 'applied' });
    expect(await onlySubscription(getDb(), accountId)).toMatchObject({ status: 'active' });
    rig.fakes.billing.fetchSubscription = fetch;
  });

  it('an undocumented status is stored as unknown: not entitled, blocks a new checkout (contact support), and the admin is alerted', async () => {
    const rig = getRig();
    const { accountId, scope } = await seedBillingAccount(rig);
    rig.clock.advance({ days: 15 });
    await insertSubscription(getDb(), { accountId, providerId: 'sub_Unknown00001', status: 'active', createdAt: rig.clock.now() });
    const fetch = rig.fakes.billing.fetchSubscription.bind(rig.fakes.billing);
    rig.fakes.billing.fetchSubscription = async () => ({ ...(await fakeSnapshot(rig)), id: 'sub_Unknown00001', status: 'on_hold' });
    rig.clock.advance({ minutes: 1 });
    expect(await post(rig, signed(eventBody('subscription.updated', 'sub_Unknown00001', rig.clock.now())))).toEqual({ status: 200, outcome: 'unknown_status' });
    expect(await onlySubscription(getDb(), accountId)).toMatchObject({ status: 'unknown' });
    expect(await accountState(getDb(), accountId)).toMatchObject({ processing_state: 'inactive' });
    expect(alertCodes(rig)).toContain('billing_unknown_subscription_status');

    // It may still hold a mandate: no second checkout, the owner is sent to support.
    expect(await runBillingControl(rig.deps, scope, 'checkout')).toBe('/dashboard/billing?result=checkout.contact_support');
    expect(await subscriptions(getDb(), accountId)).toHaveLength(1);
    expect(await billingPageView(rig.deps, scope)).toMatchObject({ action: 'none', subscription: { status: 'unknown' }, supportEmail: rig.deps.env.EMAIL_REPLY_TO });

    // The daily reconcile reads it again; once Razorpay reports a known status, that replaces it.
    rig.fakes.billing.fetchSubscription = async () => ({ ...(await fakeSnapshot(rig)), id: 'sub_Unknown00001', status: 'active' });
    rig.clock.advance({ hours: 1 });
    expect(await reconcileAccountSubscriptions(rig.deps, accountId)).toEqual({ reconciled: 1 });
    expect(await onlySubscription(getDb(), accountId)).toMatchObject({ status: 'active' });
    expect(await accountState(getDb(), accountId)).toMatchObject({ processing_state: 'active' });
    rig.fakes.billing.fetchSubscription = fetch;
  });
});

/** A plausible fetched subscription (for tests that replace fetchSubscription). */
async function fakeSnapshot(rig: BillingRig) {
  return {
    id: 'sub_X',
    planId: 'plan_fakeonly',
    status: 'active',
    shortUrl: '',
    createdAt: rig.clock.now(),
    notes: {},
  };
}

describe('replays and dedupe (D-05)', () => {
  it('the same event id with a different body is a duplicate: the header id alone dedupes (D-05)', async () => {
    const rig = getRig();
    const { accountId, id } = await subscribed(rig);
    rig.clock.advance({ minutes: 5 });
    const first = eventBody('subscription.charged', id, rig.clock.now());
    expect(await post(rig, signed(first, { 'x-razorpay-event-id': 'evt_Same0000001' }))).toEqual({ status: 200, outcome: 'applied' });
    const before = await onlySubscription(getDb(), accountId);
    rig.fakes.billing.cancel(id);
    rig.fakes.billing.takeWebhooks();
    rig.clock.advance({ minutes: 1 });
    // A different body (another event, another time) under the same id: never applied.
    const second = eventBody('subscription.cancelled', id, rig.clock.now());
    expect(second).not.toBe(first);
    expect(await post(rig, signed(second, { 'x-razorpay-event-id': 'evt_Same0000001' }))).toEqual({ status: 200, outcome: 'duplicate' });
    expect(await onlySubscription(getDb(), accountId)).toEqual(before);
    expect((await webhookRows(rig)).filter((row) => row.dedupe_key === 'evt_Same0000001')).toHaveLength(1);
  });

  it('the same event id twice is applied once', async () => {
    const rig = getRig();
    const { accountId, id } = await subscribed(rig);
    rig.clock.advance({ days: 14 });
    rig.fakes.billing.sync();
    const queued = rig.fakes.billing.takeWebhooks();
    expect((await deliver(rig, queued)).map((r) => r.outcome)).toEqual(['applied', 'applied']);
    expect((await deliver(rig, queued)).map((r) => r.outcome)).toEqual(['duplicate', 'duplicate']);
    expect((await webhookRows(rig)).filter((row) => row.account_id === accountId)).toHaveLength(3);
    expect(id).toBeTruthy();
  });

  it('without the event id header, dedupes on the body hash', async () => {
    const rig = getRig();
    const { id } = await subscribed(rig);
    rig.clock.advance({ minutes: 5 });
    const body = eventBody('subscription.charged', id, rig.clock.now());
    expect(await post(rig, signed(body))).toEqual({ status: 200, outcome: 'applied' });
    expect(await post(rig, signed(body))).toEqual({ status: 200, outcome: 'duplicate' });
    const rows = await webhookRows(rig);
    expect(rows.at(-1)?.dedupe_key).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('a signed body replayed under a fresh event id is still a duplicate (unique body hash)', async () => {
    const rig = getRig();
    const { id } = await subscribed(rig);
    rig.clock.advance({ minutes: 5 });
    const body = eventBody('subscription.charged', id, rig.clock.now());
    expect(await post(rig, signed(body, { 'x-razorpay-event-id': 'evt_First000001' }))).toMatchObject({ outcome: 'applied' });
    expect(await post(rig, signed(body, { 'x-razorpay-event-id': 'evt_Fresh000002' }))).toEqual({ status: 200, outcome: 'duplicate' });
  });

  it('refuses an event older than 16 days (recorded, nothing applied), and one more than 5 minutes ahead', async () => {
    const rig = getRig();
    const { accountId, id } = await subscribed(rig);
    const before = await onlySubscription(getDb(), accountId);
    rig.clock.advance({ days: 1 });
    const now = rig.clock.now();
    // Razorpay's created_at is in whole seconds; at a whole-second now, the bounds are exact.
    expect(now.getTime() % 1000).toBe(0);
    expect(await post(rig, signed(eventBody('subscription.cancelled', id, new Date(now.getTime() - 16 * DAY - 1000))))).toEqual({ status: 200, outcome: 'too_old' });
    expect(await post(rig, signed(eventBody('subscription.cancelled', id, new Date(now.getTime() + 5 * 60_000 + 1000))))).toEqual({ status: 200, outcome: 'too_new' });
    expect(await onlySubscription(getDb(), accountId)).toEqual(before);
    // Exactly on both bounds: applied (16 days old to the second, and 5 minutes ahead).
    expect(await post(rig, signed(eventBody('subscription.charged', id, new Date(now.getTime() - 16 * DAY))))).toMatchObject({ outcome: 'applied' });
    expect(await post(rig, signed(eventBody('subscription.updated', id, new Date(now.getTime() + 5 * 60_000))))).toMatchObject({ outcome: 'applied' });
  });

  it('ignores events that are not about a subscription, after recording them', async () => {
    const rig = getRig();
    rig.clock.advance({ minutes: 1 });
    const body = JSON.stringify({ entity: 'event', event: 'payment.captured', payload: { payment: { entity: { id: 'pay_X' } } }, created_at: Math.floor(rig.clock.now().getTime() / 1000) });
    expect(await post(rig, signed(body))).toEqual({ status: 200, outcome: 'ignored' });
    expect(await post(rig, signed('{"not":"an event"}'))).toEqual({ status: 200, outcome: 'malformed' });
  });
});

describe('the signature', () => {
  it('refuses a bad or missing signature with 401 and records nothing', async () => {
    const rig = getRig();
    const { id } = await subscribed(rig);
    const body = eventBody('subscription.cancelled', id, rig.clock.now());
    const forged = new Request(WEBHOOK_URL, { method: 'POST', headers: { 'x-razorpay-signature': computeRazorpaySignature(body, 'not-the-secret') }, body });
    expect(await post(rig, forged)).toEqual({ status: 401, outcome: 'invalid_signature' });
    expect(await post(rig, new Request(WEBHOOK_URL, { method: 'POST', body }))).toEqual({ status: 401, outcome: 'invalid_signature' });
    expect(await webhookRows(rig)).toHaveLength(1);
  });
});

describe('fetch-and-apply only if newer (D-19)', () => {
  it('a read older than the stored one changes nothing', async () => {
    const rig = getRig();
    const { accountId, id } = await subscribed(rig);
    // A newer read was applied a minute from now (e.g. by a concurrent delivery).
    const later = new Date(rig.clock.now().getTime() + 60_000);
    await getDb().query(`update subscriptions set last_synced_at = $2 where account_id = $1`, [accountId, later]);
    rig.fakes.billing.cancel(id);
    expect(await deliverQueued(rig)).toEqual([{ status: 200, outcome: 'not_newer' }]);
    expect(await onlySubscription(getDb(), accountId)).toMatchObject({ status: 'authenticated', lastSyncedAt: later });
  });

  it('the event is only a trigger: the state applied is what Razorpay says now', async () => {
    const rig = getRig();
    const { accountId, id } = await subscribed(rig);
    rig.clock.advance({ days: 14 });
    rig.fakes.billing.sync();
    const [activated] = rig.fakes.billing.takeWebhooks();
    // Cancelled since; the late `activated` event applies the cancellation it reads.
    rig.fakes.billing.cancel(id);
    rig.fakes.billing.takeWebhooks();
    expect(await deliver(rig, activated === undefined ? [] : [activated])).toEqual([{ status: 200, outcome: 'applied' }]);
    expect(await onlySubscription(getDb(), accountId)).toMatchObject({ status: 'cancelled' });
  });
});

describe('a second live subscription for the same account', () => {
  it('cancels the newer one at once and alerts the admin', async () => {
    const rig = getRig();
    const { accountId, id } = await subscribed(rig);
    // Something unexpected: a second subscription for the same account went live too.
    const second = await rig.fakes.billing.createSubscription({
      planId: 'plan_fakeonly',
      totalCount: 120,
      quantity: 1,
      customerNotify: true,
      expireBy: new Date(rig.clock.now().getTime() + DAY),
      notes: { autopilot_account_id: accountId },
    });
    rig.clock.advance({ minutes: 1 });
    await insertSubscription(getDb(), { accountId, providerId: second.id, status: 'created', createdAt: rig.clock.now(), shortUrl: second.shortUrl });
    await getDb().query(`update subscriptions set status = 'stale' where provider_subscription_id = $1`, [second.id]);
    rig.fakes.billing.authenticate(second.id);
    rig.clock.advance({ minutes: 1 });
    await deliverQueued(rig);

    const rows = await subscriptions(getDb(), accountId);
    expect(rows.map((row) => [row.providerSubscriptionId, row.status])).toEqual([
      [id, 'authenticated'],
      [second.id, 'cancelled'],
    ]);
    expect((await rig.fakes.billing.fetchSubscription(second.id)).status).toBe('cancelled');
    expect(alertCodes(rig)).toContain('billing_second_live_subscription');
  });

  it('after the trial, the cancelled newer row never hides the older one that pays (D-81): the account stays active', async () => {
    const rig = getRig();
    const { accountId, scope, id } = await (async () => {
      const seeded = await seedBillingAccount(rig);
      await startCheckout(rig.deps, seeded.scope);
      const first = rig.fakes.billing.subscriptionIds()[0] ?? '';
      rig.fakes.billing.authenticate(first);
      await deliverQueued(rig);
      return { ...seeded, id: first };
    })();
    const second = await rig.fakes.billing.createSubscription({
      planId: 'plan_fakeonly',
      totalCount: 120,
      quantity: 1,
      customerNotify: true,
      expireBy: new Date(rig.clock.now().getTime() + DAY),
      notes: { autopilot_account_id: accountId },
    });
    rig.clock.advance({ minutes: 1 });
    await insertSubscription(getDb(), { accountId, providerId: second.id, status: 'stale', createdAt: rig.clock.now(), shortUrl: second.shortUrl });
    rig.fakes.billing.authenticate(second.id);
    rig.clock.advance({ minutes: 1 });
    await deliverQueued(rig);
    expect((await subscriptions(getDb(), accountId)).map((row) => row.status)).toEqual(['authenticated', 'cancelled']);

    // The trial ends; the older subscription starts billing.
    rig.clock.advance({ days: 14 });
    rig.fakes.billing.sync();
    await deliverQueued(rig);
    const applied = await applyProcessingState(rig.deps, accountId);
    expect(applied).toMatchObject({ next: 'active', entitled: true });
    expect(await accountState(getDb(), accountId)).toMatchObject({ processing_state: 'active', entitlement_lost_at: null });
    expect(billingEmails(rig)).toHaveLength(0);
    expect((await subscriptions(getDb(), accountId)).map((row) => [row.providerSubscriptionId, row.status])).toEqual([
      [id, 'active'],
      [second.id, 'cancelled'],
    ]);
    // The billing page shows the older, paying subscription as the current one.
    expect(await billingPageView(rig.deps, scope)).toMatchObject({ processingState: 'active', subscription: { status: 'active' }, action: 'cancel' });
  });
});

describe('subscriptions with no row', () => {
  async function tombstone(rig: BillingRig, status: string, resolved = false): Promise<string> {
    const sub = await rig.fakes.billing.createSubscription({
      planId: 'plan_fakeonly',
      totalCount: 120,
      quantity: 1,
      customerNotify: true,
      startAt: new Date(rig.clock.now().getTime() + 5 * DAY),
      expireBy: new Date(rig.clock.now().getTime() + 4 * DAY),
      notes: {},
    });
    await getDb().query(
      `insert into billing_tombstones (provider_subscription_id, last_status, expire_by, purged_at, resolved_at) values ($1, $2, $3, $4, $5)`,
      [sub.id, status, sub.expireBy ?? null, rig.clock.now(), resolved ? rig.clock.now() : null],
    );
    return sub.id;
  }

  async function tombstoneRow(rig: BillingRig, id: string) {
    return getDb().one<{ last_status: string; last_checked_at: Date | null; resolved_at: Date | null }>(
      `select last_status, last_checked_at, resolved_at from billing_tombstones where provider_subscription_id = $1`,
      [id],
    );
  }

  it('a tombstoned subscription that went live is cancelled at once and the admin alerted to refund', async () => {
    const rig = getRig();
    const id = await tombstone(rig, 'created');
    rig.fakes.billing.authenticate(id);
    rig.clock.advance({ minutes: 1 });
    expect(await deliverQueued(rig)).toEqual([{ status: 200, outcome: 'tombstone_cancelled' }]);
    expect((await rig.fakes.billing.fetchSubscription(id)).status).toBe('cancelled');
    expect(await tombstoneRow(rig, id)).toMatchObject({ last_status: 'cancelled', resolved_at: rig.clock.now() });
    expect(alertCodes(rig)).toContain('billing_tombstone_cancelled_refund');
  });

  it('a terminal one is resolved; a resolved one is left alone', async () => {
    const rig = getRig();
    const id = await tombstone(rig, 'authenticated');
    rig.fakes.billing.authenticate(id);
    rig.fakes.billing.cancel(id);
    rig.fakes.billing.takeWebhooks();
    rig.clock.advance({ minutes: 1 });
    expect(await post(rig, signed(eventBody('subscription.cancelled', id, rig.clock.now())))).toEqual({ status: 200, outcome: 'tombstone_resolved' });
    expect(await tombstoneRow(rig, id)).toMatchObject({ last_status: 'cancelled', resolved_at: rig.clock.now() });
    const resolvedId = await tombstone(rig, 'cancelled', true);
    expect(await post(rig, signed(eventBody('subscription.updated', resolvedId, rig.clock.now())))).toEqual({ status: 200, outcome: 'tombstone_resolved' });
  });

  it('a tombstoned subscription that went live but cannot be cancelled stays open (never resolved) and the admin is alerted', async () => {
    const rig = getRig();
    const id = await tombstone(rig, 'created');
    rig.fakes.billing.authenticate(id);
    rig.fakes.billing.injectFailure('cancelSubscription', 'permanent');
    rig.clock.advance({ minutes: 1 });
    expect(await deliverQueued(rig)).toEqual([{ status: 200, outcome: 'tombstone_cancel_failed' }]);
    expect(await tombstoneRow(rig, id)).toEqual({ last_status: 'authenticated', last_checked_at: rig.clock.now(), resolved_at: null });
    expect(alertCodes(rig)).toContain('billing_tombstone_cancel_failed');
    expect((await rig.fakes.billing.fetchSubscription(id)).status).toBe('authenticated');
  });

  it('a resolved tombstone is read again when a live-subscription event arrives, re-opened and cancelled (D-82)', async () => {
    const rig = getRig();
    // Resolved by mistake (e.g. from a local status that said nothing about Razorpay), but live.
    const id = await tombstone(rig, 'stale', true);
    rig.fakes.billing.authenticate(id);
    rig.clock.advance({ minutes: 1 });
    expect(await deliverQueued(rig)).toEqual([{ status: 200, outcome: 'tombstone_cancelled' }]);
    expect((await rig.fakes.billing.fetchSubscription(id)).status).toBe('cancelled');
    expect(alertCodes(rig)).toContain('billing_tombstone_cancelled_refund');
    // Razorpay's own `cancelled` event after our cancel: resolved, answered without another read.
    expect(await deliverQueued(rig)).toEqual([{ status: 200, outcome: 'tombstone_resolved' }]);

    // If that cancel fails, the tombstone is re-opened so the daily reconcile keeps at it.
    const other = await tombstone(rig, 'stale', true);
    rig.fakes.billing.authenticate(other);
    rig.fakes.billing.injectFailure('cancelSubscription', 'transient');
    rig.clock.advance({ minutes: 1 });
    expect(await deliverQueued(rig)).toEqual([{ status: 200, outcome: 'tombstone_cancel_failed' }]);
    expect(await tombstoneRow(rig, other)).toEqual({ last_status: 'authenticated', last_checked_at: rig.clock.now(), resolved_at: null });
  });

  it('a paused or pending one stays open and is checked again later', async () => {
    const rig = getRig();
    const id = await tombstone(rig, 'created');
    rig.fakes.billing.authenticate(id);
    rig.clock.advance({ days: 5 });
    rig.fakes.billing.sync();
    rig.fakes.billing.pause(id);
    rig.fakes.billing.takeWebhooks();
    expect(await post(rig, signed(eventBody('subscription.paused', id, rig.clock.now())))).toEqual({ status: 200, outcome: 'tombstone_open' });
    expect(await tombstoneRow(rig, id)).toMatchObject({ last_status: 'paused', last_checked_at: rig.clock.now(), resolved_at: null });
  });

  it('an unknown subscription (no row, no tombstone) gets a 200 and an admin warning', async () => {
    const rig = getRig();
    rig.clock.advance({ minutes: 1 });
    expect(await post(rig, signed(eventBody('subscription.activated', 'sub_NotOurs000001', rig.clock.now())))).toEqual({ status: 200, outcome: 'unknown_subscription' });
    expect(alertCodes(rig)).toEqual(['billing_webhook_unknown_subscription']);
  });

  it('a purged account never errors: its subscription row is gone with it, its tombstone answers', async () => {
    const rig = getRig();
    const { accountId, id } = await subscribed(rig);
    await getDb().query(`insert into billing_tombstones (provider_subscription_id, last_status, purged_at) values ($1, 'authenticated', $2)`, [id, rig.clock.now()]);
    await getDb().query(`delete from accounts where id = $1`, [accountId]);
    rig.clock.advance({ days: 14 });
    rig.fakes.billing.sync();
    const results = await deliverQueued(rig);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results[0]?.outcome).toBe('tombstone_cancelled');
    expect(results[1]?.outcome).toBe('tombstone_resolved');
  });
});

describe('when Razorpay cannot be read', () => {
  it('a transient failure answers 503 and forgets the delivery, so the retry is applied', async () => {
    const rig = getRig();
    const { accountId, id } = await subscribed(rig);
    rig.fakes.billing.cancel(id);
    const queued: FakeRazorpayWebhook[] = rig.fakes.billing.takeWebhooks();
    rig.fakes.billing.injectFailure('fetchSubscription', 'transient');
    expect(await deliver(rig, queued)).toEqual([{ status: 503, outcome: 'retry_later' }]);
    expect(await onlySubscription(getDb(), accountId)).toMatchObject({ status: 'authenticated' });
    expect(await deliver(rig, queued)).toEqual([{ status: 200, outcome: 'applied' }]);
    expect(await onlySubscription(getDb(), accountId)).toMatchObject({ status: 'cancelled' });
  });

  it('a permanent refusal is recorded, alerted and answered 200', async () => {
    const rig = getRig();
    const { id } = await subscribed(rig);
    rig.fakes.billing.cancel(id);
    rig.fakes.billing.injectFailure('fetchSubscription', 'permanent');
    expect(await deliverQueued(rig)).toEqual([{ status: 200, outcome: 'fetch_refused' }]);
    expect(alertCodes(rig)).toContain('billing_webhook_fetch_refused');
  });

  it('a configuration error is retried (503) and alerted', async () => {
    const rig = getRig();
    const { id } = await subscribed(rig);
    rig.fakes.billing.cancel(id);
    rig.fakes.billing.injectFailure('fetchSubscription', 'config');
    expect(await deliverQueued(rig)).toEqual([{ status: 503, outcome: 'retry_later' }]);
    expect(alertCodes(rig)).toContain('billing_razorpay_config');
  });
});
