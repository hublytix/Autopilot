import 'server-only';
import { z } from 'zod';
import { errorCode, isConfigError, isRetryable } from '@/server/domain/errors';
import { raiseAlert } from '@/server/jobs/alert';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { reconcileTombstone } from '@/server/services/billing/tombstone';

// The billing-tombstone reconcile (PLAN §9.10 step 6, D-19, D-48), run inline by the daily cron:
// `WHERE resolved_at IS NULL ORDER BY last_checked_at NULLS FIRST LIMIT 50` (then the purge time and
// the id, so the order is stable). Each row goes through the same per-subscription rule the Razorpay
// webhook uses (services/billing/tombstone.ts: fetch; `authenticated`/`active` → cancelled at once
// and the admin alerted to refund; terminal, or `created` past `expire_by` → resolved;
// `pending`/`halted`/`paused` stay open with `last_checked_at = $now`, so the rotation moves on).
// A fetch that fails transiently changes nothing: the row comes first again the next day. One that
// Razorpay refuses for good (a 4xx such as an unknown id) is moved to the back of the rotation, so
// it never blocks the rows behind it. A config error (bad key pair) stops the run with one alert:
// every other row would fail the same way. With a `deadline` (the daily cron's time budget, D-82)
// no new row is started once the Clock passes it: the rows left keep their place for tomorrow.

export const TOMBSTONE_RECONCILE_LIMIT = 50;

export interface TombstoneReconcileSummary {
  readonly checked: number;
  readonly resolved: number;
  readonly cancelled: number;
  readonly open: number;
  readonly failed: number;
  /** A config error stopped the run. */
  readonly stopped: boolean;
  /** Rows left for tomorrow because the time budget ran out. */
  readonly deferred: number;
}

const rowSchema = z.object({
  provider_subscription_id: z.string(),
  last_status: z.string(),
  expire_by: z.date().nullable(),
});

/** The daily cron's step: at most `limit` unresolved tombstones, least recently checked first. Counts only. */
export async function reconcileBillingTombstones(
  deps: Deps,
  options: { limit?: number | undefined; deadline?: Date | undefined } = {},
): Promise<TombstoneReconcileSummary> {
  const rows = (
    await deps.db.query(
      `select provider_subscription_id, last_status, expire_by from billing_tombstones
        where resolved_at is null
        order by last_checked_at nulls first, purged_at, provider_subscription_id
        limit $1`,
      [options.limit ?? TOMBSTONE_RECONCILE_LIMIT],
    )
  ).map((raw) => rowSchema.parse(raw));
  const counts = { checked: 0, resolved: 0, cancelled: 0, open: 0, failed: 0 };
  let deferred = 0;
  for (const row of rows) {
    if (options.deadline !== undefined && deps.clock.now().getTime() >= options.deadline.getTime()) {
      deferred = rows.length - counts.checked;
      break;
    }
    const id = row.provider_subscription_id;
    counts.checked += 1;
    try {
      const outcome = await reconcileTombstone(deps, { providerSubscriptionId: id, lastStatus: row.last_status, expireBy: row.expire_by, resolvedAt: null });
      if (outcome.type === 'resolved') counts.resolved += 1;
      else if (outcome.type === 'cancelled') counts.cancelled += 1;
      else if (outcome.type === 'open') counts.open += 1;
      else counts.failed += 1;
    } catch (error) {
      if (isConfigError(error)) {
        raiseAlert('billing_tombstone_reconcile_config', { errorCode: errorCode(error) });
        return { ...counts, failed: counts.failed + 1, stopped: true, deferred: rows.length - counts.checked };
      }
      counts.failed += 1;
      log.warn('tombstoned subscription not checked', { event: 'billing.tombstone_fetch_failed', subscriptionId: id, code: errorCode(error) }, error);
      if (!isRetryable(error)) {
        await deps.db.query(`update billing_tombstones set last_checked_at = $2 where provider_subscription_id = $1 and resolved_at is null`, [id, deps.clock.now()]);
      }
    }
  }
  if (counts.checked > 0) log.info('billing tombstones reconciled', { event: 'billing.tombstones', count: counts.checked, total: counts.resolved + counts.cancelled });
  if (deferred > 0) log.warn('billing tombstone reconcile out of time', { event: 'billing.tombstones_deferred', count: deferred });
  return { ...counts, stopped: false, deferred };
}
