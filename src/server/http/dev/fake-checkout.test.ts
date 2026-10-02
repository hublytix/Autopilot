import { describe, expect, it } from 'vitest';
import { startCheckout } from '@/server/services/billing';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import { accountState, onlySubscription, seedBillingAccount, setUpBillingRig, type BillingRig } from '../../../../test/billing/support';
import { buildFakeCheckoutView, handleFakeCheckoutDecision, handleFakeCheckoutDecisionOtherMethod, type FakeCheckoutContext } from './fake-checkout';

// The fake Razorpay checkout (fake mode only, PLAN §4, §7.6): the page's view per status, and the
// decision route that plays the customer on FakeBilling and delivers its signed webhooks to the real
// webhook handler. Outside fake mode (no context) every route is a 404.

const getDb = setUpTestDb();
const getRig = setUpBillingRig(getDb);

function ctx(rig: BillingRig): FakeCheckoutContext {
  return { deps: rig.deps, billing: rig.fakes.billing };
}

function decide(id: string, action: string, headers: Record<string, string> = { origin: 'http://localhost:3000' }): Request {
  return new Request(`http://localhost:3000/dev/fake-checkout/${id}/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ action }).toString(),
  });
}

async function checkout(rig: BillingRig): Promise<{ accountId: string; id: string }> {
  const { accountId, scope } = await seedBillingAccount(rig);
  await startCheckout(rig.deps, scope);
  return { accountId, id: rig.fakes.billing.subscriptionIds()[0] ?? '' };
}

describe('the fake checkout page', () => {
  it('shows the subscription and the customer actions that fit a new checkout', async () => {
    const rig = getRig();
    const { id } = await checkout(rig);
    const view = await buildFakeCheckoutView(id, ctx(rig));
    expect(view).toMatchObject({ id, status: 'created', price: 'USD 49.00 every month', decisionPath: `/dev/fake-checkout/${id}/decision` });
    expect(view?.actions.map((a) => a.action)).toEqual(['authorise', 'decline', 'deliver']);
  });

  it('does not exist outside fake mode or for an unknown id', async () => {
    const rig = getRig();
    expect(await buildFakeCheckoutView('sub_Unknown00001', ctx(rig))).toBeNull();
    expect(await buildFakeCheckoutView('../etc', ctx(rig))).toBeNull();
    expect(await buildFakeCheckoutView('sub_Unknown00001', null)).toBeNull();
  });
});

describe('POST /dev/fake-checkout/{id}/decision', () => {
  it('authorise: FakeBilling authenticates and the signed webhook reaches the real handler', async () => {
    const rig = getRig();
    const { accountId, id } = await checkout(rig);
    const res = await handleFakeCheckoutDecision(decide(id, 'authorise'), id, ctx(rig));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/dev/fake-checkout/${id}?done=authorise&delivered=1&failed=0`);
    expect(await onlySubscription(getDb(), accountId)).toMatchObject({ status: 'authenticated' });
    expect(await getDb().query(`select outcome from webhook_events where provider = 'razorpay'`)).toEqual([{ outcome: 'applied' }]);
  });

  it('decline: the subscription stays created and nothing is delivered (Razorpay sends no webhook)', async () => {
    const rig = getRig();
    const { accountId, id } = await checkout(rig);
    const res = await handleFakeCheckoutDecision(decide(id, 'decline'), id, ctx(rig));
    expect(res.headers.get('location')).toBe(`/dev/fake-checkout/${id}?done=decline&delivered=0&failed=0`);
    expect(await onlySubscription(getDb(), accountId)).toMatchObject({ status: 'created' });
  });

  it('plays Razorpay too: billing starts, a renewal fails, retries run out', async () => {
    const rig = getRig();
    const { accountId, id } = await checkout(rig);
    await handleFakeCheckoutDecision(decide(id, 'authorise'), id, ctx(rig));
    await handleFakeCheckoutDecision(decide(id, 'start_billing'), id, ctx(rig));
    expect(await onlySubscription(getDb(), accountId)).toMatchObject({ status: 'active' });
    rig.clock.advance({ days: 15 });
    await handleFakeCheckoutDecision(decide(id, 'fail_renewal'), id, ctx(rig));
    expect(await onlySubscription(getDb(), accountId)).toMatchObject({ status: 'pending' });
    await handleFakeCheckoutDecision(decide(id, 'retries_exhausted'), id, ctx(rig));
    expect(await onlySubscription(getDb(), accountId)).toMatchObject({ status: 'halted' });
    expect(await accountState(getDb(), accountId)).toMatchObject({ processing_state: 'inactive' });
  });

  it('refuses an action that does not fit the status (409), an unknown action (400) and a cross-site post (403)', async () => {
    const rig = getRig();
    const { id } = await checkout(rig);
    expect((await handleFakeCheckoutDecision(decide(id, 'resume'), id, ctx(rig))).status).toBe(409);
    expect((await handleFakeCheckoutDecision(decide(id, 'pay_twice'), id, ctx(rig))).status).toBe(400);
    expect((await handleFakeCheckoutDecision(decide(id, 'authorise', { origin: 'https://evil.example' }), id, ctx(rig))).status).toBe(403);
    expect(rig.fakes.billing.snapshot().subscriptions[0]?.status).toBe('created');
  });

  it('is a 404 outside fake mode and for an unknown subscription; other methods are 405', async () => {
    const rig = getRig();
    expect((await handleFakeCheckoutDecision(decide('sub_X1', 'authorise'), 'sub_X1', null)).status).toBe(404);
    expect((await handleFakeCheckoutDecision(decide('sub_Unknown00001', 'authorise'), 'sub_Unknown00001', ctx(rig))).status).toBe(404);
    expect(handleFakeCheckoutDecisionOtherMethod(null).status).toBe(404);
    expect(handleFakeCheckoutDecisionOtherMethod(ctx(rig)).status).toBe(405);
  });
});

describe('the decision form', () => {
  it('accepts the action as a multipart form too (the clicked button of any browser form)', async () => {
    const rig = getRig();
    const { accountId, id } = await checkout(rig);
    const form = new FormData();
    form.set('action', 'authorise');
    const req = new Request(`http://localhost:3000/dev/fake-checkout/${id}/decision`, { method: 'POST', headers: { origin: 'http://localhost:3000' }, body: form });
    expect((await handleFakeCheckoutDecision(req, id, ctx(rig))).status).toBe(303);
    expect(await onlySubscription(getDb(), accountId)).toMatchObject({ status: 'authenticated' });
  });
});
