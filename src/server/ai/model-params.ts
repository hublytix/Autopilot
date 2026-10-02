import 'server-only';
import { ConfigError } from '@/server/domain/errors';
import { ENV_DEFAULTS, type Env } from '@/server/env';

// Per-model request parameters (D-24, D-25) [AI-MODEL-CAPABILITY-MAP, AI-SONNET55-REQUEST,
// AI-HAIKU45-REQUEST, AI-REQUEST-RECOMMENDATIONS]. The two env model ids are not interchangeable:
// Sonnet 5.5 returns 400 for thinking enabled/disabled, sampling parameters, prefill and forced
// tool_choice; Haiku 4.5 rejects adaptive thinking and does not support effort. The Models API cannot
// say which thinking types a model takes, so this is a static map covering exactly the D-24 table:
//
// | Model / purpose                | thinking                  | effort                 | max_tokens                 |
// |--------------------------------|---------------------------|------------------------|----------------------------|
// | Sonnet 5.5, draft / follow-up  | ANTHROPIC_DRAFT_THINKING  | ANTHROPIC_DRAFT_EFFORT | ANTHROPIC_DRAFT_MAX_TOKENS |
// | Sonnet 5.5, brief, attempt 1   | adaptive                  | ANTHROPIC_BRIEF_EFFORT | 16000                      |
// | Sonnet 5.5, brief, attempt ≥ 2 | between_tools             | high                   | 4096                       |
// | Sonnet 5.5, classification     | between_tools             | low                    | 256                        |
// | Haiku 4.5, classification      | (omitted)                 | (omitted)              | 256                        |
//
// A draft retry after `max_tokens` doubles the draft budget (capped at 16000) [AI-SO-REFUSAL-MAXTOKENS].
// Haiku 4.5 as the draft model omits thinking and effort like its classification row. Any other
// model id is refused (ConfigError 'anthropic_model_not_supported'): FATAL-CONFIG at the first
// call, never a guessed request shape; Covered Models (Fable/Mythos) are therefore never sent.
// Never produced on any path: temperature/top_p/top_k, prefill, tools, tool_choice.

export const AI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AiEffort = (typeof AI_EFFORTS)[number];

/** `between_tools` is accepted only at these efforts; xhigh/max return 400 [AI-SONNET55-REQUEST]. */
const BETWEEN_TOOLS_EFFORTS: ReadonlySet<string> = new Set<AiEffort>(['low', 'medium', 'high']);

export type AiThinking = { readonly type: 'adaptive' } | { readonly type: 'between_tools' };

/** What a call is for; the baseline's in-memory classification uses `classify`. */
export const MODEL_PURPOSES = ['classify', 'brief', 'draft', 'followup'] as const;
export type ModelPurpose = (typeof MODEL_PURPOSES)[number];

/** The request fields this module decides. `output_config.format` is added by the caller. */
export interface ModelParams {
  readonly max_tokens: number;
  readonly thinking?: AiThinking;
  readonly output_config?: { readonly effort: AiEffort };
}

export interface ModelParamsInput {
  model: string;
  purpose: ModelPurpose;
  /** 1 for the first attempt. For the brief, any delivery after the first (or after an abort) is ≥ 2. */
  attempt: number;
  /** The remaining function budget; becomes the per-call SDK timeout and abort signal (D-24). */
  remainingMs?: number | undefined;
  /** Drafts only: the previous attempt stopped at `max_tokens`, so this one gets a larger budget. */
  afterMaxTokens?: boolean | undefined;
}

export interface ModelCallParams {
  readonly params: ModelParams;
  /** Per-call `{timeout, signal: AbortSignal.timeout(...)}`; undefined = the client default. */
  readonly timeoutMs: number | undefined;
}

/** The env settings the table reads. */
export interface ModelParamsConfig {
  readonly draftThinking: AiThinking['type'];
  readonly draftEffort: AiEffort;
  readonly draftMaxTokens: number;
  readonly briefEffort: AiEffort;
}

type ModelParamsEnv = Pick<Env, 'ANTHROPIC_DRAFT_THINKING' | 'ANTHROPIC_DRAFT_EFFORT' | 'ANTHROPIC_DRAFT_MAX_TOKENS' | 'ANTHROPIC_BRIEF_EFFORT'>;

export function modelParamsConfig(env: ModelParamsEnv): ModelParamsConfig {
  return Object.freeze({
    draftThinking: env.ANTHROPIC_DRAFT_THINKING,
    draftEffort: env.ANTHROPIC_DRAFT_EFFORT,
    draftMaxTokens: env.ANTHROPIC_DRAFT_MAX_TOKENS,
    briefEffort: env.ANTHROPIC_BRIEF_EFFORT,
  });
}

