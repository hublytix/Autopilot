import 'server-only';
import { errorCode, isAppError } from '@/server/domain/errors';
import { raiseAlert } from '@/server/jobs/alert';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import type { OwnerScope } from '@/server/services/auth/owner-scope';
import { firstPaymentAhead } from '@/server/domain/checkout-guard';
import { withBillingLock } from './lock';
import { loadAccountSubscriptions, type SubscriptionRow } from './rows';
import { applyFetched, syncSubscription } from './sync';

// Cancel and Resume on the billing page (PLAN §9.9, D-18, D-20):
// - cancel: an `authenticated` subscription is cancelled at once (`cancel_at_cycle_end: false`).
//   With a future `start_at` (the trial's end) nothing has been charged and the trial still runs to
//   its end; without one (or once it has passed) the first $49 was due at authorisation, so the
//   outcome says so (`beforeFirstPayment: false`, D-82). An `active` one is cancelled at the end of
//   the current cycle (`true`): it stays active (and entitled) until then, and
//   `cancel_at_cycle_end` is recorded for the page;
// - resume: a `paused` subscription only (`resume_at: now`).
// Both run under the billing lock, call Razorpay outside any transaction, and apply what Razorpay
// returns (only if newer), then applyProcessingState. A refusal re-reads the subscription so the
// page shows the truth.

export type CancelOutcome =
  /** `authenticated` → cancelled now. `beforeFirstPayment`: its start_at was still ahead (nothing charged). */
  | { readonly type: 'cancelled'; readonly beforeFirstPayment: boolean }
  /** `active` → cancelled at the end of the current cycle. */
  | { readonly type: 'cancel_scheduled' }
  | { readonly type: 'already_scheduled' }
  /** No `authenticated` or `active` subscription. */
  | { readonly type: 'nothing_to_cancel' }
  /** Razorpay refused (its status had moved on): re-read and shown. */
  | { readonly type: 'refused' }
  | { readonly type: 'unavailable' }
  | { readonly type: 'busy' };

export type ResumeOutcome =
  | { readonly type: 'resumed' }
  | { readonly type: 'nothing_to_resume' }
  | { readonly type: 'refused' }
  | { readonly type: 'unavailable' }
  | { readonly type: 'busy' };

/** The newest row (logical created_at, then id) whose status is one of `statuses`. */
function newestWith(rows: readonly SubscriptionRow[], statuses: readonly string[]): SubscriptionRow | null {
  let found: SubscriptionRow | null = null;
  for (const row of rows) if (statuses.includes(row.status)) found = row;
  return found;
}

/** What a failed Razorpay call means for the owner; a refusal is re-read (best effort). */
async function failure(deps: Deps, row: SubscriptionRow, error: unknown, action: 'cancel' | 'resume'): Promise<'refused' | 'unavailable'> {
  if (isAppError(error) && error.kind === 'permanent') {
    log.warn('billing action refused by razorpay', { event: `billing.${action}_refused`, accountId: row.accountId, subscriptionId: row.id, code: error.code });
    try {
      await syncSubscription(deps, row);
    } catch (syncError) {
      log.warn('subscription re-read failed', { event: 'billing.resync_failed', accountId: row.accountId, subscriptionId: row.id, code: errorCode(syncError) });
    }
    return 'refused';
  }
  if (!isAppError(error) || error.kind === 'config') raiseAlert('billing_action_failed', { accountId: row.accountId, subscriptionId: row.id, errorCode: errorCode(error) });
  else log.warn('billing action deferred: razorpay unavailable', { event: `billing.${action}_unavailable`, accountId: row.accountId, code: error.code });
  return 'unavailable';
}

async function cancelLocked(deps: Deps, accountId: string): Promise<CancelOutcome> {
  const row = newestWith(await loadAccountSubscriptions(deps.db, accountId), ['authenticated', 'active']);
  if (row === null) return { type: 'nothing_to_cancel' };
  if (row.status === 'active' && row.cancelAtCycleEnd) return { type: 'already_scheduled' };
  const atCycleEnd = row.status === 'active';
  const fetchedAt = deps.clock.now();
  try {
    const snapshot = await deps.billing.cancelSubscription(row.providerSubscriptionId, atCycleEnd);
    await applyFetched(deps, { row, snapshot, fetchedAt, cancelAtCycleEnd: atCycleEnd });
  } catch (error) {
    return { type: await failure(deps, row, error, 'cancel') };
  }
  log.info('subscription cancel requested', { event: 'billing.cancel', accountId, subscriptionId: row.id, outcome: atCycleEnd ? 'at_cycle_end' : 'now' });
  return atCycleEnd ? { type: 'cancel_scheduled' } : { type: 'cancelled', beforeFirstPayment: firstPaymentAhead(row.startAt, fetchedAt) };
}

async function resumeLocked(deps: Deps, accountId: string): Promise<ResumeOutcome> {
  const row = newestWith(await loadAccountSubscriptions(deps.db, accountId), ['paused']);
  if (row === null) return { type: 'nothing_to_resume' };
  const fetchedAt = deps.clock.now();
  try {
    const snapshot = await deps.billing.resumeSubscription(row.providerSubscriptionId);
    await applyFetched(deps, { row, snapshot, fetchedAt });
  } catch (error) {
    return { type: await failure(deps, row, error, 'resume') };
  }
  log.info('subscription resumed', { event: 'billing.resume', accountId, subscriptionId: row.id });
  return { type: 'resumed' };
}

export async function cancelSubscriptionForOwner(deps: Deps, scope: OwnerScope): Promise<CancelOutcome> {
  const locked = await withBillingLock(deps.db, scope.accountId, deps.clock.now(), () => cancelLocked(deps, scope.accountId));
  return locked.type === 'busy' ? { type: 'busy' } : locked.value;
}

export async function resumeSubscriptionForOwner(deps: Deps, scope: OwnerScope): Promise<ResumeOutcome> {
  const locked = await withBillingLock(deps.db, scope.accountId, deps.clock.now(), () => resumeLocked(deps, scope.accountId));
  return locked.type === 'busy' ? { type: 'busy' } : locked.value;
}
