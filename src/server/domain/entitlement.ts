import 'server-only';
import { isSubscriptionStatus, type SubscriptionStatus } from './types';

// Entitlement (D-18, PLAN §9.9): may this account's leads be processed right now? Pure.
//
//   entitled = trialing OR authenticated OR active OR (pending AND now < grace_until)
//
// - trialing: `now < trial_ends_at` (the trial counts from the portal's first install, D-30);
// - `authenticated` covers a subscription that starts at the end of the trial (D-20);
// - `pending` is entitled only inside its 3-day grace (`grace_until = payment_failed_at + 3 d`);
// - `created`, `stale`, `halted`, `paused`, `cancelled`, `completed`, `expired` and any unknown
//   status are not entitled (an unknown one also warrants an admin alert, which the caller raises);
// - Razorpay's `resumed` means `active` (RZP-STATUS-MAPPING).
// The current subscription is the one with the latest logical `created_at`.

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
 * The current subscription: the latest logical `created_at`; ties (one transaction inserting two)
 * go to the larger id, so the choice never depends on row order.
 */
export function currentSubscription<S extends SubscriptionSnapshot>(subscriptions: readonly S[]): S | null {
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
