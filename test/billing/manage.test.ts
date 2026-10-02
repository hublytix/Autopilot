import { describe, expect, it } from 'vitest';
import { applyProcessingState } from '@/server/services/accounts';
import { cancelSubscriptionForOwner, resumeSubscriptionForOwner, runBillingControl, startCheckout, takeBillingLock } from '@/server/services/billing';
import { useTestDb as setUpTestDb } from '../db/harness';
import { accountState, alertCodes, billingEmails, deliverQueued, onlySubscription, seedBillingAccount, setUpBillingRig, type BillingRig } from './support';

// Cancel and Resume (PLAN §9.9, D-18, D-20): `authenticated` is cancelled at once and the trial still
// runs to its end; `active` at the end of the cycle (and stays entitled until then); `paused` resumes.

const getDb = setUpTestDb();
const getRig = setUpBillingRig(getDb);

async function authorised(rig: BillingRig) {
  const account = await seedBillingAccount(rig);
  await startCheckout(rig.deps, account.scope);
  const id = rig.fakes.billing.subscriptionIds()[0] ?? '';
  rig.fakes.billing.authenticate(id);
  await deliverQueued(rig);
  return { ...account, id };
}

async function paying(rig: BillingRig) {
  const account = await authorised(rig);
  rig.clock.advance({ days: 14 });
  rig.fakes.billing.sync();
  await deliverQueued(rig);
  return account;
}

describe('cancel', () => {
  it('an authenticated subscription is cancelled now; nothing is charged and the trial runs to its end', async () => {
    const rig = getRig();
    const { accountId, scope, id } = await authorised(rig);
    rig.clock.advance({ days: 3 });
    expect(await cancelSubscriptionForOwner(rig.deps, scope)).toEqual({ type: 'cancelled', beforeFirstPayment: true });
    expect(await onlySubscription(getDb(), accountId)).toMatchObject({ status: 'cancelled', cancelAtCycleEnd: false });
    expect(rig.fakes.billing.snapshot().subscriptions[0]).toMatchObject({ id, status: 'cancelled', paidCount: 0 });
    expect(await accountState(getDb(), accountId)).toMatchObject({ processing_state: 'active' });

    // The trial ends: inactive, one billing email.
    rig.clock.advance({ days: 11 });
    rig.fakes.billing.sync();
    await deliverQueued(rig);
    await applyProcessingState(rig.deps, accountId);
    expect(await accountState(getDb(), accountId)).toMatchObject({ processing_state: 'inactive' });
    expect(billingEmails(rig)).toHaveLength(1);
  });

  it('an authenticated subscription whose first payment is already due is cancelled now, and never told "nothing is charged" (D-82)', async () => {
    const rig = getRig();
    const { accountId, scope } = await authorised(rig);
    // Its start_at (the trial's end) has passed and Razorpay's activation hasn't reached us yet.
    rig.clock.advance({ days: 14, minutes: 5 });
    expect((await onlySubscription(getDb(), accountId)).status).toBe('authenticated');
    expect(await runBillingControl(rig.deps, scope, 'cancel')).toBe('/dashboard/billing?result=cancel.cancelled_after_payment');
    expect(await onlySubscription(getDb(), accountId)).toMatchObject({ status: 'cancelled' });
  });

  it('an active subscription is cancelled at the end of the cycle and stays entitled until then', async () => {
    const rig = getRig();
    const { accountId, scope } = await paying(rig);
    const periodEnd = (await onlySubscription(getDb(), accountId)).currentEnd;
    rig.clock.advance({ days: 5 });
    expect(await cancelSubscriptionForOwner(rig.deps, scope)).toEqual({ type: 'cancel_scheduled' });
    expect(await onlySubscription(getDb(), accountId)).toMatchObject({ status: 'active', cancelAtCycleEnd: true, currentEnd: periodEnd });
    expect(await accountState(getDb(), accountId)).toMatchObject({ processing_state: 'active' });
    expect(await cancelSubscriptionForOwner(rig.deps, scope)).toEqual({ type: 'already_scheduled' });

    // The cycle ends: Razorpay cancels and says so.
    rig.clock.set(new Date((periodEnd ?? rig.clock.now()).getTime() + 60_000));
    rig.fakes.billing.sync();
    await deliverQueued(rig);
    expect(await onlySubscription(getDb(), accountId)).toMatchObject({ status: 'cancelled' });
    expect(await accountState(getDb(), accountId)).toMatchObject({ processing_state: 'inactive' });
    expect(billingEmails(rig)).toHaveLength(1);
  });

  it('with nothing to cancel, changes nothing', async () => {
    const rig = getRig();
    const { scope } = await seedBillingAccount(rig);
    expect(await cancelSubscriptionForOwner(rig.deps, scope)).toEqual({ type: 'nothing_to_cancel' });
  });

  it('a refusal re-reads the subscription so the page shows what Razorpay says', async () => {
    const rig = getRig();
    const { accountId, scope, id } = await authorised(rig);
    // Cancelled at the bank meanwhile; our webhook hasn't arrived yet.
    rig.fakes.billing.cancel(id, { initiatedBy: 'customer' });
    rig.fakes.billing.takeWebhooks();
    rig.clock.advance({ minutes: 1 });
    expect(await cancelSubscriptionForOwner(rig.deps, scope)).toEqual({ type: 'refused' });
    expect(await onlySubscription(getDb(), accountId)).toMatchObject({ status: 'cancelled' });
  });

  it('Razorpay unreachable: unavailable, nothing changed', async () => {
    const rig = getRig();
    const { accountId, scope } = await authorised(rig);
    rig.fakes.billing.injectFailure('cancelSubscription', 'transient');
    expect(await cancelSubscriptionForOwner(rig.deps, scope)).toEqual({ type: 'unavailable' });
    expect(await onlySubscription(getDb(), accountId)).toMatchObject({ status: 'authenticated' });
    expect(alertCodes(rig)).toEqual([]);
  });

  it('waits for another billing action (the lock)', async () => {
    const rig = getRig();
    const { accountId, scope } = await authorised(rig);
    await takeBillingLock(getDb(), accountId, rig.clock.now());
    expect(await cancelSubscriptionForOwner(rig.deps, scope)).toEqual({ type: 'busy' });
    expect(await runBillingControl(rig.deps, scope, 'cancel')).toBe('/dashboard/billing?result=busy');
  });
});

