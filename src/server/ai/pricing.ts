import 'server-only';
import type { RefusalCategory } from '@/server/domain/types';
import type { LlmUsage } from '@/server/ports/llm';

// AI call cost in integer micro-USD [AI-PRICING-COST, AI-REFUSAL-HANDLING], keyed by the model that
// served the request (`response.model`, D-25): the two models' prices differ 2x, and Sonnet 5.5's
// tokenizer yields more tokens for the same text.
// - `outputTokens` already includes thinking tokens (the authoritative billing total).
// - `inputTokens` excludes cached tokens; cache reads and writes are priced on their own.
// - Cache writes are priced at the 5-minute rate: the app never requests the 1-hour TTL (and uses no
//   prompt caching in v1 at all).
// - A refusal before any output (`output_tokens` 0) is billed only in the `bio`, `frontier_llm` and
//   `reasoning_extraction` categories; otherwise it costs 0. This is a heuristic: the docs bill by
//   "before any output", and the stored usage numbers are not the billed ones.
// - An unknown model has no cost (`null`): the caller records 0 and raises an admin alert, because a
//   guessed rate would make the budget breaker wrong in either direction.
// Rates in nano-USD per token (USD per million tokens × 1000), so fractional micro-USD rates stay
// integers; the total is rounded up to whole micro-USD. Prices as of 2026-10-01: re-check the
// pricing page during WIRE_UP.

interface Rates {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheRead: number;
}

const SONNET_5_5: Rates = { input: 2000, output: 10_000, cacheWrite5m: 2500, cacheRead: 200 };
const HAIKU_4_5: Rates = { input: 1000, output: 5000, cacheWrite5m: 1250, cacheRead: 100 };

/** Prices as of 2026-10-01 (platform.claude.com/docs/en/about-claude/pricing). */
const RATES: Readonly<Record<string, Rates>> = {
  'claude-sonnet-5-5': SONNET_5_5,
  'claude-haiku-4-5-20251001': HAIKU_4_5,
  'claude-haiku-4-5': HAIKU_4_5,
};

/** Refusal categories whose before-output refusals are still billed (as of September 2026). */
const BILLED_REFUSAL_CATEGORIES: ReadonlySet<RefusalCategory> = new Set<RefusalCategory>(['bio', 'frontier_llm', 'reasoning_extraction']);

function ratesFor(model: string): Rates | undefined {
  return Object.hasOwn(RATES, model) ? RATES[model] : undefined;
}

export function hasKnownPrice(model: string): boolean {
  return ratesFor(model) !== undefined;
}

export interface CostInput {
  /** `response.model`. */
  model: string;
  usage: LlmUsage;
  stopReason?: string | null | undefined;
  refusalCategory?: RefusalCategory | null | undefined;
}

function count(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** The call's cost in micro-USD, or null when the model has no known price. */
export function costMicroUsd(input: CostInput): number | null {
  const rates = ratesFor(input.model);
  if (rates === undefined) return null;
  const { usage } = input;
  const output = count(usage.outputTokens);
  if (input.stopReason === 'refusal' && output === 0) {
    const category = input.refusalCategory ?? null;
    if (category === null || !BILLED_REFUSAL_CATEGORIES.has(category)) return 0;
  }
  const nano =
    count(usage.inputTokens) * rates.input +
    output * rates.output +
    count(usage.cacheWriteTokens) * rates.cacheWrite5m +
    count(usage.cacheReadTokens) * rates.cacheRead;
  return Math.ceil(nano / 1000);
}
