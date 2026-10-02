// The owner's billing and settings steps as the M7 variants drive them, through the same route
// handlers, read models and action bodies the pages use, in the owner's browser (the session the
// pre-run's /auth/confirm set, refreshed by the proxy on every owner page). No step records a
// Razorpay or database id: subscription ids are random, so they would make summary.json differ.
import { bannerCopy } from '@/app/dashboard/copy';
import { FAKE_CHECKOUT_PATH, buildFakeCheckoutView, handleFakeCheckoutDecision } from '@/server/http/dev/fake-checkout';
import { handleBillingControl } from '@/server/http/billing';
import { BILLING_CHECKOUT_PATH, BILLING_PATH, billingPageView, openCheckoutLink, type BillingPageView } from '@/server/views/billing';
import type { OwnerScope } from '@/server/services/auth';
import { dashboardView, type DashboardView } from '@/server/views/dashboard';
import { DESKTOP_UA, OWNER_IP } from './owner-browser';
import { ownerPageScope } from './owner-session';
import type { Simulation } from './types';

/** A form POST from the owner's browser on our own origin (what a page's <form> sends). */
export function ownerFormPost(sim: Simulation, path: string, fields: Readonly<Record<string, string>>): Request {
  const jar = sim.scenario.ownerJar;
  if (jar === null) throw new Error('simulation: the owner has no browser yet');
  const appUrl = sim.deps.env.APP_URL;
  return jar.request(`${appUrl}${path}`, {
    method: 'POST',
    headers: { origin: new URL(appUrl).origin, 'content-type': 'application/x-www-form-urlencoded', 'x-real-ip': OWNER_IP, 'user-agent': DESKTOP_UA },
    body: new URLSearchParams(fields).toString(),
  });
}

/** The owner's scope for a page, or a failed check (and null) when the session is gone. */
export async function ownerScopeOrFail(sim: Simulation, path: string, checkId: string): Promise<OwnerScope | null> {
  const scope = await ownerPageScope(sim, path);
  if (scope === null) sim.check(checkId, false, `the owner is not signed in on ${path}`);
  return scope;
}

/** /dashboard as the owner sees it (with the proxy's session refresh), or null. */
export async function ownerDashboard(sim: Simulation, checkId: string): Promise<DashboardView | null> {
  const scope = await ownerScopeOrFail(sim, '/dashboard', checkId);
  return scope === null ? null : dashboardView(scope, sim.deps);
}

/** /dashboard/billing as the owner sees it, or null. */
export async function ownerBillingPage(sim: Simulation, checkId: string): Promise<BillingPageView | null> {
  const scope = await ownerScopeOrFail(sim, BILLING_PATH, checkId);
  return scope === null ? null : billingPageView(sim.deps, scope);
}

/** The banners as types, in order (e.g. `trial_ending:2`, `billing_inactive`). */
export function bannerSummary(view: DashboardView | null): string {
  if (view === null) return 'not signed in';
  return (
    view.banners
      .map((banner) => (banner.type === 'trial_ending' ? `trial_ending:${banner.daysLeft}` : banner.type === 'reconnect' ? `reconnect:${String(banner.daysLeft)}` : banner.type))
      .join(',') || 'none'
  );
}

/** Where a banner's button goes (null when it has none). */
export function bannerLink(view: DashboardView | null, type: string): string | null {
  const banner = view?.banners.find((candidate) => candidate.type === type);
  return banner === undefined ? null : (bannerCopy(banner).link?.href ?? null);
}

export interface SubscribeOutcome {
  /** Each hop, as `status Location-path` (no ids). */
  readonly hops: readonly string[];
  /** The fake checkout's buttons for the new subscription. */
  readonly checkoutActions: readonly string[];
  /** Webhooks delivered to the real handler (and refused) after "Authorise payment". */
  readonly delivered: number;
  readonly failed: number;
}

function pathOf(response: Response, appUrl: string): string {
  const location = response.headers.get('location');
  if (location === null) return `${response.status} -`;
  const url = new URL(location, appUrl);
  // The fake checkout's path carries the random subscription id: shown without it.
  return `${response.status} ${url.pathname.replace(/\/sub_[A-Za-z0-9]+/, '/{id}')}${url.search.replace(/sub_[A-Za-z0-9]+/g, '{id}')}`;
}

