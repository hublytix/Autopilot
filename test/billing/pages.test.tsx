import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Deps } from '@/server/ports';
import type { RefreshedSession } from '@/server/ports/auth';
import type { OwnerScope } from '@/server/services/auth/owner-scope';
import { startCheckout } from '@/server/services/billing';
import { useTestDb as setUpTestDb } from '../db/harness';
import { deliverQueued, insertSubscription, seedBillingAccount, setUpBillingRig, type BillingRig } from './support';

// The billing pages rendered over PGlite with the real read model (PLAN §7.5, §9.9): only the session
// guard, the container and Next's navigation are stubbed. One action per state (Subscribe, Update
// payment method, Resume, Cancel), the trial's days left, the price, honest status lines, the
// waiting-for-Razorpay card while a checkout is open, and the continue page that hands the owner to
// Razorpay's link (never one from the query). Plus the proxy's private headers and the metadata.

const current: { deps: Deps | null; scope: OwnerScope | null } = { deps: null, scope: null };

class Navigation extends Error {
  constructor(
    readonly kind: 'redirect' | 'not_found',
    readonly path: string | null,
  ) {
    super(kind);
  }
}

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Navigation('redirect', path);
  },
  notFound: () => {
    throw new Navigation('not_found', null);
  },
  useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock('@/server/container', () => ({
  getDeps: async () => {
    if (current.deps === null) throw new Error('no deps');
    return current.deps;
  },
}));
vi.mock('@/server/http/auth/guards', () => ({
  requireOwnerPage: async () => {
    if (current.scope === null) throw new Navigation('redirect', '/login');
    return current.scope;
  },
}));

type Refresh = (request: Request, response: Response) => Promise<RefreshedSession>;
const fakeRefresh = vi.fn<Refresh>();
vi.mock('@/server/adapters/fake/auth/proxy-session', () => ({ checkFakeProxySession: fakeRefresh }));
vi.mock('@/server/adapters/live/auth', () => ({ refreshLiveProxySession: vi.fn() }));

const getDb = setUpTestDb();
const getRig = setUpBillingRig(getDb);

async function billingPage(result?: string): Promise<string> {
  const { default: Page } = await import('@/app/dashboard/billing/page');
  return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(result === undefined ? {} : { result }) }));
}

async function continuePage(): Promise<string> {
  const { default: Page } = await import('@/app/dashboard/billing/checkout/page');
  return renderToStaticMarkup(await Page());
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

async function owned(rig: BillingRig): Promise<string> {
  const { accountId, scope } = await seedBillingAccount(rig);
  current.deps = rig.deps;
  current.scope = scope;
  return accountId;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  current.deps = null;
  current.scope = null;
});

