import 'server-only';
import { assertValidModelParams, buildModelParams, DEFAULT_MODEL_PARAMS_CONFIG, type ModelParamsConfig } from '@/server/ai/model-params';
import type { LlmFailureKind, RefusalCategory } from '@/server/domain/types';
import type {
  BriefDraft,
  ClassifyInput,
  ClassifyOutput,
  DraftInput,
  DraftOutput,
  DraftRetryCode,
  FollowUpDraftInput,
  GenerateBriefInput,
  GenerateBriefOptions,
  LLM,
  LlmCallOptions,
  LlmFailure,
  LlmResult,
  LlmUsage,
} from '@/server/ports/llm';
import { briefFromPages } from './brief';
import { classifyByKeywords } from './classify';
import { followUpDraft, initialDraft } from './drafts';

/** PLAN §14 defaults for ANTHROPIC_MODEL_DRAFT and ANTHROPIC_MODEL_FAST. */
export const FAKE_LLM_DEFAULT_MODELS = { draft: 'claude-sonnet-5-5', fast: 'claude-haiku-4-5-20251001' } as const;

export const FAKE_LLM_PURPOSES = ['classify', 'brief', 'draft', 'followup'] as const;
export type FakeLlmPurpose = (typeof FAKE_LLM_PURPOSES)[number];

/**
 * Faults the fake can inject (PLAN §4). `invalid` → `invalid_output`, `fatal` → `fatal_config`;
 * `slow` runs past its budget: `generateBrief` reports `timeout` (after `elapse(timeoutMs + 1)`), a
 * call with a signal waits for it to abort (`aborted`), any other call reports `timeout` at once.
 */
export const FAKE_LLM_FAULTS = ['invalid', 'refusal', 'max_tokens', 'transient', 'fatal', 'slow'] as const;
export type FakeLlmFault = (typeof FAKE_LLM_FAULTS)[number];

/**
 * Input marker that injects a fault: `[[fake-llm:refusal]]` anywhere in the lead-controlled input or
 * page text fails every call that sees it; `[[fake-llm:draft:refusal]]` only that purpose's calls.
 */
export function fakeLlmMarker(fault: FakeLlmFault, purpose?: FakeLlmPurpose): string {
  return purpose === undefined ? `[[fake-llm:${fault}]]` : `[[fake-llm:${purpose}:${fault}]]`;
}

const MARKER = /\[\[fake-llm:(?:(classify|brief|draft|followup):)?(invalid|refusal|max_tokens|transient|fatal|slow)\]\]/g;

export interface FakeLlmFaultOptions {
  /** Which calls the fault applies to; default every purpose. */
  purpose?: FakeLlmPurpose | '*' | undefined;
  /** How many matching calls fail; default 1. */
  times?: number | undefined;
  /** `transient` only. */
  retryAfterMs?: number | undefined;
  /** `refusal` only; default `null` (the API gave no category). */
  refusalCategory?: RefusalCategory | null | undefined;
  /** Overrides the default `errorCode` (`overloaded` for transient, `model_not_found` for fatal). */
  errorCode?: string | undefined;
}

/** What the live adapter would derive its request parameters from (`buildModelParams`, D-24). */
export interface FakeLlmRequest {
  purpose: FakeLlmPurpose;
  model: string;
  /** `generateBrief` only: 0 selects the first-delivery parameters, ≥ 1 the fallback (PLAN §9.7). */
  attempt?: number | undefined;
  /** `generateBrief` only. */
  timeoutMs?: number | undefined;
  /** Drafts only: why the previous attempt was rejected (`max_tokens` asks for a larger budget). */
  previousErrorCodes?: readonly DraftRetryCode[] | undefined;
  /** `draftFollowUp` only. */
  followUpNumber?: 1 | 2 | undefined;
  /** The max_tokens the live request would carry for this purpose (PLAN §14 defaults). */
  maxTokens: number;
}

