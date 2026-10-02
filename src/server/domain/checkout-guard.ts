import 'server-only';
import { isRazorpaySubscriptionStatus, type SubscriptionStatus } from './types';

// The billing rules as pure functions (PLAN §3 domain "checkout guard", §9.9, D-18, D-20): the
// checkout guard, when a `created` subscription's link can be reused, the start_at/expire_by rule,
// the status mapping and the grace period. No I/O; services/billing, the purge, the daily reconcile
// and the billing page share them, and checkout-guard.test.ts drives them by table (PLAN §12).

export const DAY_MS = 24 * 60 * 60 * 1000;
/** `grace_until = payment_failed_at + 3 d` (D-18). */
export const GRACE_MS = 3 * DAY_MS;
/** How long a new checkout link stays usable at most (D-20). */
export const CHECKOUT_LINK_TTL_MS = 7 * DAY_MS;
/** With more trial than this left, the subscription starts when the trial ends (D-20, RZP-TRIAL-START-AT). */
export const TRIAL_START_AT_THRESHOLD_MS = DAY_MS;
/** A future-start link expires this long before `start_at` (an unauthorised one expires there anyway). */
export const START_AT_MARGIN_MS = 60_000;
/** D-20: 120 monthly cycles; quantity 1; Razorpay emails receipts and failed-payment notices. */
export const SUBSCRIPTION_TOTAL_COUNT = 120;

/**
 * Statuses that block a new checkout: a live subscription (and mandate) already exists (D-18), or
 * Razorpay reported a status we don't know (`unknown`), which may hold one: a second checkout could
 * create a second mandate the safety net would not see, so the owner is sent to support instead.
 */
export const CHECKOUT_BLOCKING_STATUSES = ['authenticated', 'active', 'pending', 'halted', 'paused', 'unknown'] as const satisfies readonly SubscriptionStatus[];
export type BlockingStatus = (typeof CHECKOUT_BLOCKING_STATUSES)[number];

/** Statuses that entitle by themselves: a second one on the same account is cancelled (PLAN §9.9). */
export const LIVE_STATUSES = ['authenticated', 'active'] as const satisfies readonly SubscriptionStatus[];

/**
 * Razorpay's terminal statuses: nothing changes them any more and nothing can be charged. Only these
 * (never the local `stale` or `unknown`) let the purge, the reconcile or a tombstone stop asking
 * Razorpay (D-82).
 */
export const TERMINAL_STATUSES = ['cancelled', 'completed', 'expired'] as const satisfies readonly SubscriptionStatus[];

export function isBlockingStatus(status: string): status is BlockingStatus {
  return (CHECKOUT_BLOCKING_STATUSES as readonly string[]).includes(status);
}

export function isLiveStatus(status: string): boolean {
  return (LIVE_STATUSES as readonly string[]).includes(status);
}

export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export interface MappedStatus {
  /** What `subscriptions.status` stores. */
  readonly status: SubscriptionStatus;
  /** False for a status Razorpay does not document: stored as the local `unknown`, admin alerted. */
  readonly known: boolean;
}

/**
 * Razorpay's status as stored (D-18, RZP-SUB-STATUSES): the nine documented statuses as they are,
 * `resumed` (named in the webhook table, never seen in a payload) as `active`. Anything else is the
 * local `unknown` (D-82): not entitled, blocks a new checkout (it may hold a mandate), re-read by
 * the daily reconcile and the purge; the caller alerts the admin.
 */
export function mapRazorpayStatus(raw: string): MappedStatus {
  if (raw === 'resumed') return { status: 'active', known: true };
  if (isRazorpaySubscriptionStatus(raw)) return { status: raw, known: true };
  return { status: 'unknown', known: false };
}

/**
 * The status a Razorpay read leaves on a stored row: the mapped one, except that a row never goes
 * back to `created` (a checkout we stopped using stays `stale`, and an `unknown` one becomes `stale`:
 * Razorpay says it is an unfinished checkout again, which never blocks).
 */
