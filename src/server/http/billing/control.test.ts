import { describe, expect, it } from 'vitest';
import { CookieJar } from '@/server/security/cookies';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import { onlySubscription, seedBillingAccount, setUpBillingRig, type BillingRig } from '../../../../test/billing/support';
import { handleBillingControl, handleBillingControlOtherMethod } from './control';

// POST /api/billing/checkout, /resume and /cancel (PLAN §7.3: owner + origin) with real Requests and
// a cookie jar: cross-site posts change nothing, no session goes to /login, and a checkout lands on
// our own continue page (never a redirect to Razorpay from the form POST: CSP form-action 'self').

const getDb = setUpTestDb();
const getRig = setUpBillingRig(getDb);

async function signedIn(rig: BillingRig): Promise<{ accountId: string; jar: CookieJar }> {
  const { userId } = await rig.fakes.auth.createUser('owner@brightside-plumbing.example');
  const { accountId } = await seedBillingAccount(rig, { authUserId: userId });
  const jar = new CookieJar();
  jar.set([rig.fakes.auth.issueSession(userId)]);
  return { accountId, jar };
}

function post(rig: BillingRig, jar: CookieJar, path: string, headers: Record<string, string> = { origin: 'http://localhost:3000' }): Request {
  return jar.request(`${rig.deps.env.APP_URL}${path}`, { method: 'POST', headers });
}

describe('billing route handlers', () => {
  it('checkout: 303 to our own continue page, and the subscription exists', async () => {
    const rig = getRig();
    const { accountId, jar } = await signedIn(rig);
    const res = await handleBillingControl(post(rig, jar, '/api/billing/checkout'), rig.deps, 'checkout');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('http://localhost:3000/dashboard/billing/checkout');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await onlySubscription(getDb(), accountId)).toMatchObject({ status: 'created' });
  });

  it('cancel and resume come back to the billing page with their outcome', async () => {
    const rig = getRig();
    const { jar } = await signedIn(rig);
    const cancel = await handleBillingControl(post(rig, jar, '/api/billing/cancel'), rig.deps, 'cancel');
    expect(cancel.headers.get('location')).toBe('http://localhost:3000/dashboard/billing?result=cancel.nothing');
    const resume = await handleBillingControl(post(rig, jar, '/api/billing/resume'), rig.deps, 'resume');
    expect(resume.headers.get('location')).toBe('http://localhost:3000/dashboard/billing?result=resume.nothing');
  });

  it('accepts Sec-Fetch-Site: same-origin without an Origin', async () => {
    const rig = getRig();
    const { jar } = await signedIn(rig);
    const res = await handleBillingControl(post(rig, jar, '/api/billing/checkout', { 'sec-fetch-site': 'same-origin' }), rig.deps, 'checkout');
    expect(res.headers.get('location')).toBe('http://localhost:3000/dashboard/billing/checkout');
  });

  it('refuses a cross-site post with a 403 page and changes nothing', async () => {
    const rig = getRig();
    const { accountId, jar } = await signedIn(rig);
    for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, {}]) {
      const res = await handleBillingControl(post(rig, jar, '/api/billing/checkout', headers), rig.deps, 'checkout');
      expect(res.status).toBe(403);
      expect(res.headers.get('content-type')).toContain('text/html');
    }
    expect(await getDb().query(`select id from subscriptions where account_id = $1`, [accountId])).toHaveLength(0);
  });

  it('sends a request without an owner session to /login', async () => {
    const rig = getRig();
    const res = await handleBillingControl(post(rig, new CookieJar(), '/api/billing/checkout'), rig.deps, 'checkout');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('http://localhost:3000/login');
    expect(rig.fakes.billing.subscriptionIds()).toHaveLength(0);
  });

  it('answers any other method with the billing page', () => {
    const rig = getRig();
    const res = handleBillingControlOtherMethod(rig.deps);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('http://localhost:3000/dashboard/billing');
  });
});