describe('resume', () => {
  it('resumes a paused subscription now; the account runs again', async () => {
    const rig = getRig();
    const { accountId, scope, id } = await paying(rig);
    rig.fakes.billing.pause(id, 'customer');
    await deliverQueued(rig);
    expect(await accountState(getDb(), accountId)).toMatchObject({ processing_state: 'inactive' });

    rig.clock.advance({ hours: 2 });
    expect(await resumeSubscriptionForOwner(rig.deps, scope)).toEqual({ type: 'resumed' });
    expect(await onlySubscription(getDb(), accountId)).toMatchObject({ status: 'active' });
    expect(await accountState(getDb(), accountId)).toMatchObject({ processing_state: 'active', entitlement_lost_at: null });
    // The resume's own webhook is a no-op now (same state, read later).
    await deliverQueued(rig);
    expect(await onlySubscription(getDb(), accountId)).toMatchObject({ status: 'active' });
  });

  it('only a paused subscription resumes', async () => {
    const rig = getRig();
    const { scope } = await paying(rig);
    expect(await resumeSubscriptionForOwner(rig.deps, scope)).toEqual({ type: 'nothing_to_resume' });
  });
});

describe('runBillingControl (the shared body of the actions and the routes)', () => {
  it('sends a checkout to our own continue page, and each outcome to the billing page with its code', async () => {
    const rig = getRig();
    const { scope, accountId } = await seedBillingAccount(rig);
    expect(await runBillingControl(rig.deps, scope, 'checkout')).toBe('/dashboard/billing/checkout');
    expect(await runBillingControl(rig.deps, scope, 'resume')).toBe('/dashboard/billing?result=resume.nothing');
    expect(await runBillingControl(rig.deps, scope, 'cancel')).toBe('/dashboard/billing?result=cancel.nothing');
    rig.fakes.billing.authenticate((await onlySubscription(getDb(), accountId)).providerSubscriptionId);
    await deliverQueued(rig);
    expect(await runBillingControl(rig.deps, scope, 'checkout')).toBe('/dashboard/billing?result=checkout.already_subscribed');
    expect(await runBillingControl(rig.deps, scope, 'cancel')).toBe('/dashboard/billing?result=cancel.cancelled');
  });
});
