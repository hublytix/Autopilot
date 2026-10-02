import { describe, expect, it } from 'vitest';
import { BILLING_LOCK_MS, runBillingControl, startCheckout, takeBillingLock } from '@/server/services/billing';
import { openCheckoutLink } from '@/server/views/billing';
import { useTestDb as setUpTestDb } from '../db/harness';
import { accountState, alertCodes, DAY, deliverQueued, insertSubscription, onlySubscription, seedBillingAccount, subscriptions, setUpBillingRig } from './support';

// Checkout (PLAN §9.9, D-18, D-20) over PGlite and FakeBilling: the lock, the guard per status, reuse,
// the stale-`created` resolution (abandoned on trial day 2, still `created` on day 10 → stale → a new
// checkout), the start_at/expire_by rule as Razorpay receives it, and failures.

const getDb = setUpTestDb();
const getRig = setUpBillingRig(getDb);

describe('a first checkout', () => {
  it('creates the subscription D-20 describes and stores it with its link', async () => {
    const rig = getRig();
    const { accountId, scope } = await seedBillingAccount(rig);
    const trialEnds = new Date(rig.clock.now().getTime() + 14 * DAY);
    rig.clock.advance({ days: 2 });
    const now = rig.clock.now();

    const outcome = await startCheckout(rig.deps, scope);
    const row = await onlySubscription(getDb(), accountId);
    expect(outcome).toEqual({ type: 'checkout', link: rig.fakes.billing.checkoutUrl(row.providerSubscriptionId), reused: false });

    const sent = rig.fakes.billing.snapshot().subscriptions[0];
    expect(sent).toMatchObject({
      planId: 'plan_fakeonly',
      status: 'created',
      totalCount: 120,
      quantity: 1,
      customerNotify: true,
      notes: { autopilot_account_id: accountId },
      // 12 days of trial left: billing starts when it ends; the link lasts 7 days.
      startAtMs: trialEnds.getTime(),
      expireByMs: now.getTime() + 7 * DAY,
    });
    expect(row).toMatchObject({
      status: 'created',
      planId: 'plan_fakeonly',
      shortUrl: outcome.type === 'checkout' ? outcome.link : null,
      startAt: trialEnds,
      expireBy: new Date(now.getTime() + 7 * DAY),
      statusChangedAt: now,
      lastSyncedAt: now,
      createdAt: now,
      cancelAtCycleEnd: false,
    });
    // Nothing about the account changed: the trial still entitles it; the lock is released.
    expect(await accountState(getDb(), accountId)).toEqual({ processing_state: 'active', entitlement_lost_at: null, checkout_lock_until: null });
  });

  it('ends the link 60 s before billing starts when the trial ends within the week', async () => {
    const rig = getRig();
    const { scope } = await seedBillingAccount(rig);
    const trialEnds = new Date(rig.clock.now().getTime() + 14 * DAY);
    rig.clock.advance({ days: 10 });
    await startCheckout(rig.deps, scope);
    expect(rig.fakes.billing.snapshot().subscriptions[0]).toMatchObject({ startAtMs: trialEnds.getTime(), expireByMs: trialEnds.getTime() - 60_000 });
  });

  it('charges at once (no start_at) with a day or less of trial left, and after the trial', async () => {
    const rig = getRig();
    const { scope } = await seedBillingAccount(rig);
    rig.clock.advance({ days: 13 });
    await startCheckout(rig.deps, scope);
    expect(rig.fakes.billing.snapshot().subscriptions[0]).toMatchObject({ startAtMs: null, expireByMs: rig.clock.now().getTime() + 7 * DAY });
  });
});

