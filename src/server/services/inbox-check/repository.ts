import 'server-only';
import { z } from 'zod';
import { INBOX_CHECK_STATUSES, INBOX_LEG_STATUSES, type InboxCheckStatus, type InboxLegStatus, type LoggingMode } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { INBOX_CHECK_ABANDON_MS } from './constants';

// `inbox_checks` rows (PLAN §5, D-14). The test address is content (cleared after 24 h, D-49): it
// is read only to look up the test contact and to show the owner their own address; it never goes
// into a log line, an error or a job payload (payloads carry the check id).

export interface InboxCheckRow {
  readonly id: string;
  readonly accountId: string;
  /** Null once cleared (24 h). */
  readonly testAddress: string | null;
  readonly testAddressHmac: string;
  readonly testLeadId: string | null;
  readonly historyOutbound30d: number | null;
  readonly historyInbound30d: number | null;
  readonly sendLeg: InboxLegStatus;
  readonly replyLeg: InboxLegStatus;
  readonly sendDeadlineAt: Date | null;
  readonly replyDeadlineAt: Date | null;
  readonly status: InboxCheckStatus;
  readonly createdAt: Date;
  readonly sendResolvedAt: Date | null;
  readonly replyResolvedAt: Date | null;
  readonly closedAt: Date | null;
}

export const INBOX_CHECK_COLUMNS =
  'id, account_id, test_address, test_address_hmac, test_lead_id, history_outbound_30d, history_inbound_30d, send_leg, reply_leg, ' +
  'send_deadline_at, reply_deadline_at, status, created_at, send_resolved_at, reply_resolved_at, closed_at';

const rowSchema = z.object({
  id: z.string(),
  account_id: z.string(),
  test_address: z.string().nullable(),
  test_address_hmac: z.string(),
  test_lead_id: z.string().nullable(),
  history_outbound_30d: z.number().nullable(),
  history_inbound_30d: z.number().nullable(),
  send_leg: z.enum(INBOX_LEG_STATUSES),
  reply_leg: z.enum(INBOX_LEG_STATUSES),
  send_deadline_at: z.date().nullable(),
  reply_deadline_at: z.date().nullable(),
  status: z.enum(INBOX_CHECK_STATUSES),
  created_at: z.date(),
  send_resolved_at: z.date().nullable(),
  reply_resolved_at: z.date().nullable(),
  closed_at: z.date().nullable(),
});

export function toInboxCheckRow(raw: unknown): InboxCheckRow {
  const r = rowSchema.parse(raw);
  return {
    id: r.id,
    accountId: r.account_id,
    testAddress: r.test_address,
    testAddressHmac: r.test_address_hmac,
    testLeadId: r.test_lead_id,
    historyOutbound30d: r.history_outbound_30d,
    historyInbound30d: r.history_inbound_30d,
    sendLeg: r.send_leg,
    replyLeg: r.reply_leg,
    sendDeadlineAt: r.send_deadline_at,
    replyDeadlineAt: r.reply_deadline_at,
    status: r.status,
    createdAt: r.created_at,
    sendResolvedAt: r.send_resolved_at,
    replyResolvedAt: r.reply_resolved_at,
    closedAt: r.closed_at,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCheckId(value: string): boolean {
  return UUID.test(value);
}

/** One check of one account (both ids must match). */
export async function getInboxCheck(db: Db, accountId: string, checkId: string): Promise<InboxCheckRow | null> {
  if (!isCheckId(checkId)) return null;
  const raw = await db.maybeOne(`select ${INBOX_CHECK_COLUMNS} from inbox_checks where id = $1 and account_id = $2`, [checkId, accountId]);
  return raw === null ? null : toInboxCheckRow(raw);
}

/** The account's newest check, or null. */
export async function latestInboxCheck(db: Db, accountId: string): Promise<InboxCheckRow | null> {
  const raw = await db.maybeOne(
    `select ${INBOX_CHECK_COLUMNS} from inbox_checks where account_id = $1 order by created_at desc, id desc limit 1`,
    [accountId],
  );
  return raw === null ? null : toInboxCheckRow(raw);
}

/** SET fragments that close a check, turning its pending legs into `leg` at `$now` (the caller binds $now as `nowParam`). */
function closeWithPendingAs(leg: Extract<InboxLegStatus, 'skipped' | 'failed'>, nowParam: string): string {
  return `status = 'closed', closed_at = ${nowParam},
          send_resolved_at = case when send_leg = 'pending' then ${nowParam} else send_resolved_at end,
          reply_resolved_at = case when reply_leg = 'pending' then ${nowParam} else reply_resolved_at end,
          send_leg = case when send_leg = 'pending' then '${leg}' else send_leg end,
          reply_leg = case when reply_leg = 'pending' then '${leg}' else reply_leg end`;
}

/** Closes every open check of the account, pending legs `skipped` (a new check supersedes them, or the owner skipped). */
export async function closeOpenChecksInTx(tx: Db, accountId: string, now: Date): Promise<number> {
  const rows = await tx.query(
    `update inbox_checks set ${closeWithPendingAs('skipped', '$2')} where account_id = $1 and status = 'open' returning id`,
    [accountId, now],
  );
  return rows.length;
}

/** Closes one open check with its pending legs `skipped` (it could not be checked: revoked, address gone). */
export async function skipOpenLegs(db: Db, checkId: string, now: Date): Promise<boolean> {
  const row = await db.maybeOne(`update inbox_checks set ${closeWithPendingAs('skipped', '$2')} where id = $1 and status = 'open' returning id`, [
    checkId,
    now,
  ]);
  return row !== null;
}

/**
 * The failure path (PLAN §8.3 step 6): the open legs become `failed` and the check closes; the
 * logging mode follows from the final legs. Returns the closed row, or null when it was not open.
 */
export async function failOpenLegsInTx(tx: Db, accountId: string, checkId: string, now: Date): Promise<InboxCheckRow | null> {
  if (!isCheckId(checkId)) return null;
  const raw = await tx.maybeOne(
    `update inbox_checks set ${closeWithPendingAs('failed', '$3')}
      where id = $1 and account_id = $2 and status = 'open' returning ${INBOX_CHECK_COLUMNS}`,
    [checkId, accountId, now],
  );
  return raw === null ? null : toInboxCheckRow(raw);
}

export async function setLoggingModeInTx(tx: Db, accountId: string, mode: LoggingMode): Promise<void> {
  await tx.query(`update accounts set logging_mode = $2 where id = $1`, [accountId, mode]);
}

/**
 * PLAN §9.7 step 6 / §9.10 step 4: a check still without deadlines 24 h after creation is closed
 * with its legs skipped. `accountId` limits it to one account (null: every account).
 */
export async function closeAbandonedInboxChecks(db: Db, now: Date, accountId: string | null = null): Promise<number> {
  const cutoff = new Date(now.getTime() - INBOX_CHECK_ABANDON_MS);
  const rows = await db.query(
    `update inbox_checks set ${closeWithPendingAs('skipped', '$1')}
      where status = 'open' and send_deadline_at is null and created_at <= $2 and ($3::uuid is null or account_id = $3::uuid)
      returning id`,
    [now, cutoff, accountId],
  );
  return rows.length;
}

/** D-49: the test address is cleared 24 h after the check was created; its HMAC stays for the intake skip. */
export async function clearExpiredTestAddresses(db: Db, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - INBOX_CHECK_ABANDON_MS);
  const rows = await db.query(`update inbox_checks set test_address = null where test_address is not null and created_at <= $1 returning id`, [cutoff]);
  return rows.length;
}
