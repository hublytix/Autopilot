import 'server-only';
import { DateTime } from 'luxon';
import type { Db } from '@/server/db';
import type { Env } from '@/server/env';
import { rateLimitKeyHash } from '@/server/security/rate-limit';
import { DEV_OUTBOX_KEEP_DAYS, pruneFakeOutbox } from '@/server/services/purge/fake-outbox';

// PLAN §9.10 step 7, run by the daily cron: prune the logs and the expired rows nothing reads any
// more. Every cutoff is computed from the Clock's `$now` and bound as a parameter.
// - `webhook_events` older than 30 d (the Razorpay replay window is 16 d, D-19; HubSpot retries for
//   about 3 d), by `recorded_at`, the logical instant both webhook handlers bind from the Clock
//   (never the audit-only `received_at`, the database's wall clock, D-28, D-82);
// - expired `action_tokens` (a link past `expires_at` is refused anyway, D-45);
// - `rate_limits` windows (D-36): every row is an HMAC key and a window start, so the prune cannot
//   tell the limiters apart and uses the longest purpose that matters. Each fixed-window counter
//   (1 s portal slots, 1-15 min route limits, the 5-minute lead-page refresh) and each once-only
//   marker (beacon nonces: 15 min; OAuth states: window = the state's expiry; an install's
//   distinct-email slots: the 24 h pending_install cookie; the daily AI-budget, Resend daily-quota
//   and verify-notify windows: one UTC day) is useless one day after its window started, so rows
//   are deleted two days after it. The one exception is the Resend monthly-quota marker (one alert
//   per UTC month, services/notifications/send.ts), whose key is known: it is kept 32 days;
// - `ai_calls` older than 13 months (the AI budget reads only today's rows; the admin page shows
//   recent costs);
// - fake mode only: `fake.dev_outbox` rows older than 30 d (the emails' full text, D-82).

export const WEBHOOK_EVENTS_KEEP_DAYS = 30;
export const RATE_LIMIT_WINDOW_KEEP_MS = 2 * 24 * 60 * 60 * 1000;
export const MONTHLY_MARKER_KEEP_MS = 32 * 24 * 60 * 60 * 1000;
export const AI_CALLS_KEEP_MONTHS = 13;

/**
 * The rate_limits key of the Resend monthly-quota marker: `resend_quota:monthly_quota_exceeded`, as
 * alertQuotaOnce in services/notifications/send.ts builds it.
 */
export function monthlyQuotaMarkerKey(env: Env): string {
  return rateLimitKeyHash(env, 'resend_quota:monthly_quota_exceeded');
}

export interface PruneSummary {
  readonly webhookEventsDeleted: number;
  readonly actionTokensDeleted: number;
  readonly rateLimitRowsDeleted: number;
  readonly aiCallsDeleted: number;
  /** Fake mode's dev outbox (0 in live mode, where the table does not exist). */
  readonly devOutboxDeleted: number;
}

function minus(now: Date, duration: { days?: number; months?: number }): Date {
  return DateTime.fromJSDate(now, { zone: 'utc' }).minus(duration).toJSDate();
}

export async function pruneExpiredRows(db: Db, env: Env, now: Date): Promise<PruneSummary> {
  const webhooks = await db.query(`delete from webhook_events where recorded_at < $1 returning id`, [minus(now, { days: WEBHOOK_EVENTS_KEEP_DAYS })]);
  const tokens = await db.query(`delete from action_tokens where expires_at < $1 returning id`, [now]);
  const windows = await db.query(
    `delete from rate_limits
      where (window_start < $1 and key_hash <> $3) or window_start < $2
     returning key_hash`,
    [new Date(now.getTime() - RATE_LIMIT_WINDOW_KEEP_MS), new Date(now.getTime() - MONTHLY_MARKER_KEEP_MS), monthlyQuotaMarkerKey(env)],
  );
  const aiCalls = await db.query(`delete from ai_calls where created_at < $1 returning id`, [minus(now, { months: AI_CALLS_KEEP_MONTHS })]);
  const devOutbox = env.APP_MODE === 'fake' ? await pruneFakeOutbox(db, minus(now, { days: DEV_OUTBOX_KEEP_DAYS })) : 0;
  return {
    webhookEventsDeleted: webhooks.length,
    actionTokensDeleted: tokens.length,
    rateLimitRowsDeleted: windows.length,
    aiCallsDeleted: aiCalls.length,
    devOutboxDeleted: devOutbox,
  };
}
