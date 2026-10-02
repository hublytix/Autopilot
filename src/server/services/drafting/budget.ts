import 'server-only';
import { errorCode } from '@/server/domain/errors';
import type { Db } from '@/server/db';
import { raiseAlert } from '@/server/jobs/alert';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { claimOnce, rateLimitKeyHash } from '@/server/security/rate-limit';

// The global AI daily budget breaker (D-36, PLAN §9.3 step 4). Today's spend is the sum of
// `ai_calls.cost_micro_usd` since the start of the current UTC day (`$now` bound from the Clock);
// at or over `AI_DAILY_BUDGET_USD` the breaker is tripped until the next UTC midnight. While it is
// tripped no LLM call is made: classification answers `unclear` (which bounds a classification
// flood) and drafting falls back to the minimal safe template (needs touch), so no lead is silent.
// The admin gets one `ai_daily_budget_reached` alert per UTC day, through a once-only marker in
// `rate_limits` (the first caller to see the breaker tripped that day raises it).
//
// Per-account share (an addition to D-36): one account's spend today (its `ai_calls` rows) at or
// over its share of the budget trips the breaker for that account only, so one portal flooded
// through its public form cannot use up the global budget and leave every other account without
// drafts until UTC midnight. The share is a tenth of the budget, but never less than four typical
// draft calls per lead of the daily cap (a busy, genuine account stays well inside it), and never
// more than the budget. One `ai_account_share_reached` alert per account per UTC day.
//
// Both checks read the recorded spend, so concurrent calls can overshoot: at most (concurrent
// lead_process jobs) × 2 draft attempts × one max-tokens call each, plus the in-flight
// classifications, since every check happens before its call and records after it.

export type BudgetDeps = Pick<Deps, 'db' | 'clock' | 'env'>;

/** The start of `now`'s UTC day. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** AI spend in micro-USD since the start of `now`'s UTC day (calls recorded after `now` are not counted). */
export async function aiSpendTodayMicroUsd(db: Db, now: Date): Promise<number> {
  const row = await db.one<{ total: string }>(
    `select coalesce(sum(cost_micro_usd), 0)::text as total from ai_calls where created_at >= $1 and created_at <= $2`,
    [utcDayStart(now), now],
  );
  return Number(row.total);
}

/** AI_DAILY_BUDGET_USD in micro-USD. */
export function aiDailyBudgetMicroUsd(env: BudgetDeps['env']): number {
  return Math.round(env.AI_DAILY_BUDGET_USD * 1_000_000);
}

/** A typical draft call in micro-USD (TV6: 1500 in / 250 out on Sonnet 5.5). */
export const TYPICAL_DRAFT_CALL_MICRO_USD = 5_500;
/** The part of the budget one account may use in a UTC day, before the floor. */
export const ACCOUNT_SHARE_OF_BUDGET = 0.1;
/** Draft calls allowed per lead of the daily cap in the floor (2 attempts, plus classifications and briefs). */
const FLOOR_CALLS_PER_CAPPED_LEAD = 4;

/** One account's daily AI share in micro-USD: max(budget / 10, 4 typical draft calls × MAX_DRAFTED_LEADS_PER_DAY), at most the budget. */
export function aiAccountShareMicroUsd(env: BudgetDeps['env']): number {
  const budget = aiDailyBudgetMicroUsd(env);
  const floor = env.MAX_DRAFTED_LEADS_PER_DAY * FLOOR_CALLS_PER_CAPPED_LEAD * TYPICAL_DRAFT_CALL_MICRO_USD;
  return Math.min(budget, Math.max(Math.round(budget * ACCOUNT_SHARE_OF_BUDGET), floor));
}

/** One account's AI spend in micro-USD since the start of `now`'s UTC day. */
export async function aiAccountSpendTodayMicroUsd(db: Db, accountId: string, now: Date): Promise<number> {
  const row = await db.one<{ total: string }>(
    `select coalesce(sum(cost_micro_usd), 0)::text as total from ai_calls
      where account_id = $1 and created_at >= $2 and created_at <= $3`,
    [accountId, utcDayStart(now), now],
  );
  return Number(row.total);
}

/** One admin alert per `marker` and UTC day; a failing marker write alerts anyway (never silent). */
async function alertOncePerDay(deps: BudgetDeps, now: Date, marker: string, alert: () => void): Promise<void> {
  let first = true;
  try {
    first = await claimOnce(deps.db, { keyHash: rateLimitKeyHash(deps.env, marker), windowStart: utcDayStart(now) });
  } catch (error) {
    log.warn('ai budget alert marker not written', { event: 'ai_budget.marker_failed', errorCode: errorCode(error) });
  }
  if (first) alert();
}

export interface BudgetScope {
  /** The account the call is for: its share is checked too. Omit only for calls that belong to no account. */
  readonly accountId?: string | null | undefined;
}

/**
 * True while today's AI spend is at or over AI_DAILY_BUDGET_USD, or the account's spend is at or
 * over its share; the first check that finds either on a UTC day alerts the admin. Callers make no
 * LLM call while it is true.
 */
export async function isAiDailyBudgetTripped(deps: BudgetDeps, scope: BudgetScope = {}): Promise<boolean> {
  const now = deps.clock.now();
  const spent = await aiSpendTodayMicroUsd(deps.db, now);
  const budget = aiDailyBudgetMicroUsd(deps.env);
  if (spent >= budget) {
    log.warn('ai daily budget reached: no AI calls', { event: 'ai_budget.tripped', total: spent, limit: budget });
    await alertOncePerDay(deps, now, 'ai_daily_budget', () => raiseAlert('ai_daily_budget_reached', { total: spent, limit: budget }));
    return true;
  }
  const accountId = scope.accountId ?? null;
  if (accountId === null) return false;
  const accountSpent = await aiAccountSpendTodayMicroUsd(deps.db, accountId, now);
  const share = aiAccountShareMicroUsd(deps.env);
  if (accountSpent < share) return false;
  log.warn("account's AI share reached: no AI calls for it", { event: 'ai_budget.account_share_tripped', accountId, total: accountSpent, limit: share });
  await alertOncePerDay(deps, now, `ai_account_share:${accountId}`, () =>
    raiseAlert('ai_account_share_reached', { accountId, total: accountSpent, limit: share }),
  );
  return true;
}
