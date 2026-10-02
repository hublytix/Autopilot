import 'server-only';
import { errorCode } from '@/server/domain/errors';
import { raiseAlert } from '@/server/jobs/alert';
import { log } from '@/server/obs/log';
import type { Deps, RazorpaySubscription } from '@/server/ports';
import { runPostCommitWork } from '@/server/services/accounts';
import { applySnapshotInTx, type ApplyOutcome } from './apply';
import { loadAccountSubscriptions, type SubscriptionRow } from './rows';
import { isLiveStatus } from '@/server/domain/checkout-guard';

// Fetch-and-apply (D-19): the webhook is only a trigger; the state applied is what
// `GET /v1/subscriptions/{id}` says, applied only when newer, then applyProcessingState. After a
// subscription becomes live (`authenticated`/`active`), the account must not have two: the newer
// one is cancelled at once and the admin alerted to refund it (PLAN §9.9, D-18).

export interface ApplyFetchedInput {
  readonly row: Pick<SubscriptionRow, 'id' | 'accountId'>;
  readonly snapshot: RazorpaySubscription;
  readonly fetchedAt: Date;
  readonly pendingEventAt?: Date | null | undefined;
  readonly cancelAtCycleEnd?: boolean | undefined;
}

/** Applies a Razorpay read (one transaction), runs the after-commit work, alerts, enforces one live subscription. */
export async function applyFetched(deps: Deps, input: ApplyFetchedInput): Promise<ApplyOutcome> {
  const now = deps.clock.now();
  const applied = await deps.db.tx((tx) => applySnapshotInTx(tx, { ...input, now }));
  await runPostCommitWork(deps, applied.work);
  const outcome = applied.outcome;
  if (outcome.type !== 'applied') return outcome;
  if (!outcome.known) {
    // Stored as `unknown` (not entitled, blocks a new checkout, re-read daily); the raw value only goes to the log when it is code-shaped.
    raiseAlert('billing_unknown_subscription_status', { accountId: input.row.accountId, subscriptionId: input.row.id, status: input.snapshot.status });
  }
  if (outcome.changed) {
    log.info('subscription status applied', { event: 'billing.subscription_status', accountId: input.row.accountId, subscriptionId: input.row.id, status: outcome.status });
  }
  if (isLiveStatus(outcome.status)) await enforceOneLiveSubscription(deps, input.row.accountId);
  return outcome;
}

/** GET the subscription now and apply it. Throws the Billing port's errors (the caller decides). */
export async function syncSubscription(deps: Deps, row: Pick<SubscriptionRow, 'id' | 'accountId' | 'providerSubscriptionId'>, pendingEventAt: Date | null = null): Promise<ApplyOutcome> {
  const fetchedAt = deps.clock.now();
  const snapshot = await deps.billing.fetchSubscription(row.providerSubscriptionId);
  return applyFetched(deps, { row, snapshot, fetchedAt, pendingEventAt });
}

/**
 * The second-live-subscription safety net (PLAN §9.9, RZP-SUB-DECLINED-CREATED-GUARD): with two or
 * more `authenticated`/`active` rows, every one but the oldest (logical created_at, then id) is
 * cancelled immediately (`cancel_at_cycle_end: false`) and the admin is alerted to refund it.
 * Returns the ids of the rows it asked Razorpay to cancel. Never throws.
 */
export async function enforceOneLiveSubscription(deps: Deps, accountId: string): Promise<string[]> {
  let live: SubscriptionRow[];
  try {
    live = (await loadAccountSubscriptions(deps.db, accountId)).filter((row) => isLiveStatus(row.status));
  } catch (error) {
    log.warn('second subscription check failed', { event: 'billing.second_subscription_check_failed', accountId, code: errorCode(error) });
    return [];
  }
  const cancelled: string[] = [];
  for (const row of live.slice(1)) {
    raiseAlert('billing_second_live_subscription', { accountId, subscriptionId: row.id });
    try {
      const fetchedAt = deps.clock.now();
      const snapshot = await deps.billing.cancelSubscription(row.providerSubscriptionId, false);
      await applyFetched(deps, { row, snapshot, fetchedAt });
      cancelled.push(row.id);
    } catch (error) {
      raiseAlert('billing_second_subscription_cancel_failed', { accountId, subscriptionId: row.id, errorCode: errorCode(error) });
    }
  }
  return cancelled;
}
