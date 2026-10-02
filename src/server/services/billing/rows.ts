import 'server-only';
import { z } from 'zod';
import { SUBSCRIPTION_STATUSES, type SubscriptionStatus } from '@/server/domain/types';
import type { Db } from '@/server/db';

// `subscriptions` rows as the billing services read them (PLAN §5). Every logical timestamp is bound
// from the Clock; `last_synced_at` is the instant of the Razorpay read last applied (D-19).

export interface SubscriptionRow {
  readonly id: string;
  readonly accountId: string;
  readonly providerSubscriptionId: string;
  readonly planId: string;
  readonly status: SubscriptionStatus;
  readonly statusChangedAt: Date;
  readonly shortUrl: string | null;
  readonly startAt: Date | null;
  readonly expireBy: Date | null;
  readonly currentStart: Date | null;
  readonly currentEnd: Date | null;
  readonly paymentFailedAt: Date | null;
  readonly graceUntil: Date | null;
  readonly cancelAtCycleEnd: boolean;
  readonly lastSyncedAt: Date | null;
  readonly createdAt: Date;
}

export const SUBSCRIPTION_COLUMNS = `id, account_id, provider_subscription_id, plan_id, status, status_changed_at, short_url, start_at,
  expire_by, current_start, current_end, payment_failed_at, grace_until, cancel_at_cycle_end, last_synced_at, created_at`;

const rowSchema = z.object({
  id: z.string(),
  account_id: z.string(),
  provider_subscription_id: z.string(),
  plan_id: z.string(),
  status: z.enum(SUBSCRIPTION_STATUSES),
  status_changed_at: z.date(),
  short_url: z.string().nullable(),
  start_at: z.date().nullable(),
  expire_by: z.date().nullable(),
  current_start: z.date().nullable(),
  current_end: z.date().nullable(),
  payment_failed_at: z.date().nullable(),
  grace_until: z.date().nullable(),
  cancel_at_cycle_end: z.boolean(),
  last_synced_at: z.date().nullable(),
  created_at: z.date(),
});

export function parseSubscriptionRow(raw: unknown): SubscriptionRow {
  const row = rowSchema.parse(raw);
  return {
    id: row.id,
    accountId: row.account_id,
    providerSubscriptionId: row.provider_subscription_id,
    planId: row.plan_id,
    status: row.status,
    statusChangedAt: row.status_changed_at,
    shortUrl: row.short_url,
    startAt: row.start_at,
    expireBy: row.expire_by,
    currentStart: row.current_start,
    currentEnd: row.current_end,
    paymentFailedAt: row.payment_failed_at,
    graceUntil: row.grace_until,
    cancelAtCycleEnd: row.cancel_at_cycle_end,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
  };
}

/** Every subscription of the account, oldest first (logical `created_at`, then id). */
export async function loadAccountSubscriptions(db: Db, accountId: string): Promise<SubscriptionRow[]> {
  const rows = await db.query(`select ${SUBSCRIPTION_COLUMNS} from subscriptions where account_id = $1 order by created_at, id`, [accountId]);
  return rows.map(parseSubscriptionRow);
}

export async function loadSubscriptionByProviderId(db: Db, providerSubscriptionId: string): Promise<SubscriptionRow | null> {
  const raw = await db.maybeOne(`select ${SUBSCRIPTION_COLUMNS} from subscriptions where provider_subscription_id = $1`, [providerSubscriptionId]);
  return raw === null ? null : parseSubscriptionRow(raw);
}

/**
 * Row lock order (docs/ARCHITECTURE.md): the account first, then its subscription rows. Every billing
 * transaction that writes a subscription also runs applyProcessingStateInTx, which updates the account.
 * Returns false when the account is gone (purged).
 */
export async function lockAccount(tx: Db, accountId: string): Promise<boolean> {
  return (await tx.maybeOne(`select id from accounts where id = $1 for no key update`, [accountId])) !== null;
}

/** The row, locked for this transaction (after lockAccount); null when it is gone. */
export async function lockSubscription(tx: Db, id: string): Promise<SubscriptionRow | null> {
  const raw = await tx.maybeOne(`select ${SUBSCRIPTION_COLUMNS} from subscriptions where id = $1 for update`, [id]);
  return raw === null ? null : parseSubscriptionRow(raw);
}
