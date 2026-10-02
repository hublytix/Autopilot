import 'server-only';
import { isSubscriptionStatus, type SubscriptionStatus } from './types';

// Entitlement (D-18, PLAN §9.9): may this account's leads be processed right now? Pure.
//
//   entitled = trialing OR authenticated OR active OR (pending AND now < grace_until)
//
// - trialing: `now < trial_ends_at` (the trial counts from the portal's first install, D-30);
// - `authenticated` covers a subscription that starts at the end of the trial (D-20);
// - `pending` is entitled only inside its 3-day grace (`grace_until = payment_failed_at + 3 d`);
// - `created`, `stale`, `unknown`, `halted`, `paused`, `cancelled`, `completed`, `expired` and any
//   status not in the list are not entitled (the stored `unknown`, D-82, was alerted when Razorpay
//   reported it; a value outside the list here also warrants an alert, which the caller raises);
// - Razorpay's `resumed` means `active` (RZP-STATUS-MAPPING).
// The current subscription is the newest row (logical `created_at`) that still holds a mandate
// (authenticated, active, pending, halted, paused), else the newest row (D-81: PLAN §9.9's "latest
// logical created_at", kept for every account the checkout guard allows, plus the safety net's case).

/** The account fields entitlement reads. */
export interface EntitlementAccount {
  readonly trialEndsAt: Date;
}

/** One `subscriptions` row as entitlement sees it. `status` is open: an unknown value is not entitled. */
export interface SubscriptionSnapshot {
  readonly id: string;
  readonly status: string;
  readonly graceUntil: Date | null;
  /** Logical `created_at` (bound from the Clock). */
  readonly createdAt: Date;
}

export type EntitlementReason =
  /** Inside the free trial. */
  | 'trial'
  /** `authenticated` or `active`. */
  | 'subscription'
  /** `pending` before `grace_until`. */
  | 'grace'
  /** No trial left and no subscription. */
  | 'no_subscription'
  /** The current subscription's status is known and not entitled (incl. `pending` after its grace). */
  | 'inactive_subscription'
  /** The current subscription's status is not one we know: inactive, and the admin should be told. */
  | 'unknown_status';

export interface Entitlement {
  readonly entitled: boolean;
  readonly reason: EntitlementReason;
}

/** Statuses that entitle by themselves (`pending` needs its grace). */
const ENTITLING: ReadonlySet<SubscriptionStatus> = new Set<SubscriptionStatus>(['authenticated', 'active']);

/**
 * Maps a status as Razorpay sent it to the stored form: `resumed` → `active`, the nine statuses and
 * `stale` to themselves, anything else to null (unknown: keep the previous status and alert, D-18).
 */
export function normalizeSubscriptionStatus(raw: string): SubscriptionStatus | null {
  if (raw === 'resumed') return 'active';
  return isSubscriptionStatus(raw) ? raw : null;
}

/**
 * Statuses that still hold a mandate (the checkout guard's blocking set, D-18). The guard never lets
 * a new row be created while one exists, so a newer row beside such a row is an anomaly: a second
 * subscription the safety net cancels (PLAN §9.9 keeps the older one), or an old link authorised late.
 */
const MANDATE: ReadonlySet<SubscriptionStatus> = new Set<SubscriptionStatus>(['authenticated', 'active', 'pending', 'halted', 'paused']);

function holdsMandate(subscription: SubscriptionSnapshot): boolean {
  const status = normalizeSubscriptionStatus(subscription.status);
  return status !== null && MANDATE.has(status);
}

function newest<S extends SubscriptionSnapshot>(subscriptions: readonly S[]): S | null {
  let current: S | null = null;
  for (const subscription of subscriptions) {
    if (
      current === null ||
      subscription.createdAt.getTime() > current.createdAt.getTime() ||
      (subscription.createdAt.getTime() === current.createdAt.getTime() && subscription.id > current.id)
    ) {
      current = subscription;
    }
  }
  return current;
}

/**
 * The current subscription: the newest row (latest logical `created_at`; ties, one transaction
 * inserting two, go to the larger id, so the choice never depends on row order) that still holds a
 * mandate, else the newest row of all. So a newer row the second-subscription safety net cancelled,
 * or a newer `created` row beside an older one authorised late, never hides the one that pays (D-81).
 */
export function currentSubscription<S extends SubscriptionSnapshot>(subscriptions: readonly S[]): S | null {
  return newest(subscriptions.filter(holdsMandate)) ?? newest(subscriptions);
}

/** Entitlement with its reason. `subscription` is the current one (see currentSubscription), or null. */
export function entitlementOf(account: EntitlementAccount, subscription: SubscriptionSnapshot | null, now: Date): Entitlement {
  if (now.getTime() < account.trialEndsAt.getTime()) return { entitled: true, reason: 'trial' };
  if (subscription === null) return { entitled: false, reason: 'no_subscription' };
  const status = normalizeSubscriptionStatus(subscription.status);
  if (status === null) return { entitled: false, reason: 'unknown_status' };
  if (ENTITLING.has(status)) return { entitled: true, reason: 'subscription' };
  if (status === 'pending' && subscription.graceUntil !== null && now.getTime() < subscription.graceUntil.getTime()) {
    return { entitled: true, reason: 'grace' };
  }
  return { entitled: false, reason: 'inactive_subscription' };
}

/** D-18: trialing OR authenticated OR active OR (pending AND now < grace_until). */
export function entitled(account: EntitlementAccount, subscription: SubscriptionSnapshot | null, now: Date): boolean {
  return entitlementOf(account, subscription, now).entitled;
}
