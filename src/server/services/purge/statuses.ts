import 'server-only';
import { TERMINAL_STATUSES as RAZORPAY_TERMINAL_STATUSES } from '@/server/domain/checkout-guard';
import { normalizeSubscriptionStatus } from '@/server/domain/entitlement';

// How a purge and a billing tombstone treat a subscription status (PLAN §9.10 steps 5-6, D-18,
// D-48, D-82). Statuses are Razorpay's as sent (`resumed` is `active`). Only Razorpay's own terminal
// statuses mean nothing can be charged any more. Our local `stale` (a `created` checkout we stopped
// using: Razorpay still said `created`, the re-fetch failed, or only its plan or link made it
// unusable) and `unknown` (a status Razorpay doesn't document) say nothing about what Razorpay holds
// now, so the purge always asks Razorpay about them and lets its answer decide.

/** Live and cancellable through the API: cancelled at once (`cancel_at_cycle_end: false`). */
export const CANCEL_FIRST_STATUSES: ReadonlySet<string> = new Set(['authenticated', 'active']);

/** Not cancellable through the API: the purge still runs and the admin cancels in the Razorpay dashboard. */
export const MANUAL_CANCEL_STATUSES: ReadonlySet<string> = new Set(['paused', 'pending', 'halted', 'unknown']);

/** Razorpay's terminal statuses: nothing can be charged any more. Never the local `stale` or `unknown`. */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(RAZORPAY_TERMINAL_STATUSES);

/** Razorpay's status in the stored form (`resumed` → `active`); an undocumented status is kept as sent. */
export function normalizedStatus(raw: string): string {
  return normalizeSubscriptionStatus(raw) ?? raw;
}

/**
 * A tombstone is resolved when nothing can be charged on it any more: a terminal status, or a
 * `created` subscription past its `expire_by` (it can no longer be authorised, D-18). The `created`
 * rule needs Razorpay's own word (`fetched`): a stored `created` (or `stale`) row whose read failed
 * may have been authorised meanwhile, so it stays open for the reconcile.
 */
export function tombstoneResolved(status: string, expireBy: Date | null, now: Date, fetched: boolean): boolean {
  if (TERMINAL_STATUSES.has(status)) return true;
  return fetched && status === 'created' && expireBy !== null && expireBy.getTime() <= now.getTime();
}

/**
 * Whether the admin must cancel it in the Razorpay dashboard: a status that may still charge and that
 * the API can't cancel (paused, pending, halted, the local `unknown`, or any status Razorpay doesn't
 * document). Not a `created`/`stale` checkout (the tombstone stays open and the reconcile cancels it
 * if it is ever authorised) and never a terminal or live (cancelled first) one.
 */
export function needsManualCancel(status: string): boolean {
  if (TERMINAL_STATUSES.has(status) || CANCEL_FIRST_STATUSES.has(status)) return false;
  return status !== 'created' && status !== 'stale';
}
