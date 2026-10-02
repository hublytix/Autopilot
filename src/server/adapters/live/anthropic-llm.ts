import 'server-only';
import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk';
import type { Message, MessageCreateParamsNonStreaming, MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { z } from 'zod';
import { classifyAnthropicError } from '@/server/ai/errors';
import type { JsonSchema } from '@/server/ai/json-schema';
import {
  buildModelParams,
  DEFAULT_MODEL_PARAMS_CONFIG,
  validateModelParams,
  type ModelCallParams,
  type ModelParamsConfig,
  type ModelPurpose,
} from '@/server/ai/model-params';
import { buildClassifyPrompt } from '@/server/ai/prompts/classify';
import { CLASSIFICATION_JSON_SCHEMA, ClassificationOutputSchema } from '@/server/ai/schemas';
import { isRefusalCategory } from '@/server/domain/types';
import { log as defaultLog, type Logger } from '@/server/obs/log';
import type { Clock } from '@/server/ports/clock';
import type {
  BriefDraft,
  ClassifyInput,
  ClassifyOutput,
  DraftInput,
  DraftOutput,
  FollowUpDraftInput,
  GenerateBriefInput,
  GenerateBriefOptions,
  LLM,
  LlmCallOptions,
  LlmFailure,
  LlmResult,
  LlmUsage,
} from '@/server/ports/llm';

// The live LLM port (PLAN §4, D-24, D-25) on @anthropic-ai/sdk 0.131.0 [AI-SDK-STRUCTURED-CALL-PATTERN]:
// 1. `messages.create` (never `parse()`, which throws on bad JSON and loses usage, stop_reason and
//    the request id [AI-SO-PARSE-SEMANTICS]) with `output_config.format = {type: 'json_schema',
//    schema}` from toClaudeJsonSchema (keeps enums), plus the per-model parameters from
//    buildModelParams, checked by validateModelParams before anything is sent;
// 2. usage, `response.model` and `_request_id` are read first, then `stop_reason`: `refusal` →
//    refusal (with stop_details.category), `max_tokens` (and a context-window stop) → max_tokens,
//    `end_turn` → JSON.parse + Zod (enum strings lower-cased), anything else → invalid_output;
// 3. SDK throws map to TRANSIENT / FATAL-CONFIG (ai/errors.ts).
// The method never throws for API or output problems: every outcome is an LlmResult.
// Privacy (law 4) [AI-SDK-LOGGING-PRIVACY]: the client runs at logLevel 'warn' with a logger that
// drops the SDK's text, and the base URL and credentials are passed explicitly so ANTHROPIC_LOG,
// ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN cannot turn on body logging or redirect prompts. Error
// messages from the SDK or JSON.parse are never read; logs carry class, status, request id and codes.
//
// Status: classify is complete. generateBrief (M3) and draft/draftFollowUp (M4) share #call but
// their prompts are not built yet, so they answer FATAL-CONFIG `not_built` without a network call.

/** The part of the SDK client this adapter uses (tests pass a stub, or a real client with a stubbed fetch). */
export interface AnthropicMessagesClient {
  messages: {
    create(
      body: MessageCreateParamsNonStreaming,
      options?: { timeout?: number; signal?: AbortSignal },
    ): PromiseLike<Message & { _request_id?: string | null | undefined }>;
  };
}

export interface AnthropicLlmOptions {
  apiKey: string;
  /** ANTHROPIC_MODEL_DRAFT and ANTHROPIC_MODEL_FAST. */
  models: { draft: string; fast: string };
  /** From the env (`modelParamsConfig(env)`); default the PLAN §14 values. */
  params?: ModelParamsConfig | undefined;
  clock: Clock;
  /** For tests; default `createAnthropicClient(...)`. */
  client?: AnthropicMessagesClient | undefined;
  /** Client-level timeout per request (default 60 s); the brief overrides it per call (D-24). */
  timeoutMs?: number | undefined;
  /** SDK retries per call (default 2). */
  maxRetries?: number | undefined;
  logger?: Logger | undefined;
}

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const DEFAULT_ANTHROPIC_TIMEOUT_MS = 60_000;

type SdkLogger = NonNullable<ClientOptions['logger']>;

/** Receives the SDK's own log calls and writes static lines only: its messages may quote request or response bodies. */
function sdkLogger(logger: Logger): SdkLogger {
  return {
    error: () => logger.warn('anthropic sdk logged an error', { provider: 'anthropic' }),
    warn: () => logger.warn('anthropic sdk logged a warning', { provider: 'anthropic' }),
    info: () => undefined,
    debug: () => undefined,
  };
}

/** The SDK client with the D-24 settings. */
export function createAnthropicClient(options: {
  apiKey: string;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  logger?: Logger | undefined;
}): Anthropic {
  return new Anthropic({
    apiKey: options.apiKey,
    authToken: null,
    webhookKey: null,
    baseURL: ANTHROPIC_BASE_URL,
    maxRetries: options.maxRetries ?? 2,
    timeout: options.timeoutMs ?? DEFAULT_ANTHROPIC_TIMEOUT_MS,
    logLevel: 'warn',
    logger: sdkLogger(options.logger ?? defaultLog),
  });
}

interface CallSpec<T> {
  purpose: ModelPurpose;
  model: string;
  attempt: number;
  remainingMs?: number | undefined;
  afterMaxTokens?: boolean | undefined;
  system: string;
  messages: MessageParam[];
  schema: JsonSchema;
  output: z.ZodType<T>;
  signal?: AbortSignal | undefined;
}

const STOP_REASON = /^[a-z_]{1,40}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

function safeStopReason(value: unknown): string {
  return typeof value === 'string' && STOP_REASON.test(value) ? value : 'unknown';
}

function safeRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && REQUEST_ID.test(value) ? value : undefined;
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function toUsage(usage: Message['usage'] | undefined): LlmUsage {
  return {
    inputTokens: tokenCount(usage?.input_tokens),
    outputTokens: tokenCount(usage?.output_tokens),
    cacheReadTokens: tokenCount(usage?.cache_read_input_tokens),
    cacheWriteTokens: tokenCount(usage?.cache_creation_input_tokens),
  };
}

function textOf(message: Message): string {
  const blocks: readonly unknown[] = Array.isArray(message.content) ? message.content : [];
  let text = '';
  for (const block of blocks) {
    if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text') {
      const value = (block as { text?: unknown }).text;
      if (typeof value === 'string') text += value;
    }
  }
  return text;
}