describe('the checkout guard', () => {
  it.each(['authenticated', 'active', 'pending', 'halted', 'paused'] as const)('a %s subscription blocks a second checkout and creates nothing', async (status) => {
    const rig = getRig();
    const { accountId, scope } = await seedBillingAccount(rig);
    await insertSubscription(getDb(), { accountId, providerId: 'sub_Existing0001', status, createdAt: rig.clock.now(), shortUrl: 'https://rzp.io/i/old' });
    expect(await startCheckout(rig.deps, scope)).toEqual({ type: 'blocked', status });
    expect(rig.fakes.billing.subscriptionIds()).toHaveLength(0);
    expect(await subscriptions(getDb(), accountId)).toHaveLength(1);
  });

  it.each(['expired', 'cancelled', 'completed', 'stale'] as const)('a %s subscription never blocks', async (status) => {
    const rig = getRig();
    const { accountId, scope } = await seedBillingAccount(rig);
    await insertSubscription(getDb(), { accountId, providerId: 'sub_Existing0001', status, createdAt: rig.clock.now() });
    rig.clock.advance({ minutes: 1 });
    expect(await startCheckout(rig.deps, scope)).toMatchObject({ type: 'checkout', reused: false });
    expect(await subscriptions(getDb(), accountId)).toHaveLength(2);
  });

  it('reuses an open checkout\'s link instead of creating another', async () => {
    const rig = getRig();
    const { accountId, scope } = await seedBillingAccount(rig);
    const first = await startCheckout(rig.deps, scope);
    rig.clock.advance({ days: 3 });
    expect(await startCheckout(rig.deps, scope)).toEqual(first.type === 'checkout' ? { ...first, reused: true } : first);
    expect(rig.fakes.billing.subscriptionIds()).toHaveLength(1);
    expect(await subscriptions(getDb(), accountId)).toHaveLength(1);
  });
});

describe('a created subscription that can no longer be reused', () => {
  it('abandoned on trial day 2, still created on day 10 → stale → a new checkout', async () => {
    const rig = getRig();
    const { accountId, scope } = await seedBillingAccount(rig);
    const trialEnds = new Date(rig.clock.now().getTime() + 14 * DAY);
    rig.clock.advance({ days: 2 });
    const first = await startCheckout(rig.deps, scope);
    // The owner never pays. Day 10: the link expired on day 9, Razorpay still says `created`.
    rig.clock.advance({ days: 8 });
    expect((await rig.fakes.billing.fetchSubscription(rig.fakes.billing.subscriptionIds()[0] ?? '')).status).toBe('created');

    // Subscribe again: 303 to our continue page, which now hands out the new link.
    expect(await runBillingControl(rig.deps, scope, 'checkout')).toBe('/dashboard/billing/checkout');
    const link = await openCheckoutLink(rig.deps, scope);
    expect(link).not.toBeNull();
    expect(first).toMatchObject({ type: 'checkout' });
    expect(link).not.toBe(first.type === 'checkout' ? first.link : null);
    expect(rig.fakes.billing.subscriptionIds()).toHaveLength(2);
    const [old, fresh] = await subscriptions(getDb(), accountId);
    expect(old).toMatchObject({ status: 'stale', statusChangedAt: rig.clock.now() });
    expect(fresh).toMatchObject({ status: 'created', startAt: trialEnds, expireBy: new Date(trialEnds.getTime() - 60_000) });
    expect(await accountState(getDb(), accountId)).toMatchObject({ processing_state: 'active' });
  });

  it('marks it stale when Razorpay cannot be read', async () => {
    const rig = getRig();
    const { accountId, scope } = await seedBillingAccount(rig);
    await startCheckout(rig.deps, scope);
    rig.clock.advance({ days: 8 });
    rig.fakes.billing.injectFailure('fetchSubscription', 'transient');
    expect(await startCheckout(rig.deps, scope)).toMatchObject({ type: 'checkout', reused: false });
    expect((await subscriptions(getDb(), accountId)).map((row) => row.status)).toEqual(['stale', 'created']);
  });

  it('applies what Razorpay says when it moved on: an authorised one blocks the new checkout', async () => {
    const rig = getRig();
    const { accountId, scope } = await seedBillingAccount(rig);
    await startCheckout(rig.deps, scope);
    const id = rig.fakes.billing.subscriptionIds()[0] ?? '';
    rig.clock.advance({ days: 6, hours: 23 });
    rig.fakes.billing.authenticate(id);
    rig.fakes.billing.takeWebhooks(); // the webhook is late: our row still says created
    rig.clock.advance({ hours: 2 });

    expect(await startCheckout(rig.deps, scope)).toEqual({ type: 'blocked', status: 'authenticated' });
    expect(await onlySubscription(getDb(), accountId)).toMatchObject({ status: 'authenticated' });
    expect(rig.fakes.billing.subscriptionIds()).toHaveLength(1);
  });

  it('applies an expiry Razorpay reports (start_at passed) and creates a new one', async () => {
    const rig = getRig();
    const { accountId, scope } = await seedBillingAccount(rig);
    rig.clock.advance({ days: 10 });
    await startCheckout(rig.deps, scope);
    rig.clock.advance({ days: 5 });
    expect(await startCheckout(rig.deps, scope)).toMatchObject({ type: 'checkout', reused: false });
    expect((await subscriptions(getDb(), accountId)).map((row) => row.status)).toEqual(['expired', 'created']);
  });
});

