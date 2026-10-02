import 'server-only';
import { z } from 'zod';
import type { FakeBilling, FakeRazorpayWebhook } from '@/server/adapters/fake/billing';
import { getContainer } from '@/server/container';
import { errorCode } from '@/server/domain/errors';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { isSameOriginRequest } from '@/server/security/same-origin';
import { handleRazorpayWebhook } from '../razorpay-webhook';
import { devNotFound, devPlainResponse, devToolsEnabled } from './guard';

// The fake Razorpay checkout (fake mode only; 404 otherwise; PLAN §4, §7.6): FakeBilling's
// subscriptions carry `short_url = {APP_URL}/dev/fake-checkout/{id}`, so Subscribe lands here. The
// page plays the customer (authorise the card, or a declined card) and, for development, Razorpay's
// billing engine (start billing when the trial ends, renewals, a failed renewal, retries exhausted,
// a card update, a pause or cancel from the bank's portal, a resume). Each action runs on
// FakeBilling, whose state fake mode persists in fake.state; then every webhook FakeBilling has
// queued is delivered, signed, to the real webhook handler (handleRazorpayWebhook) in this process,
// exactly as Razorpay would POST it. Like Razorpay's hosted page, it does not send the customer
// back: the page links to the billing page.

export const FAKE_CHECKOUT_PATH = '/dev/fake-checkout';
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]{1,40}$/;

/** What the fake checkout works with: the fake-mode Deps (for the webhook handler) and FakeBilling. */
export interface FakeCheckoutContext {
  readonly deps: Deps;
  readonly billing: FakeBilling;
}

/** The context in fake mode; null otherwise (never builds the live container). */
export async function getFakeCheckoutContext(): Promise<FakeCheckoutContext | null> {
  if (!devToolsEnabled()) return null;
  const container = await getContainer();
  if (container.mode !== 'fake' || container.fakes === null) return null;
  return { deps: container.deps, billing: container.fakes.billing };
}

export const FAKE_CHECKOUT_ACTIONS = [
  'authorise',
  'decline',
  'start_billing',
  'renew',
  'fail_renewal',
  'retries_exhausted',
  'card_updated',
  'pause',
  'resume',
  'cancel',
  'deliver',
] as const;
export type FakeCheckoutAction = (typeof FAKE_CHECKOUT_ACTIONS)[number];

interface ActionSpec {
  readonly label: string;
  /** The statuses it applies to (null: any). */
  readonly when: readonly string[] | null;
  readonly run: (billing: FakeBilling, id: string) => void;
}

const ACTIONS: Readonly<Record<FakeCheckoutAction, ActionSpec>> = {
  authorise: { label: 'Authorise payment', when: ['created'], run: (b, id) => void b.authenticate(id) },
  decline: { label: 'Fail payment (card declined)', when: ['created'], run: (b, id) => b.failAuthentication(id) },
  start_billing: { label: 'Start billing (as if the trial had ended)', when: ['authenticated'], run: (b, id) => void b.activate(id) },
  renew: { label: 'Charge the next cycle', when: ['active'], run: (b, id) => void b.charge(id) },
  fail_renewal: { label: 'Fail the renewal payment', when: ['active', 'pending'], run: (b, id) => void b.failPayment(id) },
  retries_exhausted: { label: 'Retries exhausted (halted)', when: ['pending'], run: (b, id) => void b.halt(id) },
  card_updated: { label: 'Card updated, payment succeeds', when: ['pending', 'halted'], run: (b, id) => void b.activate(id) },
  pause: { label: 'Pause from the bank portal', when: ['active'], run: (b, id) => void b.pause(id) },
  resume: { label: 'Resume', when: ['paused'], run: (b, id) => void b.resume(id) },
  cancel: { label: 'Cancel from the bank portal', when: ['authenticated', 'active', 'pending', 'halted', 'paused'], run: (b, id) => void b.cancel(id) },
  deliver: { label: "Deliver Razorpay's scheduled events", when: null, run: (b) => void b.sync() },
};

const PERIOD_UNITS: Readonly<Record<string, string>> = { daily: 'day', weekly: 'week', monthly: 'month', quarterly: 'quarter', yearly: 'year' };

export interface FakeCheckoutView {
  readonly id: string;
  readonly status: string;
  readonly price: string;
  /** ISO instants; the page formats them. */
  readonly startAt: string | null;
  readonly expireBy: string | null;
  readonly actions: readonly { readonly action: FakeCheckoutAction; readonly label: string }[];
  readonly decisionPath: string;
}

function actionsFor(status: string): FakeCheckoutView['actions'] {
  return FAKE_CHECKOUT_ACTIONS.filter((action) => {
    const when = ACTIONS[action].when;
    return when === null || when.includes(status);
  }).map((action) => ({ action, label: ACTIONS[action].label }));
}