export function appliedStatus(stored: SubscriptionStatus, mapped: SubscriptionStatus): SubscriptionStatus {
  if (mapped !== 'created' || stored === 'created') return mapped;
  return stored === 'unknown' ? 'stale' : stored;
}

/** What the checkout guard and the reuse rule read of a row. */
export interface GuardRow {
  readonly id: string;
  readonly planId: string;
  readonly status: SubscriptionStatus;
  readonly shortUrl: string | null;
  readonly startAt: Date | null;
  readonly expireBy: Date | null;
  readonly createdAt: Date;
}

/** What the reuse rule compares a row with: RAZORPAY_PLAN_ID and APP_URL. */
export interface CheckoutConfig {
  readonly planId: string;
  readonly appUrl: string;
}

/**
 * A `created` row's link can be reused while `expire_by > now` and (`start_at` is null or
 * `> now`) (PLAN §9.9 step 3), for the configured plan, with a usable stored link.
 */
export function isReusableCheckout(row: GuardRow, now: Date, config: CheckoutConfig): boolean {
  return (
    row.status === 'created' &&
    row.planId === config.planId &&
    isUsableCheckoutLink(row.shortUrl, config.appUrl) &&
    row.expireBy !== null &&
    row.expireBy.getTime() > now.getTime() &&
    (row.startAt === null || row.startAt.getTime() > now.getTime())
  );
}