/** One call, as recorded for tests. `input` is a copy and may hold lead text: never log it. */
export interface FakeLlmCall {
  seq: number;
  purpose: FakeLlmPurpose;
  request: FakeLlmRequest;
  input: unknown;
  hasSignal: boolean;
  fault: FakeLlmFault | null;
  outcome: 'ok' | LlmFailureKind;
}

export interface FakeLlmOptions {
  models?: { draft?: string | undefined; fast?: string | undefined } | undefined;
  /**
   * ── M2 HOOK: buildModelParams ──────────────────────────────────────────────────────────────────
   * Every request is checked before the fake answers: `buildModelParams(request)` must yield
   * parameters `validateModelParams` accepts for `request.model` (PLAN §4: "asserts each request's
   * parameters are valid for its model"); an unsupported model or an invalid combination (e.g.
   * `between_tools` at effort `max`) throws. This extra hook then runs too (tests record requests
   * with it). A throw from either propagates to the caller on purpose: it is a test assertion, not
   * an LLM outcome.
   */
  assertRequest?: ((request: FakeLlmRequest) => void) | undefined;
  /** The env settings `buildModelParams` reads (`modelParamsConfig(env)`); default the PLAN §14 values. */
  modelParams?: ModelParamsConfig | undefined;
  /** Receives the simulated duration of a slow `generateBrief`, e.g. `(ms) => clock.advance(ms)`. */
  elapse?: ((ms: number) => void) | undefined;
  /** Recorded calls kept (oldest dropped first); default 1000. */
  maxRecordedCalls?: number | undefined;
}

interface QueuedFault {
  fault: FakeLlmFault;
  purpose: FakeLlmPurpose | '*';
  remaining: number;
  options: FakeLlmFaultOptions;
}

interface RunSpec<T> {
  purpose: FakeLlmPurpose;
  request: FakeLlmRequest;
  input: unknown;
  signal: AbortSignal | undefined;
  markerText: string;
  produce: () => T;
}

function tokens(value: unknown): number {
  return Math.max(1, Math.ceil(JSON.stringify(value).length / 4));
}

function draftMaxTokens(previous: readonly DraftRetryCode[]): number {
  return previous.includes('max_tokens') ? 2048 : 1024;
}

/**
 * M2 HOOK: what the live adapter would send for `request`, checked against the model's rules.
 * The brief's 0-based delivery index becomes the 1-based attempt; a draft with previous error codes
 * is the retry (attempt 2), with the larger budget after `max_tokens`.
 */
export function assertFakeRequestParams(request: FakeLlmRequest, config: ModelParamsConfig = DEFAULT_MODEL_PARAMS_CONFIG): void {
  const previous = request.previousErrorCodes ?? [];
  const built = buildModelParams(
    {
      model: request.model,
      purpose: request.purpose,
      attempt: request.purpose === 'brief' ? (request.attempt ?? 0) + 1 : previous.length > 0 ? 2 : 1,
      remainingMs: request.timeoutMs,
      afterMaxTokens: previous.includes('max_tokens'),
    },
    config,
  );
  assertValidModelParams(request.model, built.params);
}

function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * The deterministic fake `LLM` (PLAN §4): a keyword classifier, a heuristic brief, and templated
 * drafts that pass the validator. Like the live adapter it never throws for API or output problems
 * (only the M2 assertion hook may throw). Faults come from `injectFault` (checked first) or from
 * input markers (`fakeLlmMarker`).
 */
export class FakeLLM implements LLM {
  readonly #models: { draft: string; fast: string };
  readonly #assertRequest: ((request: FakeLlmRequest) => void) | undefined;
  readonly #modelParams: ModelParamsConfig;
  readonly #elapse: ((ms: number) => void) | undefined;
  readonly #maxRecorded: number;
  readonly #faults: QueuedFault[] = [];
  readonly #calls: FakeLlmCall[] = [];
  #seq = 0;
  #requests = 0;