/** Combines the caller's signal with the per-call budget, when either exists. */
function callSignal(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  const budget = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
  if (signal === undefined) return budget;
  return budget === undefined ? signal : AbortSignal.any([signal, budget]);
}

export class AnthropicLLM implements LLM {
  readonly #client: AnthropicMessagesClient;
  readonly #models: { draft: string; fast: string };
  readonly #params: ModelParamsConfig;
  readonly #clock: Clock;
  readonly #log: Logger;

  constructor(options: AnthropicLlmOptions) {
    this.#log = options.logger ?? defaultLog;
    this.#client =
      options.client ??
      createAnthropicClient({ apiKey: options.apiKey, timeoutMs: options.timeoutMs, maxRetries: options.maxRetries, logger: this.#log });
    this.#models = { draft: options.models.draft, fast: options.models.fast };
    this.#params = options.params ?? DEFAULT_MODEL_PARAMS_CONFIG;
    this.#clock = options.clock;
  }

  async classify(input: ClassifyInput, options?: LlmCallOptions): Promise<LlmResult<ClassifyOutput>> {
    const prompt = buildClassifyPrompt(input);
    return this.#call({
      purpose: 'classify',
      model: this.#models.fast,
      attempt: 1,
      system: prompt.system,
      messages: prompt.messages,
      schema: CLASSIFICATION_JSON_SCHEMA,
      output: ClassificationOutputSchema,
      signal: options?.signal,
    });
  }

  // M3: build the brief prompt (pages inside untrusted delimiters, "Think the problem through before
  // you answer.") and call #call({purpose: 'brief', model: draft, attempt: options.attempt + 1,
  // remainingMs: options.timeoutMs, schema: BRIEF_JSON_SCHEMA, output: BriefOutputSchema}).
  async generateBrief(_input: GenerateBriefInput, _options: GenerateBriefOptions): Promise<LlmResult<BriefDraft>> {
    return this.#notBuilt('brief', this.#models.draft);
  }

  // M4: the draft and follow-up prompts call #call({purpose: 'draft' | 'followup', model: draft,
  // attempt: previousErrorCodes.length > 0 ? 2 : 1, afterMaxTokens: previousErrorCodes.includes('max_tokens'),
  // schema: DRAFT_JSON_SCHEMA, output: DraftOutputSchema, signal}).
  async draft(_input: DraftInput, _options?: LlmCallOptions): Promise<LlmResult<DraftOutput>> {
    return this.#notBuilt('draft', this.#models.draft);
  }

  async draftFollowUp(_input: FollowUpDraftInput, _options?: LlmCallOptions): Promise<LlmResult<DraftOutput>> {
    return this.#notBuilt('followup', this.#models.draft);
  }