/** Newest first by logical created_at, then id (the "current subscription" order, D-18). */
function newestFirst<R extends GuardRow>(rows: readonly R[]): R[] {
  return [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

export type CheckoutDecision<R extends GuardRow> =
  /** A live subscription exists: no new checkout (pending/halted → Update payment method, paused → Resume). */
  | { readonly type: 'blocked'; readonly row: R & { readonly status: BlockingStatus } }
  /** An open checkout: send the owner to its stored link. */
  | { readonly type: 'reuse'; readonly row: R }
  /** A new subscription; first re-fetch these `created` rows that can't be reused (step 4). */
  | { readonly type: 'create'; readonly recheck: readonly R[] };

/**
 * The checkout guard (PLAN §9.9 steps 2-4, D-18): block on any `authenticated`, `active`, `pending`,
 * `halted`, `paused` (or `unknown`, D-82) row; else reuse the newest reusable `created` row; else
 * create, after resolving every other `created` row. `none`, `expired`, `cancelled`, `completed` and
 * `stale` never block, so a declined or abandoned checkout can't lock the owner out.
 */
export function checkoutGuard<R extends GuardRow>(rows: readonly R[], now: Date, config: CheckoutConfig): CheckoutDecision<R> {
  const ordered = newestFirst(rows);
  const blocking = ordered.find((row): row is R & { readonly status: BlockingStatus } => isBlockingStatus(row.status));
  if (blocking !== undefined) return { type: 'blocked', row: blocking };
  const reusable = ordered.find((row) => isReusableCheckout(row, now, config));
  if (reusable !== undefined) return { type: 'reuse', row: reusable };
  return { type: 'create', recheck: ordered.filter((row) => row.status === 'created') };
}

export interface CheckoutTiming {
  /** The trial's end, when more than a day of it is left; otherwise the subscription starts at once. */
  readonly startAt: Date | null;
  readonly expireBy: Date;
}

function floorToSecond(ms: number): Date {
  return new Date(Math.floor(ms / 1000) * 1000);
}

/**
 * D-20: with more than 1 day of trial left, `start_at = trial_end` and `expire_by = min(now + 7 d,
 * start_at − 60 s)`; otherwise no `start_at` (the first $49 is charged at authorisation) and
 * `expire_by = now + 7 d`. Whole seconds, as Razorpay stores them.
 */
export function checkoutTiming(trialEndsAt: Date, now: Date): CheckoutTiming {
  const nowMs = now.getTime();
  if (trialEndsAt.getTime() - nowMs > TRIAL_START_AT_THRESHOLD_MS) {
    const startAt = floorToSecond(trialEndsAt.getTime());
    return { startAt, expireBy: floorToSecond(Math.min(nowMs + CHECKOUT_LINK_TTL_MS, startAt.getTime() - START_AT_MARGIN_MS)) };
  }
  return { startAt: null, expireBy: floorToSecond(nowMs + CHECKOUT_LINK_TTL_MS) };
}

/**
 * Is the first $49 still ahead for a subscription with this `start_at` (D-20, D-82)? Only with a
 * future `start_at` (the trial's end): without one Razorpay charges the plan amount when the card
 * is authorised, and once `start_at` has passed the first charge was due. The pages never say
 * "nothing is charged" otherwise (laws 3 and 5).
 */
export function firstPaymentAhead(startAt: Date | null, now: Date): boolean {
  return startAt !== null && startAt.getTime() > now.getTime();
}

/**
 * A link we send the owner to: Razorpay's hosted page (https, no credentials in it), or in fake mode
 * a page of our own origin (`/dev/fake-checkout/{id}`). Anything else (javascript:, data:, plain http
 * elsewhere) is never rendered or redirected to.
 */
export function isUsableCheckoutLink(link: string | null, appUrl: string): link is string {
  if (link === null || link === '') return false;
  try {
    const url = new URL(link);
    if (url.username !== '' || url.password !== '') return false;
    return url.protocol === 'https:' || url.origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}

export interface GraceInput {
  readonly status: SubscriptionStatus;
  readonly paymentFailedAt: Date | null;
  readonly graceUntil: Date | null;
  /** When the stored status last changed (our Clock, when we learnt of it). */
  readonly statusChangedAt: Date;
}

/**
 * The grace columns after applying `status` (D-18): `pending` keeps the first failure's instant of
 * the current failure episode (`payment_failed_at` = the first `subscription.pending` event's
 * created_at; without one, the instant we learnt of it) and `grace_until` = +3 d; `active` clears
 * both; any other status keeps them (they only matter while `pending`).
 *
 * A pending event only counts for the current episode (D-82). Razorpay's retries run T+1..T+3 and
 * its webhooks are retried for 24 h and replayed for up to 15 days, so a pending event from an
 * earlier episode (already ended by `active`) can arrive late:
 * - coming from another status, an event older than that status's change is from an episode that
 *   ended before it, and is ignored (the failure counts from when we learnt of it);
 * - continuing a `pending` episode, an earlier event moves the start back, but never to before the
 *   grace length ahead of when we learnt the row went `pending` (every retry of one episode falls
 *   within it).
 */
export function graceAfter(previous: GraceInput, status: SubscriptionStatus, pendingEventAt: Date | null, learntAt: Date): { paymentFailedAt: Date | null; graceUntil: Date | null } {
  if (status === 'active') return { paymentFailedAt: null, graceUntil: null };
  if (status !== 'pending') return { paymentFailedAt: previous.paymentFailedAt, graceUntil: previous.graceUntil };
  const continuing = previous.status === 'pending' && previous.paymentFailedAt !== null;
  const floor = continuing ? previous.statusChangedAt.getTime() - GRACE_MS : previous.statusChangedAt.getTime();
  const event = pendingEventAt !== null && pendingEventAt.getTime() >= floor ? pendingEventAt : null;
  let failedAt: Date;
  if (continuing && previous.paymentFailedAt !== null) {
    failedAt = event !== null && event.getTime() < previous.paymentFailedAt.getTime() ? event : previous.paymentFailedAt;
  } else {
    failedAt = event ?? learntAt;
  }
  return { paymentFailedAt: failedAt, graceUntil: new Date(failedAt.getTime() + GRACE_MS) };
}
