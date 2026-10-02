import 'server-only';
import { z } from 'zod';
import { DAY_MS, isTerminalStatus } from '@/server/domain/checkout-guard';
import { errorCode, isConfigError } from '@/server/domain/errors';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { applyFetched } from '@/server/services/billing/sync';

// The daily subscription reconcile (PLAN §9.1 step 4, §9.9, D-19, D-82): every subscription of the
// account that is not in one of Razorpay's terminal statuses (created, authenticated, active,
// pending, halted, paused, and the local `unknown` and `stale`) is fetched from Razorpay and handed to
// the billing service's apply-if-newer (`applyFetched`: stored only when this read is newer than the
// last one applied, then applyProcessingState and the one-live-subscription check). So a webhook that
// never arrived is caught up within a day, and a status Razorpay didn't document is read again until
// it reports a known one. A `stale` row (a checkout we stopped using, which Razorpay may still let
// the customer authorise until its `expire_by`) is read until 16 days past `expire_by` (Razorpay's
// webhook replay window): after that nothing can authorise it and nothing late can arrive. Each
// subscription is tried; the first error is rethrown afterwards (a config error at once: every call
// would fail the same way).

/** A `stale` row is no longer read this long after its `expire_by`. */
export const STALE_RECONCILE_MS = 16 * DAY_MS;

export interface ReconcileSummary {
  /** Fetched and applied (or found not newer). */
  readonly reconciled: number;
}

const rowSchema = z.object({ id: z.string(), provider_subscription_id: z.string(), status: z.string(), expire_by: z.date().nullable() });

/** Whether the daily reconcile reads this row today. */
export function needsDailyReconcile(row: { status: string; expireBy: Date | null }, now: Date): boolean {
  if (isTerminalStatus(row.status)) return false;
  if (row.status !== 'stale') return true;
  return row.expireBy === null || row.expireBy.getTime() > now.getTime() - STALE_RECONCILE_MS;
}

export async function reconcileAccountSubscriptions(deps: Deps, accountId: string): Promise<ReconcileSummary> {
  const rows = (
    await deps.db.query(`select id, provider_subscription_id, status, expire_by from subscriptions where account_id = $1 order by created_at, id`, [accountId])
  ).map((raw) => rowSchema.parse(raw));
  let reconciled = 0;
  let firstError: unknown = null;
  const now = deps.clock.now();
  for (const row of rows) {
    if (!needsDailyReconcile({ status: row.status, expireBy: row.expire_by }, now)) continue;
    try {
      // The read's own instant is the "newer" test (D-19).
      const fetchedAt = deps.clock.now();
      const snapshot = await deps.billing.fetchSubscription(row.provider_subscription_id);
      await applyFetched(deps, { row: { id: row.id, accountId }, snapshot, fetchedAt });
      reconciled += 1;
    } catch (error) {
      if (isConfigError(error)) throw error;
      log.warn('subscription not reconciled', { event: 'daily.reconcile_failed', accountId, subscriptionId: row.id, code: errorCode(error) }, error);
      firstError ??= error;
    }
  }
  if (firstError !== null) throw firstError;
  return { reconciled };
}