/** The page's view model; null when not in fake mode or the subscription is unknown. */
export async function buildFakeCheckoutView(id: string, ctx: FakeCheckoutContext | null): Promise<FakeCheckoutView | null> {
  if (ctx === null || !SUBSCRIPTION_ID.test(id)) return null;
  try {
    const sub = await ctx.billing.fetchSubscription(id);
    const plan = await ctx.billing.fetchPlan(sub.planId);
    return {
      id: sub.id,
      status: sub.status,
      price: `${plan.currency} ${(plan.amount / 100).toFixed(2)} every ${plan.interval === 1 ? '' : `${plan.interval} `}${PERIOD_UNITS[plan.period] ?? plan.period}`,
      startAt: sub.startAt?.toISOString() ?? null,
      expireBy: sub.expireBy?.toISOString() ?? null,
      actions: actionsFor(sub.status),
      decisionPath: `${FAKE_CHECKOUT_PATH}/${sub.id}/decision`,
    };
  } catch {
    return null;
  }
}

export async function fakeCheckoutView(id: string): Promise<FakeCheckoutView | null> {
  return buildFakeCheckoutView(id, await getFakeCheckoutContext());
}

const MAX_FORM_BYTES = 4 * 1024;
const actionSchema = z.enum(FAKE_CHECKOUT_ACTIONS);

/** The posted `action` (a urlencoded or multipart form, as a browser sends it); null when absent or odd. */
async function readAction(req: Request): Promise<FakeCheckoutAction | null> {
  const type = req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (!Number.isFinite(declared) || declared > MAX_FORM_BYTES) return null;
  let values: unknown[];
  if (type === 'application/x-www-form-urlencoded') {
    const body = await req.text();
    if (body.length > MAX_FORM_BYTES) return null;
    values = new URLSearchParams(body).getAll('action');
  } else if (type === 'multipart/form-data') {
    try {
      values = (await req.formData()).getAll('action');
    } catch {
      return null;
    }
  } else {
    return null;
  }
  if (values.length !== 1) return null;
  const parsed = actionSchema.safeParse(values[0]);
  return parsed.success ? parsed.data : null;
}

/** Delivers every queued webhook, oldest first, to the real handler; returns how many were accepted (200). */
export async function deliverQueuedWebhooks(ctx: FakeCheckoutContext): Promise<{ delivered: number; failed: number }> {
  let delivered = 0;
  let failed = 0;
  // A delivery can queue more (a cancel of a second subscription): drain until empty, bounded.
  for (let round = 0; round < 5; round += 1) {
    const queued: FakeRazorpayWebhook[] = ctx.billing.takeWebhooks();
    if (queued.length === 0) break;
    for (const webhook of queued) {
      const request = new Request(`${ctx.deps.env.APP_URL}/api/razorpay/webhook`, { method: 'POST', headers: webhook.headers, body: webhook.rawBody });
      const response = await handleRazorpayWebhook(request, ctx.deps);
      if (response.status === 200) delivered += 1;
      else failed += 1;
    }
  }
  return { delivered, failed };
}

function backTo(id: string, query: string): Response {
  return new Response(null, { status: 303, headers: { Location: `${FAKE_CHECKOUT_PATH}/${id}?${query}`, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
}

/** POST /dev/fake-checkout/{id}/decision (fake mode only, same-origin). */
export async function handleFakeCheckoutDecision(req: Request, id: string, ctx: FakeCheckoutContext | null): Promise<Response> {
  if (ctx === null) return devNotFound();
  if (req.method !== 'POST') return devPlainResponse(405, 'Method not allowed', { Allow: 'POST' });
  if (!isSameOriginRequest(req, ctx.deps.env.APP_URL)) return devPlainResponse(403, 'Forbidden');
  if (!SUBSCRIPTION_ID.test(id)) return devNotFound();
  const action = await readAction(req);
  if (action === null) return devPlainResponse(400, 'Unknown action');

  let status: string;
  try {
    status = (await ctx.billing.fetchSubscription(id)).status;
  } catch {
    return devNotFound();
  }
  const spec = ACTIONS[action];
  if (spec.when !== null && !spec.when.includes(status)) return devPlainResponse(409, `This action does not apply to a ${status} subscription`);
  try {
    spec.run(ctx.billing, id);
  } catch (error) {
    log.warn('fake checkout action refused', { event: 'dev.fake_checkout_refused', subscriptionId: id, reason: action, code: errorCode(error) });
    return devPlainResponse(409, 'This action does not apply to the subscription now');
  }
  const { delivered, failed } = await deliverQueuedWebhooks(ctx);
  log.info('fake checkout action', { event: 'dev.fake_checkout', subscriptionId: id, reason: action, count: delivered, skipped: failed });
  return backTo(id, `done=${action}&delivered=${delivered}&failed=${failed}`);
}

/** Any other method on the decision route: 404 outside fake mode, else 405. */
export function handleFakeCheckoutDecisionOtherMethod(ctx: FakeCheckoutContext | null): Response {
  if (ctx === null) return devNotFound();
  return devPlainResponse(405, 'Method not allowed', { Allow: 'POST' });
}
