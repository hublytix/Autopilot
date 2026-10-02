import 'server-only';
import { z } from 'zod';
import { errorCode } from '@/server/domain/errors';
import type { Db } from '@/server/db';
import { raiseAlert } from '@/server/jobs/alert';
import type { Deps } from '@/server/ports';
import { isLiveStatus, isTerminalStatus } from '@/server/domain/checkout-guard';

// Subscriptions of purged accounts (PLAN §9.10 steps 5-6, D-19, D-48). After the purge only a
// content-free `billing_tombstones` row is left, so a late webhook is harmless: the subscription is
// read from Razorpay and
// - `authenticated`/`active` → cancelled at once (`cancel_at_cycle_end: false`) and the admin is
//   alerted to refund any charge;
// - terminal (`cancelled`/`completed`/`expired`), or `created` past its `expire_by` (it can no longer
//   be authorised) → resolved;
// - `pending`/`halted`/`paused`, an undocumented status (and a still-usable `created`) stay open and
//   are checked again.
// What Razorpay says now always wins: a tombstone resolved earlier that reads live or open again is
// re-opened (`resolved_at = null`), so a cancel that fails keeps it in the daily rotation (D-82).
// The webhook calls it per event (for a resolved tombstone, only on events a live subscription
// sends); the daily cron's reconcile calls it per unresolved row.

export interface TombstoneRow {
  readonly providerSubscriptionId: string;
  readonly lastStatus: string;
  readonly expireBy: Date | null;
  readonly resolvedAt: Date | null;
}

const tombstoneSchema = z.object({
  provider_subscription_id: z.string(),
  last_status: z.string(),
  expire_by: z.date().nullable(),
  resolved_at: z.date().nullable(),
});

export async function loadTombstone(db: Db, providerSubscriptionId: string): Promise<TombstoneRow | null> {
  const raw = await db.maybeOne(
    `select provider_subscription_id, last_status, expire_by, resolved_at from billing_tombstones where provider_subscription_id = $1`,
    [providerSubscriptionId],
  );
  if (raw === null) return null;
  const row = tombstoneSchema.parse(raw);
  return { providerSubscriptionId: row.provider_subscription_id, lastStatus: row.last_status, expireBy: row.expire_by, resolvedAt: row.resolved_at };
}

export type TombstoneOutcome =
  /** Was live: cancelled now; the admin was alerted to refund. */
  | { readonly type: 'cancelled' }
  /** Terminal, or a link that can no longer be used: resolved. */
  | { readonly type: 'resolved' }
  /** Still open (pending, halted, paused, or a usable created link): checked again later. */
  | { readonly type: 'open'; readonly status: string }
  /** Live, but the cancel failed: still open, the admin was alerted. */
  | { readonly type: 'cancel_failed' };

async function record(db: Db, providerSubscriptionId: string, status: string, now: Date, resolved: boolean): Promise<void> {
  await db.query(
    `update billing_tombstones
        set last_status = $2, last_checked_at = $3, resolved_at = case when $4::boolean then coalesce(resolved_at, $3) end
      where provider_subscription_id = $1`,
    [providerSubscriptionId, status.slice(0, 64), now, resolved],
  );
}

/**
 * Reads the tombstoned subscription from Razorpay and acts on it (see above). Throws the Billing
 * port's error when the read fails (the webhook answers 5xx so Razorpay retries; the reconcile
 * tries again the next day).
 */
export async function reconcileTombstone(deps: Deps, tombstone: TombstoneRow): Promise<TombstoneOutcome> {
  const id = tombstone.providerSubscriptionId;
  const snapshot = await deps.billing.fetchSubscription(id);
  const now = deps.clock.now();
  const status = snapshot.status === 'resumed' ? 'active' : snapshot.status;

  if (isLiveStatus(status)) {
    try {
      const cancelled = await deps.billing.cancelSubscription(id, false);
      await record(deps.db, id, cancelled.status, deps.clock.now(), isTerminalStatus(cancelled.status));
      raiseAlert('billing_tombstone_cancelled_refund', { subscriptionId: id });
      return { type: 'cancelled' };
    } catch (error) {
      await record(deps.db, id, status, now, false);
      raiseAlert('billing_tombstone_cancel_failed', { subscriptionId: id, errorCode: errorCode(error) });
      return { type: 'cancel_failed' };
    }
  }

  const expireBy = snapshot.expireBy ?? tombstone.expireBy;
  const unusableLink = status === 'created' && expireBy !== null && expireBy.getTime() <= now.getTime();
  if (isTerminalStatus(status) || unusableLink) {
    await record(deps.db, id, status, now, true);
    return { type: 'resolved' };
  }
  await record(deps.db, id, status, now, false);
  return { type: 'open', status };
}
