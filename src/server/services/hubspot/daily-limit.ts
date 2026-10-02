import 'server-only';
import { DateTime } from 'luxon';
import { isAppError, TransientError } from '@/server/domain/errors';
import type { Db } from '@/server/db';
import { log } from '@/server/obs/log';

// HubSpot's daily limit (D-11: "a daily-limit 429 defers to the next local midnight";
// HS-429-SHAPE `policyName: DAILY`). The live client throws TransientError('hubspot_daily_limit')
// without a Retry-After. The portal client turns it into a hold on the portal:
// `hubspot_connections.daily_limit_until` = the next midnight in the account's timezone (UTC when
// unknown) plus a small margin for clock skew, and rethrows the error with `retryAfterMs` up to
// that instant. Until then every caller is refused before HubSpot is called: the poll cron skips
// the portal, and a job's TransientError re-targets it to the hold's end through the dispatcher's
// long-wait rule (D-11; bounded by the claim count, so a portal that stays limited still fails).

export const DAILY_LIMIT_CODE = 'hubspot_daily_limit';
/** After local midnight: HubSpot resets at midnight, and an early retry would cost another day. */
export const DAILY_LIMIT_RESUME_MARGIN_MS = 10 * 60 * 1000;

export function isDailyLimit(error: unknown): boolean {
  return isAppError(error) && error.code === DAILY_LIMIT_CODE;
}

/** The next midnight after `now` in `timezone` (UTC when unknown or invalid), plus the margin. */
export function dailyLimitResumeAt(now: Date, timezone: string | null): Date {
  const zoned = DateTime.fromJSDate(now, { zone: timezone ?? 'UTC' });
  const local = zoned.isValid ? zoned : DateTime.fromJSDate(now, { zone: 'UTC' });
  return new Date(local.startOf('day').plus({ days: 1 }).toMillis() + DAILY_LIMIT_RESUME_MARGIN_MS);
}

/** Whether a hold recorded on the connection still applies at `now`. */
export function dailyLimitActive(connection: { daily_limit_until: Date | null }, now: Date): boolean {
  return connection.daily_limit_until !== null && now.getTime() < connection.daily_limit_until.getTime();
}

/** The TransientError callers see while the portal is held: Retry-After up to the hold's end. */
export function dailyLimitError(until: Date, now: Date): TransientError {
  return new TransientError(DAILY_LIMIT_CODE, { httpStatus: 429, retryAfterMs: Math.max(0, until.getTime() - now.getTime()) });
}

/** The current hold for the account's connection, or null. */
export async function currentDailyLimit(db: Db, accountId: string, now: Date): Promise<Date | null> {
  const row = await db.maybeOne<{ daily_limit_until: Date | null }>(`select daily_limit_until from hubspot_connections where account_id = $1`, [
    accountId,
  ]);
  return row !== null && dailyLimitActive(row, now) ? row.daily_limit_until : null;
}

/** Records the hold (never shortening one already stored) and returns its end. */
export async function recordDailyLimit(db: Db, accountId: string, now: Date): Promise<Date> {
  const account = await db.maybeOne<{ timezone: string | null }>(`select timezone from accounts where id = $1`, [accountId]);
  const resumeAt = dailyLimitResumeAt(now, account?.timezone ?? null);
  const row = await db.maybeOne<{ daily_limit_until: Date }>(
    `update hubspot_connections set daily_limit_until = greatest(coalesce(daily_limit_until, $2), $2)
      where account_id = $1 returning daily_limit_until`,
    [accountId, resumeAt],
  );
  const until = row?.daily_limit_until ?? resumeAt;
  log.warn('hubspot daily limit reached', { event: 'hubspot.daily_limit', accountId, delayMs: until.getTime() - now.getTime() });
  return until;
}