/**
 * The owner subscribes from /dashboard/billing (PLAN §9.9, D-20): POST /api/billing/checkout (the
 * real handler: lock, guard, create) → 303 to /dashboard/billing/checkout, which reads the stored
 * hosted link → Razorpay's checkout (fake mode: /dev/fake-checkout/{id}) → "Authorise payment" →
 * FakeBilling queues `subscription.authenticated`, delivered signed to the real webhook handler.
 * Returns null (and fails `checkPrefix.subscribe_flow`) when a hop goes elsewhere.
 */
export async function subscribeThroughCheckout(sim: Simulation, checkPrefix: string): Promise<SubscribeOutcome | null> {
  const appUrl = sim.deps.env.APP_URL;
  const hops: string[] = [];
  const fail = (detail: string): null => {
    sim.check(`${checkPrefix}.subscribe_flow`, false, `${hops.join(' → ')} ✗ ${detail}`);
    return null;
  };

  // The billing page offers Subscribe; the form posts to the checkout route (same origin).
  if ((await ownerScopeOrFail(sim, BILLING_PATH, `${checkPrefix}.subscribe_flow`)) === null) return null;
  const checkout = await handleBillingControl(ownerFormPost(sim, '/api/billing/checkout', {}), sim.deps, 'checkout');
  hops.push(pathOf(checkout, appUrl));
  if (checkout.status !== 303 || new URL(checkout.headers.get('location') ?? '/', appUrl).pathname !== BILLING_CHECKOUT_PATH) return fail('checkout');

  // /dashboard/billing/checkout: the stored link of the open checkout.
  const scope = await ownerScopeOrFail(sim, BILLING_CHECKOUT_PATH, `${checkPrefix}.subscribe_flow`);
  if (scope === null) return null;
  const link = await openCheckoutLink(sim.deps, scope);
  if (link === null) return fail('no open checkout');
  const linkUrl = new URL(link);
  hops.push(`link ${linkUrl.origin === new URL(appUrl).origin ? 'own-origin' : linkUrl.origin}${linkUrl.pathname.replace(/\/sub_[A-Za-z0-9]+/, '/{id}')}`);
  const id = /^\/dev\/fake-checkout\/(sub_[A-Za-z0-9]+)$/.exec(linkUrl.pathname)?.[1];
  if (id === undefined || !linkUrl.pathname.startsWith(FAKE_CHECKOUT_PATH)) return fail('not the fake checkout');

  // Razorpay's hosted page (the fake): authorise the card.
  const ctx = { deps: sim.deps, billing: sim.fakes.billing };
  const view = await buildFakeCheckoutView(id, ctx);
  if (view === null) return fail('fake checkout page');
  const decision = await handleFakeCheckoutDecision(ownerFormPost(sim, `${FAKE_CHECKOUT_PATH}/${id}/decision`, { action: 'authorise' }), id, ctx);
  hops.push(pathOf(decision, appUrl));
  const query = new URL(decision.headers.get('location') ?? '/', appUrl).searchParams;
  if (decision.status !== 303 || query.get('done') !== 'authorise') return fail('authorise');
  return {
    hops,
    checkoutActions: view.actions.map((action) => action.action),
    delivered: Number(query.get('delivered') ?? '-1'),
    failed: Number(query.get('failed') ?? '-1'),
  };
}

/** The account's subscriptions as `status` in creation order (no ids). */
export async function subscriptionStatuses(sim: Simulation): Promise<string[]> {
  const rows = await sim.db.query<{ status: string }>(`select status from public.subscriptions where account_id = $1 order by created_at, id`, [sim.scenario.accountId]);
  return rows.map((row) => row.status);
}

export async function processingState(sim: Simulation): Promise<string | null> {
  const row = await sim.db.maybeOne<{ processing_state: string }>(`select processing_state from public.accounts where id = $1`, [sim.scenario.accountId]);
  return row?.processing_state ?? null;
}

/** The outbox as `kind` (one per email, in order). */
export function outboxKinds(sim: Simulation): string[] {
  return sim.fakes.mailer.sent.map((mail) => mail.kind);
}