describe('the checkout lock', () => {
  it('a second checkout while one holds the lock is busy, and nothing is created', async () => {
    const rig = getRig();
    const { accountId, scope } = await seedBillingAccount(rig);
    const until = await takeBillingLock(getDb(), accountId, rig.clock.now());
    expect(until).toEqual(new Date(rig.clock.now().getTime() + BILLING_LOCK_MS));
    expect(await startCheckout(rig.deps, scope)).toEqual({ type: 'busy' });
    expect(rig.fakes.billing.subscriptionIds()).toHaveLength(0);
  });

  it('a crashed holder\'s lock lapses after 30 s', async () => {
    const rig = getRig();
    const { scope, accountId } = await seedBillingAccount(rig);
    await takeBillingLock(getDb(), accountId, rig.clock.now());
    rig.clock.advance({ seconds: 29 });
    expect(await startCheckout(rig.deps, scope)).toEqual({ type: 'busy' });
    rig.clock.advance({ seconds: 1 });
    expect(await startCheckout(rig.deps, scope)).toMatchObject({ type: 'checkout' });
    expect((await accountState(getDb(), accountId)).checkout_lock_until).toBeNull();
  });

  it('is released when the checkout fails', async () => {
    const rig = getRig();
    const { accountId, scope } = await seedBillingAccount(rig);
    rig.fakes.billing.injectFailure('createSubscription', 'transient');
    expect(await startCheckout(rig.deps, scope)).toEqual({ type: 'unavailable' });
    expect((await accountState(getDb(), accountId)).checkout_lock_until).toBeNull();
    expect(await subscriptions(getDb(), accountId)).toHaveLength(0);
    expect(alertCodes(rig)).toEqual([]);
  });
});

describe('failures', () => {
  it('a configuration error (wrong key pair or plan) is unavailable and alerts the admin', async () => {
    const rig = getRig();
    const { scope } = await seedBillingAccount(rig);
    rig.fakes.billing.injectFailure('createSubscription', 'config');
    expect(await startCheckout(rig.deps, scope)).toEqual({ type: 'unavailable' });
    expect(alertCodes(rig)).toEqual(['billing_checkout_failed']);
  });

  it('a checkout becomes entitlement only through Razorpay: authorising it and delivering the webhook', async () => {
    const rig = getRig();
    const { accountId, scope } = await seedBillingAccount(rig);
    await startCheckout(rig.deps, scope);
    rig.fakes.billing.authenticate(rig.fakes.billing.subscriptionIds()[0] ?? '');
    expect(await deliverQueued(rig)).toEqual([{ status: 200, outcome: 'applied' }]);
    expect(await onlySubscription(getDb(), accountId)).toMatchObject({ status: 'authenticated' });
  });
});