/** The PLAN §14 defaults (between_tools / medium / 1024; brief high). */
export const DEFAULT_MODEL_PARAMS_CONFIG: ModelParamsConfig = modelParamsConfig({
  ANTHROPIC_DRAFT_THINKING: ENV_DEFAULTS.ANTHROPIC_DRAFT_THINKING,
  ANTHROPIC_DRAFT_EFFORT: ENV_DEFAULTS.ANTHROPIC_DRAFT_EFFORT,
  ANTHROPIC_DRAFT_MAX_TOKENS: Number(ENV_DEFAULTS.ANTHROPIC_DRAFT_MAX_TOKENS),
  ANTHROPIC_BRIEF_EFFORT: ENV_DEFAULTS.ANTHROPIC_BRIEF_EFFORT,
});

export const CLASSIFY_MAX_TOKENS = 256;
export const BRIEF_MAX_TOKENS = 16000;
export const BRIEF_FALLBACK_MAX_TOKENS = 4096;
/** The SDK's non-streaming guard and the research keep every path at or below this [V3]. */
export const MAX_TOKENS_CEILING = 16000;

type ModelFamily = 'sonnet-5-5' | 'haiku-4-5';

/** The supported model ids (dateless Sonnet 5.5 is the pinned snapshot; Haiku's alias resolves to its snapshot). */
const MODEL_FAMILIES: Readonly<Record<string, ModelFamily>> = {
  'claude-sonnet-5-5': 'sonnet-5-5',
  'claude-haiku-4-5-20251001': 'haiku-4-5',
  'claude-haiku-4-5': 'haiku-4-5',
};

/** Max output tokens on the synchronous Messages API [AI-MODEL-SONNET55, AI-MODEL-HAIKU45]. */
const MAX_OUTPUT_TOKENS: Readonly<Record<ModelFamily, number>> = { 'sonnet-5-5': 128_000, 'haiku-4-5': 64_000 };

function familyOf(model: string): ModelFamily | undefined {
  return Object.hasOwn(MODEL_FAMILIES, model) ? MODEL_FAMILIES[model] : undefined;
}

export function isSupportedModel(model: string): boolean {
  return familyOf(model) !== undefined;
}

function sonnet(thinking: AiThinking['type'], effort: AiEffort, maxTokens: number): ModelParams {
  return { max_tokens: maxTokens, thinking: { type: thinking }, output_config: { effort } };
}

function draftBudget(config: ModelParamsConfig, afterMaxTokens: boolean): number {
  return afterMaxTokens ? Math.min(config.draftMaxTokens * 2, Math.max(config.draftMaxTokens, MAX_TOKENS_CEILING)) : config.draftMaxTokens;
}

/**
 * The request parameters for one call (D-24 table above). Throws ConfigError
 * ('anthropic_model_not_supported') for a model outside the table; the live adapter turns that
 * into a FATAL-CONFIG result before any network call.
 */
export function buildModelParams(input: ModelParamsInput, config: ModelParamsConfig = DEFAULT_MODEL_PARAMS_CONFIG): ModelCallParams {
  const family = familyOf(input.model);
  if (family === undefined) throw new ConfigError('anthropic_model_not_supported');
  const attempt = Number.isInteger(input.attempt) && input.attempt >= 1 ? input.attempt : 1;
  const timeoutMs = input.remainingMs !== undefined && Number.isFinite(input.remainingMs) ? Math.max(1, Math.floor(input.remainingMs)) : undefined;
  const afterMaxTokens = input.afterMaxTokens === true;

  let params: ModelParams;
  switch (input.purpose) {
    case 'classify':
      params = family === 'sonnet-5-5' ? sonnet('between_tools', 'low', CLASSIFY_MAX_TOKENS) : { max_tokens: CLASSIFY_MAX_TOKENS };
      break;
    case 'brief':
      if (family === 'sonnet-5-5') {
        params = attempt === 1 ? sonnet('adaptive', config.briefEffort, BRIEF_MAX_TOKENS) : sonnet('between_tools', 'high', BRIEF_FALLBACK_MAX_TOKENS);
      } else {
        params = { max_tokens: attempt === 1 ? BRIEF_MAX_TOKENS : BRIEF_FALLBACK_MAX_TOKENS };
      }
      break;
    case 'draft':
    case 'followup':
      params =
        family === 'sonnet-5-5'
          ? sonnet(config.draftThinking, config.draftEffort, draftBudget(config, afterMaxTokens))
          : { max_tokens: draftBudget(config, afterMaxTokens) };
      break;
  }
  return Object.freeze({ params: Object.freeze(params), timeoutMs });
}

// ---------------------------------------------------------------------------------------------
// Validation (FakeLLM's request assertion, the live adapter's pre-flight check, tests)
// ---------------------------------------------------------------------------------------------

