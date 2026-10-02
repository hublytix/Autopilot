import 'server-only';
import { conservativeCostMicroUsd, hasKnownPrice } from '@/server/ai/pricing';
import type { AiCallOutcome, AiCallPurpose, RefusalCategory } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { raiseAlert } from '@/server/jobs/alert';
import type { LlmResult } from '@/server/ports/llm';

// One `ai_calls` row per LLM attempt (PLAN §5, AI-USAGE-FIELDS): ids, model, request id, stop
// reason, refusal category, token counts, cost, latency and outcome. Never content (law 4).
// Used by classification now; the brief (M3) and drafts (M4) record through the same function.

const INT32_MAX = 2_147_483_647;

export interface AiCallRecord {
  accountId: string | null;
  leadId: string | null;
  purpose: AiCallPurpose;
  /** 1-based. */
  attempt: number;
  /** `response.model` when the API answered, else the requested model. */
  model: string;
  requestId: string | null;
  stopReason: string | null;
  refusalCategory: RefusalCategory | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** The exact cost; for a model without a known price, the cost at the most expensive known rate (`costEstimated`). */
  costMicroUsd: number;
  /** The serving model has no known price: `costMicroUsd` is the conservative estimate, and recording it alerts the admin. */
  costEstimated: boolean;
  latencyMs: number;
  outcome: AiCallOutcome;
  createdAt: Date;
}

function int(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), INT32_MAX) : 0;
}

export interface AiCallContext {
  accountId: string | null;
  leadId: string | null;
  purpose: AiCallPurpose;
  attempt: number;
  /** The model that was requested (used when the call failed before the API named one). */
  requestedModel: string;
  startedAt: Date;
  finishedAt: Date;
}

/** The row for one finished call (pure). A call that never reached the API has no usage and costs 0. */
export function aiCallRecord<T>(context: AiCallContext, result: LlmResult<T>, outcome: AiCallOutcome = result.ok ? 'ok' : result.failure): AiCallRecord {
  const model = result.model ?? context.requestedModel;
  const usage = result.usage;
  const refusalCategory = result.ok ? null : (result.refusalCategory ?? null);
  const stopReason = result.stopReason ?? null;
  const cost = usage === undefined ? 0 : conservativeCostMicroUsd({ model, usage, stopReason, refusalCategory });
  const costEstimated = usage !== undefined && !hasKnownPrice(model);
  return {
    accountId: context.accountId,
    leadId: context.leadId,
    purpose: context.purpose,
    attempt: Math.max(1, int(context.attempt)),
    model,
    requestId: result.requestId ?? null,
    stopReason,
    refusalCategory,
    inputTokens: int(usage?.inputTokens),
    outputTokens: int(usage?.outputTokens),
    cacheCreationInputTokens: int(usage?.cacheWriteTokens),
    cacheReadInputTokens: int(usage?.cacheReadTokens),
    costMicroUsd: int(cost),
    costEstimated,
    latencyMs: int(context.finishedAt.getTime() - context.startedAt.getTime()),
    outcome,
    createdAt: context.finishedAt,
  };
}

/**
 * Inserts the row and returns its id (int8, as a string). A model without a known price is stored
 * at the most expensive known rate, so the budget breaker errs towards tripping, and raises an admin
 * alert so the rate table gets updated (D-25, D-36). Such rows are the ones whose `model` the rate
 * table does not list.
 */
export async function recordAiCall(db: Db, record: AiCallRecord): Promise<string> {
  if (record.costEstimated) raiseAlert('ai_price_unknown_model', { model: record.model, purpose: record.purpose, reason: 'costed_at_highest_known_rate' });
  const row = await db.one<{ id: string }>(
    `insert into ai_calls (account_id, lead_id, purpose, attempt, model, request_id, stop_reason, refusal_category,
                           input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
                           cost_micro_usd, latency_ms, outcome, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     returning id`,
    [
      record.accountId,
      record.leadId,
      record.purpose,
      record.attempt,
      record.model,
      record.requestId,
      record.stopReason,
      record.refusalCategory,
      record.inputTokens,
      record.outputTokens,
      record.cacheCreationInputTokens,
      record.cacheReadInputTokens,
      record.costMicroUsd,
      record.latencyMs,
      record.outcome,
      record.createdAt,
    ],
  );
  return row.id;
}
