import 'server-only';
import type { SubscriptionStatus } from '@/server/domain/types';
import type { SubscriptionRow } from '@/server/services/billing/rows';

// What the Disconnect dialog may offer for billing (PLAN §7.5, §9.1 step 5, D-10, D-48). Razorpay
// cancels a subscription through the API only from `authenticated` (the card is set up; the first
// payment is taken when the trial ends, or was taken at authorisation without a future start_at) or
// `active` (paying). `paused`, `pending`, `halted` and a status Razorpay doesn't document (`unknown`,
// D-82) can't be cancelled through the API: the dialog explains it instead of offering the choice. Pure, so
// the page and the disconnect itself decide the same way from the same rows.

export type DisconnectBillingOption =
  /** "Also cancel my subscription" can be offered. */
  | {
      readonly type: 'cancellable';
      readonly status: 'authenticated' | 'active';
      /** `active`: the end of the current billing period, when a cancel takes effect (null when unknown). */
      readonly periodEndsAt: Date | null;
      /** `authenticated`: its start_at, when the first payment is (or was) due; null without one (charged at authorisation). */
      readonly firstPaymentAt: Date | null;
    }
  /** A live subscription the API can't cancel: the dialog explains why. */
  | { readonly type: 'not_cancellable'; readonly status: NotCancellableStatus }
  /** An `active` subscription already set to end at the end of its period. */
  | { readonly type: 'already_cancelled'; readonly endsAt: Date | null }
  /** Nothing is billed (no subscription, an unfinished checkout, or only ended ones). */
  | { readonly type: 'none' };

const NOT_CANCELLABLE = ['paused', 'pending', 'halted', 'unknown'] as const satisfies readonly SubscriptionStatus[];
export type NotCancellableStatus = (typeof NOT_CANCELLABLE)[number];

function isNotCancellable(status: SubscriptionStatus): status is NotCancellableStatus {
  return (NOT_CANCELLABLE as readonly SubscriptionStatus[]).includes(status);
}

/** The newest row (rows come oldest first) whose status matches. */
function newest(rows: readonly SubscriptionRow[], match: (row: SubscriptionRow) => boolean): SubscriptionRow | undefined {
  return rows.filter(match).at(-1);
}

/** The billing choice for the Disconnect dialog, from the account's subscriptions (oldest first). */
export function disconnectBillingOption(rows: readonly SubscriptionRow[]): DisconnectBillingOption {
  // The same row the billing page's Cancel acts on: the newest authenticated, or active one not yet set to end.
  const cancellable = newest(rows, (row) => row.status === 'authenticated' || (row.status === 'active' && !row.cancelAtCycleEnd));
  if (cancellable !== undefined && (cancellable.status === 'authenticated' || cancellable.status === 'active')) {
    return {
      type: 'cancellable',
      status: cancellable.status,
      periodEndsAt: cancellable.status === 'active' ? cancellable.currentEnd : null,
      firstPaymentAt: cancellable.status === 'authenticated' ? cancellable.startAt : null,
    };
  }
  const stuck = newest(rows, (row) => isNotCancellable(row.status));
  if (stuck !== undefined && isNotCancellable(stuck.status)) return { type: 'not_cancellable', status: stuck.status };
  const ending = newest(rows, (row) => row.status === 'active' && row.cancelAtCycleEnd);
  if (ending !== undefined) return { type: 'already_cancelled', endsAt: ending.currentEnd };
  return { type: 'none' };
}