export type ModelParamsIssue =
  | 'model_not_supported'
  | 'unknown_param'
  | 'sampling_param_not_allowed'
  | 'tools_not_allowed'
  | 'tool_choice_not_allowed'
  | 'prefill_not_allowed'
  | 'max_tokens_invalid'
  | 'max_tokens_above_model_limit'
  | 'thinking_invalid'
  | 'thinking_type_rejected'
  | 'thinking_not_allowed'
  | 'effort_invalid'
  | 'effort_required'
  | 'effort_not_supported'
  | 'between_tools_effort_too_high'
  | 'output_config_invalid';

/** Request keys this app may send; everything else is refused. */
const KNOWN_KEYS = new Set(['model', 'max_tokens', 'system', 'messages', 'thinking', 'output_config']);
const SAMPLING_KEYS = new Set(['temperature', 'top_p', 'top_k']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEffort(value: unknown): value is AiEffort {
  return typeof value === 'string' && (AI_EFFORTS as readonly string[]).includes(value);
}

/**
 * Problems with a request (or its parameter subset) for `model`; empty when valid. Checks the API's
 * 400 rules and this app's policy (D-24): Sonnet 5.5 always sends an explicit effort and a thinking
 * type of adaptive or between_tools (between_tools only at low/medium/high); Haiku 4.5 sends neither;
 * no sampling parameters, tools, tool_choice or other keys; the last message, if given, is the user's.
 */
export function validateModelParams(model: string, request: object): ModelParamsIssue[] {
  const params = request as Readonly<Record<string, unknown>>;
  const issues = new Set<ModelParamsIssue>();
  const family = familyOf(model);
  if (family === undefined) issues.add('model_not_supported');

  for (const key of Object.keys(params)) {
    if (SAMPLING_KEYS.has(key)) issues.add('sampling_param_not_allowed');
    else if (key === 'tools') issues.add('tools_not_allowed');
    else if (key === 'tool_choice') issues.add('tool_choice_not_allowed');
    else if (!KNOWN_KEYS.has(key)) issues.add('unknown_param');
  }

  const maxTokens = params.max_tokens;
  if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens < 1) issues.add('max_tokens_invalid');
  else if (family !== undefined && maxTokens > MAX_OUTPUT_TOKENS[family]) issues.add('max_tokens_above_model_limit');

  const messages = params.messages;
  if (messages !== undefined) {
    const last: unknown = Array.isArray(messages) ? messages.at(-1) : undefined;
    if (!isRecord(last) || last.role !== 'user') issues.add('prefill_not_allowed');
  }

  const outputConfig = params.output_config;
  let effort: unknown;
  if (outputConfig !== undefined) {
    if (!isRecord(outputConfig) || Object.keys(outputConfig).some((k) => k !== 'effort' && k !== 'format')) {
      issues.add('output_config_invalid');
    } else {
      effort = outputConfig.effort;
      const format = outputConfig.format;
      if (format !== undefined && (!isRecord(format) || format.type !== 'json_schema' || !isRecord(format.schema))) {
        issues.add('output_config_invalid');
      }
    }
  }
  if (effort !== undefined && !isEffort(effort)) issues.add('effort_invalid');

  const thinking = params.thinking;
  let thinkingType: unknown;
  if (thinking !== undefined) {
    if (!isRecord(thinking) || Object.keys(thinking).some((k) => k !== 'type')) issues.add('thinking_invalid');
    else thinkingType = thinking.type;
  }

  if (family === 'sonnet-5-5') {
    if (thinking !== undefined && thinkingType !== undefined && thinkingType !== 'adaptive' && thinkingType !== 'between_tools') {
      issues.add('thinking_type_rejected');
    }
    if (effort === undefined) issues.add('effort_required');
    const effectiveEffort = isEffort(effort) ? effort : 'high';
    if (thinkingType === 'between_tools' && !BETWEEN_TOOLS_EFFORTS.has(effectiveEffort)) issues.add('between_tools_effort_too_high');
  } else if (family === 'haiku-4-5') {
    if (thinking !== undefined) issues.add('thinking_not_allowed');
    if (effort !== undefined) issues.add('effort_not_supported');
  }
  return [...issues];
}

/** Throws (a test assertion, not an LLM outcome) when `params` are not valid for `model`. */
export function assertValidModelParams(model: string, params: object): void {
  const issues = validateModelParams(model, params);
  if (issues.length > 0) throw new InvalidModelParamsError(issues);
}

export class InvalidModelParamsError extends Error {
  override readonly name: string = 'InvalidModelParamsError';
  readonly code = 'invalid_model_params';
  readonly issues: readonly ModelParamsIssue[];

  constructor(issues: readonly ModelParamsIssue[]) {
    super(`invalid_model_params: ${issues.join(', ')}`);
    this.issues = issues;
  }
}
