import 'server-only';
import type { Deps } from '@/server/ports';

/**
 * ── M4 HOOK: the global AI daily budget breaker (D-36, PLAN §9.3 step 4) ─────────────────────────
 * True once today's AI spend (`ai_calls.cost_micro_usd` since the UTC day start) reaches
 * `AI_DAILY_BUDGET_USD`. While tripped, classification is skipped (the lead becomes `unclear`, which
 * bounds a classification flood) and lead_process sends the needs-touch email with the minimal safe
 * template plus an admin alert. The breaker itself is built in M4; until then it never trips.
 */
export async function isAiDailyBudgetTripped(_deps: Pick<Deps, 'db' | 'clock' | 'env'>): Promise<boolean> {
  return false;
}
