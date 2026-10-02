import 'server-only';
import { PermanentError } from '@/server/domain/errors';
import type { NotificationKind } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { bindPredicate, type NotificationPredicate } from './predicates';
import { NOTIFICATION_COLUMNS, toNotificationRow, type NotificationRow } from './types';

// Reservation and takeover (PLAN §8.4 steps 1-2). The reservation row is the exactly-once lock for
// one owner email; only `sent` blocks a resend.

export interface ReserveInput {
  kind: NotificationKind;
  dedupeKey: string;
  accountId: string | null;
  leadId?: string | null | undefined;
  /** The kind's predicates (NotificationPredicates); omitted only for kinds without any. */
  predicates?: NotificationPredicate | undefined;
  /** `$now`. */
  now: Date;
}

// Ids, dates, ISO instants and HMACs: never content (the key also reaches Resend's idempotency key).
const DEDUPE_KEY = /^[a-z][a-z0-9-]*:[A-Za-z0-9:._@+-]{1,200}$/;

export class InvalidNotificationKeyError extends PermanentError<'notification_invalid_dedupe_key'> {
  override readonly name: string = 'InvalidNotificationKeyError';

  constructor() {
    super('notification_invalid_dedupe_key');
  }
}

/**
 * Step 1: `INSERT … SELECT … WHERE <predicates> ON CONFLICT (dedupe_key) DO NOTHING`. Returns the new
 * `sending` row, or null when the key exists or a predicate failed. Use it inside another
 * transaction (revoke, → inactive, markReplied) and call sendReserved after commit.
 */
export async function reserveInTx(db: Db, input: ReserveInput): Promise<NotificationRow | null> {
  if (!DEDUPE_KEY.test(input.dedupeKey)) throw new InvalidNotificationKeyError();
  const params: unknown[] = [input.dedupeKey, input.accountId, input.leadId ?? null, input.kind, input.now];
  const predicate = input.predicates === undefined ? 'true' : bindPredicate(input.predicates, params);
  const raw = await db.maybeOne(
    `insert into notifications_sent
       (dedupe_key, account_id, lead_id, kind, status, first_reserved_at, reserved_at, send_attempts, sweeper_resumes, recipients_count)
     select $1::text, $2::uuid, $3::uuid, $4::text, 'sending', $5::timestamptz, $5::timestamptz, 0, 0, 0
      where ${predicate}
     on conflict (dedupe_key) do nothing
     returning ${NOTIFICATION_COLUMNS}`,
    params,
  );
  return raw === null ? null : toNotificationRow(raw);
}

export async function getNotification(db: Db, dedupeKey: string): Promise<NotificationRow | null> {
  const raw = await db.maybeOne(`select ${NOTIFICATION_COLUMNS} from notifications_sent where dedupe_key = $1`, [dedupeKey]);
  return raw === null ? null : toNotificationRow(raw);
}

export type TakeoverResult =
  | { readonly type: 'taken'; readonly row: NotificationRow }
  /** The new kind's predicates fail: the row is now `failed` and the caller skips. */
  | { readonly type: 'predicates_failed' }
  /** Someone else changed the row first. */
  | { readonly type: 'busy' };

/**
 * Step 2's takeover of a `sending` row: `UPDATE … SET kind = $k, reserved_at = $now WHERE status =
 * 'sending' AND kind = $oldKind AND reserved_at = $oldAt AND <predicates for $k>`. A sweeper resume
 * also counts itself in `sweeper_resumes`. When the predicates fail the row becomes `failed`.
 */
export async function takeOver(
  db: Db,
  existing: NotificationRow,
  kind: NotificationKind,
  predicates: NotificationPredicate,
  now: Date,
  options: { bySweeper?: boolean | undefined } = {},
): Promise<TakeoverResult> {
  const params: unknown[] = [existing.dedupeKey, kind, now, existing.kind, existing.reservedAt];
  const predicate = bindPredicate(predicates, params);
  const raw = await db.maybeOne(
    `update notifications_sent
        set kind = $2, reserved_at = $3 ${options.bySweeper === true ? ', sweeper_resumes = sweeper_resumes + 1' : ''}
      where dedupe_key = $1 and status = 'sending' and kind = $4 and reserved_at = $5 and ${predicate}
      returning ${NOTIFICATION_COLUMNS}`,
    params,
  );
  if (raw !== null) return { type: 'taken', row: toNotificationRow(raw) };

  const failParams: unknown[] = [existing.dedupeKey, existing.kind, existing.reservedAt];
  const failPredicate = bindPredicate(predicates, failParams);
  const failed = await db.maybeOne(
    `update notifications_sent set status = 'failed'
      where dedupe_key = $1 and status = 'sending' and kind = $2 and reserved_at = $3 and not (${failPredicate})
      returning id`,
    failParams,
  );
  return failed === null ? { type: 'busy' } : { type: 'predicates_failed' };
}

/** Marks a `sending` row failed unless someone changed it (sweeper expiry, un-renderable kinds). */
export async function failReservation(db: Db, row: NotificationRow): Promise<boolean> {
  const rows = await db.query(
    `update notifications_sent set status = 'failed' where id = $1 and status = 'sending' and reserved_at = $2 returning id`,
    [row.id, row.reservedAt],
  );
  return rows.length === 1;
}