  constructor(options: FakeLlmOptions = {}) {
    this.#models = {
      draft: options.models?.draft ?? FAKE_LLM_DEFAULT_MODELS.draft,
      fast: options.models?.fast ?? FAKE_LLM_DEFAULT_MODELS.fast,
    };
    this.#assertRequest = options.assertRequest;
    this.#modelParams = options.modelParams ?? DEFAULT_MODEL_PARAMS_CONFIG;
    this.#elapse = options.elapse;
    this.#maxRecorded = options.maxRecordedCalls ?? 1000;
  }

  /** Makes the next `times` matching calls fail with `fault`. Queued faults are used in order. */
  injectFault(fault: FakeLlmFault, options: FakeLlmFaultOptions = {}): void {
    const times = options.times ?? 1;
    if (!Number.isInteger(times) || times < 1) throw new RangeError('fake_llm_invalid_times');
    this.#faults.push({ fault, purpose: options.purpose ?? '*', remaining: times, options });
  }

  clearFaults(): void {
    this.#faults.length = 0;
  }

  /** Recorded calls, oldest first. */
  get calls(): readonly FakeLlmCall[] {
    return [...this.#calls];
  }

  callsFor(purpose: FakeLlmPurpose): FakeLlmCall[] {
    return this.#calls.filter((c) => c.purpose === purpose);
  }

  clearCalls(): void {
    this.#calls.length = 0;
  }

  classify(input: ClassifyInput, options?: LlmCallOptions): Promise<LlmResult<ClassifyOutput>> {
    return this.#run({
      purpose: 'classify',
      request: { purpose: 'classify', model: this.#models.fast, maxTokens: 256 },
      input,
      signal: options?.signal,
      markerText: [input.message, input.formName, input.firstName, input.company].join('\n'),
      produce: () => classifyByKeywords(input),
    });
  }

  generateBrief(input: GenerateBriefInput, options: GenerateBriefOptions): Promise<LlmResult<BriefDraft>> {
    return this.#run({
      purpose: 'brief',
      request: {
        purpose: 'brief',
        model: this.#models.draft,
        attempt: options.attempt,
        timeoutMs: options.timeoutMs,
        maxTokens: options.attempt === 0 ? 16000 : 4096,
      },
      input,
      signal: undefined,
      markerText: [input.sourceUrl, ...input.pages.flatMap((p) => [p.url, p.text])].join('\n'),
      produce: () => briefFromPages(input),
    });
  }

  draft(input: DraftInput, options?: LlmCallOptions): Promise<LlmResult<DraftOutput>> {
    return this.#run({
      purpose: 'draft',
      request: {
        purpose: 'draft',
        model: this.#models.draft,
        previousErrorCodes: [...input.previousErrorCodes],
        maxTokens: draftMaxTokens(input.previousErrorCodes),
      },
      input,
      signal: options?.signal,
      markerText: [input.lead.message, input.lead.formName, input.lead.firstName, input.lead.company].join('\n'),
      produce: () => initialDraft(input),
    });
  }

  draftFollowUp(input: FollowUpDraftInput, options?: LlmCallOptions): Promise<LlmResult<DraftOutput>> {
    return this.#run({
      purpose: 'followup',
      request: {
        purpose: 'followup',
        model: this.#models.draft,
        previousErrorCodes: [...input.previousErrorCodes],
        followUpNumber: input.followUpNumber,
        maxTokens: draftMaxTokens(input.previousErrorCodes),
      },
      input,
      signal: options?.signal,
      markerText: [input.lead.message, input.lead.formName, input.lead.firstName, input.lead.company].join('\n'),
      produce: () => followUpDraft(input),
    });
  }

  async #run<T>(spec: RunSpec<T>): Promise<LlmResult<T>> {
    // M2 HOOK: buildModelParams validity is asserted on every call (see FakeLlmOptions.assertRequest).
    assertFakeRequestParams(spec.request, this.#modelParams);
    this.#assertRequest?.(spec.request);
    const model = spec.request.model;
    if (spec.signal?.aborted === true) {
      // The SDK's APIUserAbortError: transient, and no injected fault is used up.
      const aborted: LlmFailure = { ok: false, failure: 'transient', model, errorCode: 'aborted' };
      this.#record(spec, null, aborted);
      return aborted;
    }
    const queued = this.#takeQueuedFault(spec.purpose);
    const fault = queued?.fault ?? this.#markerFault(spec.markerText, spec.purpose);
    const faultOptions = queued?.options ?? {};
    const requestId = `req_fake_${String(++this.#requests).padStart(6, '0')}`;

    let result: LlmResult<T>;
    if (fault === null) {
      const value = spec.produce();
      result = {
        ok: true,
        value,
        usage: { inputTokens: 200 + tokens(spec.input), outputTokens: tokens(value) },
        stopReason: 'end_turn',
        model,
        requestId,
      };
    } else {
      result = await this.#faultResult(fault, faultOptions, spec, requestId);
    }
    this.#record(spec, fault, result);
    return result;
  }

  async #faultResult<T>(fault: FakeLlmFault, options: FakeLlmFaultOptions, spec: RunSpec<T>, requestId: string): Promise<LlmFailure> {
    const model = spec.request.model;
    const answered = (outputTokens: number): LlmUsage => ({ inputTokens: 200 + tokens(spec.input), outputTokens });
    switch (fault) {
      case 'invalid':
        return { ok: false, failure: 'invalid_output', model, usage: answered(40), stopReason: 'end_turn', requestId, errorCode: 'schema_mismatch' };
      case 'refusal':
        return {
          ok: false,
          failure: 'refusal',
          model,
          usage: answered(5),
          stopReason: 'refusal',
          requestId,
          refusalCategory: options.refusalCategory ?? null,
        };
      case 'max_tokens':
        return { ok: false, failure: 'max_tokens', model, usage: answered(spec.request.maxTokens), stopReason: 'max_tokens', requestId };
      case 'transient':
        return { ok: false, failure: 'transient', model, retryAfterMs: options.retryAfterMs, errorCode: options.errorCode ?? 'overloaded' };
      case 'fatal':
        return { ok: false, failure: 'fatal_config', model, errorCode: options.errorCode ?? 'model_not_found' };
      case 'slow':
        if (spec.request.timeoutMs !== undefined) {
          this.#elapse?.(spec.request.timeoutMs + 1);
          return { ok: false, failure: 'transient', model, errorCode: 'timeout' };
        }
        if (spec.signal !== undefined) {
          await untilAborted(spec.signal);
          return { ok: false, failure: 'transient', model, errorCode: 'aborted' };
        }
        return { ok: false, failure: 'transient', model, errorCode: 'timeout' };
    }
  }

  #takeQueuedFault(purpose: FakeLlmPurpose): QueuedFault | null {
    const index = this.#faults.findIndex((f) => f.purpose === '*' || f.purpose === purpose);
    if (index < 0) return null;
    const queued = this.#faults[index];
    if (queued === undefined) return null;
    queued.remaining -= 1;
    if (queued.remaining <= 0) this.#faults.splice(index, 1);
    return queued;
  }

  #markerFault(text: string, purpose: FakeLlmPurpose): FakeLlmFault | null {
    for (const match of text.matchAll(MARKER)) {
      const forPurpose = match[1];
      if (forPurpose === undefined || forPurpose === purpose) return (match[2] as FakeLlmFault | undefined) ?? null;
    }
    return null;
  }

  #record<T>(spec: RunSpec<T>, fault: FakeLlmFault | null, result: LlmResult<T>): void {
    this.#seq += 1;
    this.#calls.push({
      seq: this.#seq,
      purpose: spec.purpose,
      request: spec.request,
      input: structuredClone(spec.input),
      hasSignal: spec.signal !== undefined,
      fault,
      outcome: result.ok ? 'ok' : result.failure,
    });
    if (this.#calls.length > this.#maxRecorded) this.#calls.splice(0, this.#calls.length - this.#maxRecorded);
  }
}