describe('/dashboard/billing', () => {
  it('in the trial with no subscription: days left, the price, Subscribe, and when the first payment is taken', async () => {
    const rig = getRig();
    await owned(rig);
    rig.clock.advance({ days: 4, hours: 1 });
    const html = await billingPage();
    const page = text(html);
    expect(page).toContain('$49/month after your 14-day free trial.');
    expect(page).toContain('Free trial: 10 days left (it ends on 20 Oct 2026).');
    expect(page).toContain('No subscription');
    expect(page).toContain('Subscribe');
    expect(page).toContain('the first $49 payment is taken when your free trial ends on 20 Oct 2026');
    expect(html).toContain('data-action="subscribe"');
    expect(page).not.toContain('Cancel subscription');
  });

  it('with a day or less of trial left, says the first payment is taken at once', async () => {
    const rig = getRig();
    await owned(rig);
    rig.clock.advance({ days: 13, hours: 1 });
    expect(text(await billingPage())).toContain('The first $49 payment is taken when you subscribe.');
  });

  it('while a checkout is open, says it is waiting for Razorpay and offers a manual check', async () => {
    const rig = getRig();
    await owned(rig);
    await startCheckout(rig.deps, current.scope as OwnerScope);
    const page = text(await billingPage());
    expect(page).toContain('Checkout not finished');
    expect(page).toContain('Waiting for Razorpay');
    expect(page).toContain('Check again');
  });

  it('authenticated: subscribed, when the first payment is taken, and Cancel (now, trial kept)', async () => {
    const rig = getRig();
    await owned(rig);
    await startCheckout(rig.deps, current.scope as OwnerScope);
    rig.fakes.billing.authenticate(rig.fakes.billing.subscriptionIds()[0] ?? '');
    await deliverQueued(rig);
    const html = await billingPage();
    const page = text(html);
    expect(html).toContain('data-action="cancel"');
    expect(page).toContain('The first $49 payment is taken on 20 Oct 2026, when your free trial ends.');
    expect(page).toContain('Cancels now: nothing is charged, and your free trial still runs to its end.');
    expect(page).not.toContain('Waiting for Razorpay');
  });

  it('authenticated without a start_at, after the trial: the first payment was taken at sign-up; never "nothing is charged" (laws 3 and 5)', async () => {
    const rig = getRig();
    const accountId = await owned(rig);
    rig.clock.advance({ days: 15 });
    await insertSubscription(getDb(), { accountId, providerId: 'sub_NoStart00001', status: 'authenticated', createdAt: rig.clock.now(), startAt: null });
    const html = await billingPage();
    const page = text(html);
    expect(html).toContain('data-action="cancel"');
    expect(page).toContain('The first $49 payment is taken when you subscribe, not at the end of a free trial.');
    expect(page).toContain("Cancels now: no further payments are taken. Cancelling doesn't refund a payment already taken.");
    expect(page).not.toContain('nothing is charged');
    expect(page).not.toContain('Nothing is charged');
    expect(page).not.toContain('free trial still runs');
    // The cancel result for such a subscription says the same.
    const cancelled = text(await billingPage('cancel.cancelled_after_payment'));
    expect(cancelled).toContain("Subscription cancelled. No further payments are taken; cancelling doesn't refund a payment already taken.");
    expect(cancelled).not.toContain('Nothing is charged');
  });

  it('authenticated whose start_at has passed: says the first payment was due then, not that nothing is charged', async () => {
    const rig = getRig();
    const accountId = await owned(rig);
    await insertSubscription(getDb(), {
      accountId,
      providerId: 'sub_PastStart001',
      status: 'authenticated',
      createdAt: rig.clock.now(),
      startAt: new Date(rig.clock.now().getTime() + 14 * 86_400_000),
    });
    rig.clock.advance({ days: 14, hours: 2 });
    const page = text(await billingPage());
    expect(page).toContain('Your card is set up. The first $49 payment was due on 20 Oct 2026.');
    expect(page).not.toContain('nothing is charged');
  });

  it('reusing an open checkout, says when ITS first payment is taken (the start_at it was created with), not a fresh timing', async () => {
    const rig = getRig();
    await owned(rig);
    // Subscribe with 1.5 days of trial left: the link starts billing at the trial's end.
    rig.clock.advance({ days: 12, hours: 12 });
    await startCheckout(rig.deps, current.scope as OwnerScope);
    // Back with 0.5 days left: a new checkout would charge at once, but Subscribe reuses the open link.
    rig.clock.advance({ days: 1 });
    const page = text(await billingPage());
    expect(page).toContain('Waiting for Razorpay');
    expect(page).toContain('the first $49 payment is taken when your free trial ends on 20 Oct 2026');
    expect(page).not.toContain('The first $49 payment is taken when you subscribe.');
  });

  it('an unknown status: not running, no Subscribe, and where to write for help', async () => {
    const rig = getRig();
    const accountId = await owned(rig);
    rig.clock.advance({ days: 15 });
    await insertSubscription(getDb(), { accountId, providerId: 'sub_Unknown00002', status: 'unknown', createdAt: rig.clock.now() });
    const html = await billingPage('checkout.contact_support');
    const page = text(html);
    expect(html).toContain('data-status="unknown"');
    expect(html).toContain('data-action="none"');
    expect(page).toContain("We can't read your subscription's status");
    expect(page).toContain(`Please contact support at ${rig.deps.env.EMAIL_REPLY_TO}`);
    expect(page).toContain("so we didn't start a new one");
    expect(page).not.toContain('Opening checkout');
  });

  it('pending: the grace end and Update payment method with the stored link', async () => {
    const rig = getRig();
    const accountId = await owned(rig);
    rig.clock.advance({ days: 20 });
    await insertSubscription(getDb(), {
      accountId,
      providerId: 'sub_Pending00001',
      status: 'pending',
      createdAt: rig.clock.now(),
      shortUrl: 'https://rzp.io/i/UpdateCard',
      graceUntil: new Date(rig.clock.now().getTime() + 2 * 86_400_000),
    });
    const html = await billingPage();
    expect(html).toContain('href="https://rzp.io/i/UpdateCard"');
    expect(text(html)).toContain('Update payment method');
    expect(text(html)).toContain('Autopilot keeps running until 28 Oct 2026, 10:00.');
  });

  it('halted without a usable link: no button, says where the link is', async () => {
    const rig = getRig();
    const accountId = await owned(rig);
    await insertSubscription(getDb(), { accountId, providerId: 'sub_Halted000001', status: 'halted', createdAt: rig.clock.now(), shortUrl: 'javascript:alert(1)' });
    const html = await billingPage();
    expect(html).not.toContain('javascript:');
    expect(html).toContain('data-action="none"');
    expect(text(html)).toContain("Use the link in Razorpay's email about the failed payment");
  });

  it('paused: Resume; cancelled: Subscribe again', async () => {
    const rig = getRig();
    const accountId = await owned(rig);
    const id = await insertSubscription(getDb(), { accountId, providerId: 'sub_Paused000001', status: 'paused', createdAt: rig.clock.now() });
    expect(await billingPage()).toContain('data-action="resume"');
    await getDb().query(`update subscriptions set status = 'cancelled' where id = $1`, [id]);
    expect(await billingPage()).toContain('data-action="subscribe"');
  });

  it('active and cancelled at the cycle end: no action, says when it ends', async () => {
    const rig = getRig();
    const accountId = await owned(rig);
    const id = await insertSubscription(getDb(), { accountId, providerId: 'sub_Active000001', status: 'active', createdAt: rig.clock.now() });
    await getDb().query(`update subscriptions set cancel_at_cycle_end = true, current_end = $2 where id = $1`, [id, new Date('2026-11-20T00:00:00Z')]);
    const html = await billingPage();
    expect(html).toContain('data-action="none"');
    expect(text(html)).toContain('Your subscription stays active until 19 Nov 2026, then ends.');
  });

  it('after the trial, says Autopilot is not running and shows the result of an action by its code only', async () => {
    const rig = getRig();
    const accountId = await owned(rig);
    rig.clock.advance({ days: 15 });
    await getDb().query(`update accounts set processing_state = 'inactive' where id = $1`, [accountId]);
    const page = text(await billingPage('cancel.nothing'));
    expect(page).toContain('Your free trial ended on 20 Oct 2026.');
    expect(page).toContain("Autopilot isn't running because your free trial or subscription isn't active");
    expect(page).toContain("You don't have a subscription to cancel.");
    expect(await billingPage('constructor')).toBe(await billingPage());
  });

  it('sends a visitor without an owner session to /login', async () => {
    current.scope = null;
    current.deps = getRig().deps;
    await expect(billingPage()).rejects.toMatchObject({ kind: 'redirect', path: '/login' });
  });
});

