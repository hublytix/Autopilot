import { describe, expect, it } from 'vitest';
import { runBillingControl, startCheckout } from '@/server/services/billing';
import { billingPageView, openCheckoutLink } from '@/server/views/billing';
import { useTestDb as setUpTestDb } from '../db/harness';
import { deliverQueued, insertSubscription, seedBillingAccount, setUpBillingRig, subscriptions } from './support';

// Tenant isolation for billing (PLAN §10.8): every billing read and action works on the OwnerScope's
// account only. A's checkout, cancel, resume and pages never read, show or change B's subscription.

const getDb = setUpTestDb();
const getRig = setUpBillingRig(getDb);

describe('billing across two accounts', () => {
  it("A's actions and pages never touch or show B's subscription", async () => {
    const rig = getRig();
    const a = await seedBillingAccount(rig, { email: 'owner-a@example.com' });
    const b = await seedBillingAccount(rig, { email: 'owner-b@example.com' });
    // B is subscribed (authenticated) and also has a paused older subscription with its own link.
    await startCheckout(rig.deps, b.scope);
    const bId = rig.fakes.billing.subscriptionIds()[0] ?? '';
    rig.fakes.billing.authenticate(bId);
    await deliverQueued(rig);
    await insertSubscription(getDb(), { accountId: b.accountId, providerId: 'sub_BPaused00001', status: 'paused', createdAt: new Date(rig.clock.now().getTime() - 1000), shortUrl: 'https://rzp.io/i/BOnly' });
    const before = await subscriptions(getDb(), b.accountId);

    // A has nothing: cancel and resume find nothing; checkout creates A's own; the pages show A's.
    expect(await runBillingControl(rig.deps, a.scope, 'cancel')).toBe('/dashboard/billing?result=cancel.nothing');
    expect(await runBillingControl(rig.deps, a.scope, 'resume')).toBe('/dashboard/billing?result=resume.nothing');
    expect(await runBillingControl(rig.deps, a.scope, 'checkout')).toBe('/dashboard/billing/checkout');
    const aView = await billingPageView(rig.deps, a.scope);
    expect(aView).toMatchObject({ action: 'subscribe', subscription: { status: 'created' } });
    expect(JSON.stringify(aView)).not.toContain('BOnly');
    const aLink = await openCheckoutLink(rig.deps, a.scope);
    expect(aLink).not.toBeNull();
    expect(aLink).not.toContain(bId);

    expect(await subscriptions(getDb(), b.accountId)).toEqual(before);
    expect((await subscriptions(getDb(), a.accountId)).map((row) => row.status)).toEqual(['created']);
    expect((await rig.fakes.billing.fetchSubscription(bId)).status).toBe('authenticated');
  });
});