  #notBuilt(purpose: ModelPurpose, model: string): LlmFailure {
    this.#log.error('anthropic prompt not built', { provider: 'anthropic', purpose, model, errorCode: 'not_built' });
    return { ok: false, failure: 'fatal_config', model, errorCode: 'not_built' };
  }

  #failed(spec: { purpose: ModelPurpose; model: string }, failure: LlmFailure, extra: { httpStatus?: number | undefined; errorName?: string | undefined } = {}): LlmFailure {
    this.#log.warn('anthropic call failed', {
      provider: 'anthropic',
      purpose: spec.purpose,
      model: failure.model ?? spec.model,
      outcome: failure.failure,
      errorCode: failure.errorCode,
      reason: failure.stopReason,
      requestId: failure.requestId,
      httpStatus: extra.httpStatus,
      errorName: extra.errorName,
      inputTokens: failure.usage?.inputTokens,
      outputTokens: failure.usage?.outputTokens,
    });
    return failure;
  }

  async #call<T>(spec: CallSpec<T>): Promise<LlmResult<T>> {
    let built: ModelCallParams;
    try {
      built = buildModelParams(
        { model: spec.model, purpose: spec.purpose, attempt: spec.attempt, remainingMs: spec.remainingMs, afterMaxTokens: spec.afterMaxTokens },
        this.#params,
      );
    } catch {
      return this.#failed(spec, { ok: false, failure: 'fatal_config', model: spec.model, errorCode: 'model_not_supported' });
    }
    const { params } = built;
    const wire = {
      model: spec.model,
      max_tokens: params.max_tokens,
      system: spec.system,
      messages: spec.messages,
      ...(params.thinking === undefined ? {} : { thinking: params.thinking }),
      output_config: {
        ...(params.output_config === undefined ? {} : { effort: params.output_config.effort }),
        format: { type: 'json_schema' as const, schema: spec.schema },
      },
    };
    if (validateModelParams(spec.model, wire).length > 0) {
      return this.#failed(spec, { ok: false, failure: 'fatal_config', model: spec.model, errorCode: 'invalid_model_params' });
    }

    const signal = callSignal(spec.signal, built.timeoutMs);
    const requestOptions: { timeout?: number; signal?: AbortSignal } = {};
    if (built.timeoutMs !== undefined) requestOptions.timeout = built.timeoutMs;
    if (signal !== undefined) requestOptions.signal = signal;

    let message: Message & { _request_id?: string | null | undefined };
    try {
      message = await this.#client.messages.create(wire, requestOptions);
    } catch (error) {
      const classified = classifyAnthropicError(error, this.#clock.now());
      return this.#failed(
        spec,
        {
          ok: false,
          failure: classified.failure,
          model: spec.model,
          errorCode: classified.errorCode,
          requestId: classified.requestId,
          retryAfterMs: classified.retryAfterMs,
        },
        { httpStatus: classified.httpStatus, errorName: classified.errorName },
      );
    }
    return this.#interpret(spec, message);
  }

  #interpret<T>(spec: CallSpec<T>, message: Message & { _request_id?: string | null | undefined }): LlmResult<T> {
    // Usage, the serving model and the request id first: every outcome below reports them.
    const usage = toUsage(message.usage);
    const model = typeof message.model === 'string' && message.model !== '' ? message.model : spec.model;
    const requestId = safeRequestId(message._request_id);
    const stopReason = safeStopReason(message.stop_reason);
    const answered = { ok: false as const, model, usage, stopReason, requestId };

    switch (message.stop_reason) {
      case 'end_turn':
        break;
      case 'refusal': {
        // Never retried on the same model; partial output is discarded [AI-REFUSAL-HANDLING].
        const category: unknown = message.stop_details?.category;
        return this.#failed(spec, { ...answered, failure: 'refusal', refusalCategory: isRefusalCategory(category) ? category : null });
      }
      case 'max_tokens':
        // Always a failed attempt, even if the text happens to hold valid JSON [AI-SO-REFUSAL-MAXTOKENS].
        return this.#failed(spec, { ...answered, failure: 'max_tokens' });
      case 'model_context_window_exceeded':
        return this.#failed(spec, { ...answered, failure: 'max_tokens', errorCode: 'context_window_exceeded' });
      default:
        // New stop reasons may appear (API versioning): anything but end_turn is a failure.
        return this.#failed(spec, { ...answered, failure: 'invalid_output', errorCode: 'unexpected_stop_reason' });
    }

    let json: unknown;
    try {
      json = JSON.parse(textOf(message));
    } catch {
      // The SyntaxError quotes the output: dropped unread.
      return this.#failed(spec, { ...answered, failure: 'invalid_output', errorCode: 'invalid_json' });
    }
    const parsed = spec.output.safeParse(json);
    if (!parsed.success) return this.#failed(spec, { ...answered, failure: 'invalid_output', errorCode: 'schema_mismatch' });
    return { ok: true, value: parsed.data, usage, stopReason, model, requestId };
  }
}