describe('/dashboard/billing/checkout', () => {
  it('hands the owner to the open checkout\'s stored link, with a plain link as the fallback', async () => {
    const rig = getRig();
    await owned(rig);
    const outcome = await startCheckout(rig.deps, current.scope as OwnerScope);
    const link = outcome.type === 'checkout' ? outcome.link : '';
    const html = await continuePage();
    expect(html).toContain(`href="${link}"`);
    expect(text(html)).toContain('Continue to Razorpay');
  });

  it('says there is nothing to continue once the checkout has expired', async () => {
    const rig = getRig();
    await owned(rig);
    await startCheckout(rig.deps, current.scope as OwnerScope);
    rig.clock.advance({ days: 8 });
    const page = text(await continuePage());
    expect(page).toContain('No checkout to continue');
    expect(page).not.toContain('Continue to Razorpay');
  });
});

describe('billing response headers and metadata', () => {
  beforeEach(() => {
    vi.stubEnv('APP_MODE', 'fake');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['/dashboard/billing', '/dashboard/billing/checkout', '/api/billing/checkout'])('%s is private, no-store and noindex; without a session it goes to /login', async (path) => {
    const { proxy } = await import('@/proxy');
    fakeRefresh.mockImplementation(async (_req, res) => ({ response: res, user: { userId: 'u-1', email: 'owner@example.com' } }));
    const ok = await proxy(new NextRequest(`http://localhost:3000${path}`));
    expect(ok.headers.get('cache-control')).toBe('private, no-store');
    expect(ok.headers.get('x-robots-tag')).toBe('noindex');
    fakeRefresh.mockImplementation(async (_req, res) => ({ response: res, user: null }));
    const out = await proxy(new NextRequest(`http://localhost:3000${path}`, { method: 'POST' }));
    expect(out.status).toBe(303);
    expect(out.headers.get('location')).toBe('http://localhost:3000/login');
  });

  it('never redirects the Razorpay webhook to /login', async () => {
    const { proxy } = await import('@/proxy');
    fakeRefresh.mockReset();
    fakeRefresh.mockImplementation(async (_req, res) => ({ response: res, user: null }));
    const res = await proxy(new NextRequest('http://localhost:3000/api/razorpay/webhook', { method: 'POST' }));
    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(fakeRefresh).not.toHaveBeenCalled();
  });

  it.each([
    ['@/app/dashboard/billing/page', () => import('@/app/dashboard/billing/page')],
    ['@/app/dashboard/billing/checkout/page', () => import('@/app/dashboard/billing/checkout/page')],
  ] as const)('%s asks robots not to index or follow', async (_name, load) => {
    const { metadata } = await load();
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
