import 'server-only';
import type { SubscriptionStatus } from '@/server/domain/types';
import type { Db } from '@/server/db';
import type { RazorpaySubscription } from '@/server/ports/billing';
import { applyProcessingStateInTx, NO_POST_COMMIT_WORK, type PostCommitWork } from '@/server/services/accounts';
import { lockAccount, lockSubscription, type SubscriptionRow } from './rows';
import { appliedStatus, graceAfter, mapRazorpayStatus } from '@/server/domain/checkout-guard';

// Applying what Razorpay says about one subscription (PLAN §9.9, D-18, D-19). The webhook, the
// checkout's re-fetch, cancel and resume all read Razorpay first (network, outside any transaction)
// and then apply the result here, in one transaction with applyProcessingState:
// - only if newer: a read taken before the stored `last_synced_at` changes nothing, so an older
//   response that arrives late never overwrites a newer one;
// - the status mapped (resumed → active; an undocumented status → the local `unknown` + admin alert,
//   D-18, D-82); a row never goes back to `created` (a `stale` one stays `stale`, an `unknown` one
//   becomes `stale`; the one-`created` index stays true);
// - `pending` starts the grace (payment_failed_at, grace_until = +3 d) from the current failure
//   episode's first pending event (graceAfter), `active` clears it;
// - `status_changed_at` moves only when the status does; the stored link is kept (webhook payloads
//   carry `short_url: null`), Razorpay's dates replace ours when it sends them.

export interface ApplySnapshotInput {
  readonly row: Pick<SubscriptionRow, 'id' | 'accountId'>;
  readonly snapshot: RazorpaySubscription;
  /** When the Razorpay read was made (the Clock, just before the call): the "newer" test. */
  readonly fetchedAt: Date;
  readonly now: Date;
  /** The `created_at` of the `subscription.pending` event that triggered the read, if one did. */
  readonly pendingEventAt?: Date | null | undefined;
  /** Our own cancel asked Razorpay to cancel at the end of the cycle (D-20). */
  readonly cancelAtCycleEnd?: boolean | undefined;
}

export type ApplyOutcome =
  /** Stored; `changed` when the status moved. */
  | { readonly type: 'applied'; readonly previous: SubscriptionStatus; readonly status: SubscriptionStatus; readonly changed: boolean; readonly known: boolean }
  /** A newer read was already applied: nothing changed. */
  | { readonly type: 'not_newer'; readonly status: SubscriptionStatus }
  /** The row (or its account) is gone: purged meanwhile. */
  | { readonly type: 'gone' };

export interface AppliedSnapshot {
  readonly outcome: ApplyOutcome;
  /** applyProcessingState's after-commit work (the billing-inactive email, cancels). */
  readonly work: PostCommitWork;
}

/** Inside the caller's transaction: lock, compare, write, then applyProcessingStateInTx. */
export async function applySnapshotInTx(tx: Db, input: ApplySnapshotInput): Promise<AppliedSnapshot> {
  if (!(await lockAccount(tx, input.row.accountId))) return { outcome: { type: 'gone' }, work: NO_POST_COMMIT_WORK };
  const row = await lockSubscription(tx, input.row.id);
  if (row === null) return { outcome: { type: 'gone' }, work: NO_POST_COMMIT_WORK };
  // Strictly newer stored reads win; a read at the same instant is at least as fresh (a FakeClock that
  // has not moved between the checkout and its webhook, too).
  if (row.lastSyncedAt !== null && row.lastSyncedAt.getTime() > input.fetchedAt.getTime()) {
    return { outcome: { type: 'not_newer', status: row.status }, work: NO_POST_COMMIT_WORK };
  }

  const mapped = mapRazorpayStatus(input.snapshot.status);
  const status: SubscriptionStatus = appliedStatus(row.status, mapped.status);
  const grace = graceAfter(row, status, input.pendingEventAt ?? null, input.fetchedAt);
  const changed = status !== row.status;
  const snapshot = input.snapshot;

  await tx.query(
    `update subscriptions
        set status = $2,
            status_changed_at = case when $3::boolean then $4::timestamptz else status_changed_at end,
            short_url = coalesce(short_url, $5),
            start_at = coalesce($6::timestamptz, start_at),
            expire_by = coalesce($7::timestamptz, expire_by),
            current_start = coalesce($8::timestamptz, current_start),
            current_end = coalesce($9::timestamptz, current_end),
            payment_failed_at = $10,
            grace_until = $11,
            cancel_at_cycle_end = $12,
            last_synced_at = $13
      where id = $1`,
    [
      row.id,
      status,
      changed,
      input.now,
      snapshot.shortUrl === '' ? null : snapshot.shortUrl,
      snapshot.startAt ?? null,
      snapshot.expireBy ?? null,
      snapshot.currentStart ?? null,
      snapshot.currentEnd ?? null,
      grace.paymentFailedAt,
      grace.graceUntil,
      input.cancelAtCycleEnd === true ? true : row.cancelAtCycleEnd,
      input.fetchedAt,
    ],
  );
  const processing = await applyProcessingStateInTx(tx, input.now, row.accountId);
  return {
    outcome: { type: 'applied', previous: row.status, status, changed, known: mapped.known },
    work: processing?.work ?? NO_POST_COMMIT_WORK,
  };
}

/**
 * A `created` row Razorpay still reports as `created` (or that couldn't be read) whose link can no
 * longer be used: marked `stale` locally (PLAN §9.9 step 4). Returns false when it was not `created`.
 */
export async function markStaleInTx(tx: Db, row: Pick<SubscriptionRow, 'id' | 'accountId'>, now: Date): Promise<{ marked: boolean; work: PostCommitWork }> {
  if (!(await lockAccount(tx, row.accountId))) return { marked: false, work: NO_POST_COMMIT_WORK };
  const marked = await tx.maybeOne(`update subscriptions set status = 'stale', status_changed_at = $2 where id = $1 and status = 'created' returning id`, [row.id, now]);
  const processing = await applyProcessingStateInTx(tx, now, row.accountId);
  return { marked: marked !== null, work: processing?.work ?? NO_POST_COMMIT_WORK };
}
