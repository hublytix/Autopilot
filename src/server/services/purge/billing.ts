import 'server-only';
import { z } from 'zod';
import { errorCode, isConfigError, TransientError } from '@/server/domain/errors';
import { log } from '@/server/obs/log';
import type { Deps, RazorpaySubscription } from '@/server/ports';
import { CANCEL_FIRST_STATUSES, needsManualCancel, normalizedStatus, TERMINAL_STATUSES, tombstoneResolved } from './statuses';

// The purge's subscription step (PLAN §9.10 step 5, D-48, D-82), before anything is deleted and with
// no transaction open. Every subscription the account has is settled into a tombstone plan:
// - every row that is not in one of Razorpay's terminal statuses is fetched first (the stored
//   status may be a day old; the local `stale` and `unknown` say nothing about what Razorpay holds
//   now); a failed fetch keeps the stored status;
// - `authenticated`/`active` is cancelled at once (`cancel_at_cycle_end: false`). If the cancel
//   fails and a fresh fetch does not show it ended, the purge stops here and is retried (the job
//   backs off, and tomorrow's job tries again): nothing is deleted while a live subscription could
//   still charge;
// - `paused`/`pending`/`halted`, `unknown` and any status Razorpay doesn't document cannot be
//   cancelled through the API: the purge still runs and the admin is alerted (after commit) to
//   cancel it in the Razorpay dashboard;
// - the tombstone keeps the last status and `expire_by`. It is resolved at once only when nothing can
//   be charged any more: a terminal status (including one just cancelled), or a `created` one
//   Razorpay itself reports past `expire_by`. Anything else, a row whose read failed included, stays
//   open for the daily tombstone reconcile and the webhook.
// A config error (bad key pair) stops the purge.

export interface TombstonePlan {
  readonly providerSubscriptionId: string;
  readonly lastStatus: string;
  readonly expireBy: Date | null;
  /** Fetched (or cancelled) during this purge: `last_checked_at = $now`. */
  readonly checked: boolean;
  readonly resolved: boolean;
}

export interface SettledSubscriptions {
  readonly tombstones: readonly TombstonePlan[];
  /** Cancelled by this purge. */
  readonly cancelled: readonly string[];
  /** The admin must cancel these in the Razorpay dashboard. */
  readonly manual: readonly { readonly providerSubscriptionId: string; readonly status: string }[];
}

const subscriptionSchema = z.object({
  provider_subscription_id: z.string(),
  status: z.string(),
  expire_by: z.date().nullable(),
});

async function fetchOrNull(deps: Pick<Deps, 'billing'>, id: string): Promise<RazorpaySubscription | null> {
  try {
    return await deps.billing.fetchSubscription(id);
  } catch (error) {
    if (isConfigError(error)) throw error;
    log.warn('subscription not fetched before purge', { event: 'purge.subscription_fetch_failed', subscriptionId: id, code: errorCode(error) }, error);
    return null;
  }
}

/** Cancels a live subscription; its status afterwards. Throws TransientError while it may still be live. */
async function cancelFirst(deps: Pick<Deps, 'billing'>, id: string): Promise<string> {
  let status: string | null;
  try {
    status = normalizedStatus((await deps.billing.cancelSubscription(id, false)).status);
  } catch (error) {
    if (isConfigError(error)) throw error;
    log.warn('live subscription not cancelled before purge', { event: 'purge.subscription_cancel_failed', subscriptionId: id, code: errorCode(error) }, error);
    // A 4xx can mean it ended meanwhile: believe a fresh fetch only.
    const fresh = await fetchOrNull(deps, id);
    status = fresh === null ? null : normalizedStatus(fresh.status);
  }
  if (status !== null && TERMINAL_STATUSES.has(status)) return status;
  throw new TransientError('purge_subscription_cancel_failed');
}

export async function settleSubscriptionsForPurge(deps: Pick<Deps, 'db' | 'clock' | 'billing'>, accountId: string): Promise<SettledSubscriptions> {
  const rows = (
    await deps.db.query(`select provider_subscription_id, status, expire_by from subscriptions where account_id = $1 order by created_at, id`, [accountId])
  ).map((raw) => subscriptionSchema.parse(raw));
  const tombstones: TombstonePlan[] = [];
  const cancelled: string[] = [];
  const manual: { providerSubscriptionId: string; status: string }[] = [];
  for (const row of rows) {
    const id = row.provider_subscription_id;
    let status = row.status;
    let expireBy = row.expire_by;
    let checked = false;
    if (!TERMINAL_STATUSES.has(status)) {
      const fetched = await fetchOrNull(deps, id);
      if (fetched !== null) {
        status = normalizedStatus(fetched.status);
        expireBy = fetched.expireBy ?? expireBy;
        checked = true;
      }
    }
    if (CANCEL_FIRST_STATUSES.has(status)) {
      status = await cancelFirst(deps, id);
      checked = true;
      cancelled.push(id);
    }
    // paused, pending, halted, or a status we do not know: only the Razorpay dashboard can end it.
    if (needsManualCancel(status)) manual.push({ providerSubscriptionId: id, status });
    tombstones.push({ providerSubscriptionId: id, lastStatus: status, expireBy, checked, resolved: tombstoneResolved(status, expireBy, deps.clock.now(), checked) });
  }
  return { tombstones, cancelled, manual };
}
