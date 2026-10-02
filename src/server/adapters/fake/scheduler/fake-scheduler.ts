import 'server-only';
import { randomBytes } from 'node:crypto';
import { PermanentError } from '@/server/domain/errors';
import type { JobKind } from '@/server/domain/types';
import type { Clock } from '@/server/ports/clock';
import type { PublishRequest, PublishResult, Scheduler } from '@/server/ports/scheduler';

/** QStash keeps a deduplication id for 10 minutes (QS-DEDUPLICATION). */
export const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
/** PLAN §14 default for QSTASH_MAX_DELAY_SECONDS. */
export const DEFAULT_MAX_DELAY_SECONDS = 601200;
/** Upper bound on deliveries in one `runDue`, so a job that keeps re-publishing itself cannot spin forever. */
export const DEFAULT_MAX_DELIVERIES_PER_RUN = 10_000;

/** What `/api/jobs/run` receives: the body `{jobId}` plus the QStash headers the handler reads. */
export interface FakeDelivery {
  messageId: string;
  jobId: string;
  kind: JobKind;
  /** `Upstash-Retried`: 0 on the first delivery. */
  retried: number;
  /** The `retries` the message was published with (the last delivery has `retried === retries`). */
  retries: number;
  /** When the fake made this delivery (the `now` passed to `runDue`). */
  deliveredAt: Date;
}

/**
 * The handler's answer. `undefined` or any 2xx is success. A `Response` fits the object form, so the
 * integrator can return the route handler's response as is: `Retry-After` or `X-RateLimit-Reset*`
 * overrides the backoff (see retryDelayFromHeaders), and 489 with `Upstash-NonRetryable-Error: true`
 * stops retries.
 */
export type FakeDispatchResult = void | number | { status: number; headers?: Headers | undefined };

export type FakeDispatch = (delivery: FakeDelivery) => Promise<FakeDispatchResult> | FakeDispatchResult;

/** What `/api/jobs/failed` receives (the QStash failure callback, reduced to what the handler uses). */
export interface FakeFailureCallback {
  /** `sourceMessageId`. */
  messageId: string;
  jobId: string;
  kind: JobKind;
  /** Retries made before giving up. */
  retried: number;
  /** True when a 489 + `Upstash-NonRetryable-Error` ended the message rather than exhausted retries. */
  nonRetryable: boolean;
}

export type FakeOnFailure = (failure: FakeFailureCallback) => Promise<void> | void;

/**
 * Delivery effects for tests (PLAN §12 sequential replays):
 * - `duplicate`: the delivery is made twice in a row (at-least-once, even after a 2xx);
 * - `crash_before_dispatch`: the endpoint dies before the handler runs; counts as a failed attempt;
 * - `crash_after_dispatch`: the handler runs but its response is lost; counts as a failed attempt.
 */
export type FakeDeliveryEffect = 'duplicate' | 'crash_before_dispatch' | 'crash_after_dispatch';

export interface FakeDeliveryMatch {
  messageId?: string | undefined;
  jobId?: string | undefined;
  kind?: JobKind | undefined;
}

export interface FakeSchedulerOptions {
  clock: Clock;
  dispatch: FakeDispatch;
  /** When absent, exhausted messages are only recorded in `failures`. */
  onFailure?: FakeOnFailure | undefined;
  /** `null` disables the check. Default DEFAULT_MAX_DELAY_SECONDS. */
  maxDelaySeconds?: number | null | undefined;
  maxDeliveriesPerRun?: number | undefined;
}

/** A queued message, as `pending()` reports it. */
export interface FakeQueuedMessage {
  messageId: string;
  jobId: string;
  kind: JobKind;
  runAt: Date;
  retried: number;
  retries: number;
  dedupeId: string;
}

/** One delivery or failure-callback event, for assertions. */
export type FakeSchedulerEvent =
  | { type: 'delivery'; messageId: string; jobId: string; retried: number; at: Date; outcome: 'ok' | 'retry' | 'failed' | 'crashed'; status?: number | undefined }
  | { type: 'failure_callback'; messageId: string; jobId: string; at: Date };

interface Message {
  messageId: string;
  jobId: string;
  kind: JobKind;
  runAtMs: number;
  seq: number;
  retried: number;
  retries: number;
  dedupeId: string;
}

interface DedupeEntry {
  messageId: string;
  expiresAtMs: number;
}

type QueuedEffect = { effect: FakeDeliveryEffect; match: FakeDeliveryMatch; remaining: number };

function newMessageId(): string {
  return `msg_${randomBytes(12).toString('hex')}`;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status <= 299;
}

/** QStash caps a destination-steered delay at one day (QS-RETRIES-SUCCESS). */
export const MAX_RETRY_AFTER_MS = 86_400_000;

const DURATION_UNIT_MS: Readonly<Record<string, number>> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const DURATION = /^(?:\d{1,9}(?:ms|s|m|h|d))+$/;
const DURATION_PART = /(\d{1,9})(ms|s|m|h|d)/g;
/** RFC 1123 (IMF-fixdate), e.g. `Tue, 06 Oct 2026 14:00:00 GMT`. */
const HTTP_DATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * A `Retry-After`/`X-RateLimit-Reset*` value as QStash reads it (QS-RETRIES-SUCCESS): whole
 * seconds, an RFC 1123 date (relative to `nowMs`, the injected Clock's delivery time) or a
 * duration such as `90s`, `5m` or `1h30m`. Clamped to [0, 1 day]; anything else is ignored.
 */
export function parseRetryAfter(value: string, nowMs: number): number | undefined {
  const text = value.trim();
  let ms: number | undefined;
  if (/^\d{1,12}$/.test(text)) ms = Number(text) * 1000;
  else if (DURATION.test(text)) {
    ms = 0;
    for (const [, amount, unit] of text.matchAll(DURATION_PART)) ms += Number(amount) * (DURATION_UNIT_MS[unit ?? 's'] ?? 0);
  } else if (HTTP_DATE.test(text)) {
    const at = Date.parse(text);
    if (Number.isFinite(at)) ms = at - nowMs;
  }
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

/** `Retry-After` first; otherwise the longest `X-RateLimit-Reset*` (every limit must have reset). */
export function retryDelayFromHeaders(headers: Headers, nowMs: number): number | undefined {
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null) {
    const ms = parseRetryAfter(retryAfter, nowMs);
    if (ms !== undefined) return ms;
  }
  let longest: number | undefined;
  headers.forEach((value, name) => {
    if (!name.toLowerCase().startsWith('x-ratelimit-reset')) return;
    const ms = parseRetryAfter(value, nowMs);
    if (ms !== undefined && (longest === undefined || ms > longest)) longest = ms;
  });
  return longest;
}

function readResult(result: FakeDispatchResult, nowMs: number): { status: number; retryAfterMs?: number | undefined; nonRetryable: boolean } {
  if (result === undefined) return { status: 200, nonRetryable: false };
  if (typeof result === 'number') return { status: result, nonRetryable: false };
  return {
    status: result.status,
    retryAfterMs: result.headers === undefined ? undefined : retryDelayFromHeaders(result.headers, nowMs),
    nonRetryable: result.status === 489 && result.headers?.get('upstash-nonretryable-error')?.toLowerCase() === 'true',
  };
}

/**
 * The fake `Scheduler` (PLAN §4): an in-memory queue ordered by `runAt`, then publish order. It never
 * uses timers: `runDue(now)` delivers what is due through the injected dispatch callback, applying
 * QStash's retry rules (`retries`, delay `pow(2, retried) * 10 s` or the handler's `Retry-After`) and
 * calling the injected failure callback once retries are exhausted. `publish` deduplicates within 10
 * minutes like QStash; `cancel` of an unknown or delivered id succeeds (QStash's 404).
 */
export class FakeScheduler implements Scheduler {
  readonly #clock: Clock;
  readonly #dispatch: FakeDispatch;
  readonly #onFailure: FakeOnFailure | undefined;
  readonly #maxDelayMs: number | null;
  readonly #maxDeliveries: number;
  readonly #queue: Message[] = [];
  readonly #dedupe = new Map<string, DedupeEntry>();
  readonly #effects: QueuedEffect[] = [];
  readonly #events: FakeSchedulerEvent[] = [];
  readonly #failures: FakeFailureCallback[] = [];
  readonly #cancelled: string[] = [];
  readonly #cancelRequested = new Set<string>();
  #inFlight: string | null = null;
  #tail: Promise<void> = Promise.resolve();
  #seq = 0;

  constructor(options: FakeSchedulerOptions) {
    this.#clock = options.clock;
    this.#dispatch = options.dispatch;
    this.#onFailure = options.onFailure;
    const maxDelaySeconds = options.maxDelaySeconds === undefined ? DEFAULT_MAX_DELAY_SECONDS : options.maxDelaySeconds;
    this.#maxDelayMs = maxDelaySeconds === null ? null : maxDelaySeconds * 1000;
    this.#maxDeliveries = options.maxDeliveriesPerRun ?? DEFAULT_MAX_DELIVERIES_PER_RUN;
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    const nowMs = this.#clock.now().getTime();
    const runAtMs = request.runAt.getTime();
    if (
      request.jobId.length === 0 ||
      request.dedupeId.length === 0 ||
      !Number.isFinite(runAtMs) ||
      !Number.isInteger(request.retries) ||
      request.retries < 0
    ) {
      throw new PermanentError('qstash_bad_request', { httpStatus: 400 });
    }
    if (this.#maxDelayMs !== null && runAtMs - nowMs > this.#maxDelayMs) {
      throw new PermanentError('qstash_delay_too_long', { httpStatus: 400 });
    }
    for (const [id, entry] of this.#dedupe) if (entry.expiresAtMs <= nowMs) this.#dedupe.delete(id);
    const seen = this.#dedupe.get(request.dedupeId);
    if (seen !== undefined) return { messageId: seen.messageId, deduplicated: true };

    const message: Message = {
      messageId: newMessageId(),
      jobId: request.jobId,
      kind: request.kind,
      runAtMs,
      seq: ++this.#seq,
      retried: 0,
      retries: request.retries,
      dedupeId: request.dedupeId,
    };
    this.#insert(message);
    this.#dedupe.set(request.dedupeId, { messageId: message.messageId, expiresAtMs: nowMs + DEDUPE_WINDOW_MS });
    return { messageId: message.messageId, deduplicated: false };
  }

  async cancel(messageId: string): Promise<void> {
    if (messageId.length === 0) throw new PermanentError('qstash_bad_request', { httpStatus: 400 });
    const index = this.#queue.findIndex((m) => m.messageId === messageId);
    if (index >= 0) {
      this.#queue.splice(index, 1);
      this.#cancelled.push(messageId);
    } else if (this.#inFlight === messageId) {
      // Too late to stop this delivery, but it will not be retried.
      this.#cancelRequested.add(messageId);
      this.#cancelled.push(messageId);
    }
  }

  /** Queued messages in delivery order. */
  pending(): FakeQueuedMessage[] {
    return this.#queue.map((m) => ({
      messageId: m.messageId,
      jobId: m.jobId,
      kind: m.kind,
      runAt: new Date(m.runAtMs),
      retried: m.retried,
      retries: m.retries,
      dedupeId: m.dedupeId,
    }));
  }

  /** The earliest queued delivery time, or null when the queue is empty. */
  nextRunAt(): Date | null {
    const first = this.#queue[0];
    return first === undefined ? null : new Date(first.runAtMs);
  }

  get events(): readonly FakeSchedulerEvent[] {
    return [...this.#events];
  }

  /** Failure callbacks made so far (also recorded when no `onFailure` is wired). */
  get failures(): readonly FakeFailureCallback[] {
    return [...this.#failures];
  }

  /** Message ids removed from the queue by `cancel`. */
  get cancelled(): readonly string[] {
    return [...this.#cancelled];
  }

  /** Applies `effect` to the next `times` (default 1) deliveries that match. */
  simulate(effect: FakeDeliveryEffect, match: FakeDeliveryMatch = {}, times = 1): void {
    if (!Number.isInteger(times) || times < 1) throw new RangeError('fake_scheduler_invalid_times');
    this.#effects.push({ effect, match, remaining: times });
  }

  /**
   * Delivers every message due at `now` (default the Clock's now), in order, one at a time; retries
   * land at least 10 s later, so they wait for a later call. Overlapping calls (a dev ticker) run one
   * after the other, so the dispatch callback must never call `runDue` itself (it would wait for
   * its own run). Returns the number of handler invocations made.
   */
  runDue(now: Date = this.#clock.now()): Promise<number> {
    const run = this.#tail.then(() => this.#runDue(now.getTime()));
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #runDue(nowMs: number): Promise<number> {
    let invocations = 0;
    for (;;) {
      const next = this.#queue[0];
      if (next === undefined || next.runAtMs > nowMs) return invocations;
      this.#queue.shift();
      this.#inFlight = next.messageId;
      try {
        invocations += await this.#deliver(next, nowMs);
      } finally {
        this.#inFlight = null;
        this.#cancelRequested.delete(next.messageId);
      }
      if (invocations > this.#maxDeliveries) throw new Error('fake_scheduler_too_many_deliveries');
    }
  }

  async #deliver(message: Message, nowMs: number): Promise<number> {
    const effect = this.#takeEffect(message);
    if (effect === 'crash_before_dispatch') {
      this.#log(message, nowMs, 'crashed');
      await this.#afterFailure(message, nowMs, undefined, false);
      return 0;
    }

    let outcome = await this.#invoke(message, nowMs);
    let invocations = 1;
    if (effect === 'duplicate') {
      // At-least-once: the same delivery again; QStash goes by the response it saw last.
      this.#log(message, nowMs, isSuccess(outcome.status) ? 'ok' : 'retry', outcome.status);
      outcome = await this.#invoke(message, nowMs);
      invocations = 2;
    }

    if (effect === 'crash_after_dispatch') {
      this.#log(message, nowMs, 'crashed', outcome.status);
      await this.#afterFailure(message, nowMs, undefined, false);
    } else if (isSuccess(outcome.status)) {
      this.#log(message, nowMs, 'ok', outcome.status);
    } else {
      await this.#afterFailure(message, nowMs, outcome, outcome.nonRetryable);
    }
    return invocations;
  }

  async #invoke(message: Message, nowMs: number): Promise<ReturnType<typeof readResult>> {
    try {
      return readResult(
        await this.#dispatch({
          messageId: message.messageId,
          jobId: message.jobId,
          kind: message.kind,
          retried: message.retried,
          retries: message.retries,
          deliveredAt: new Date(nowMs),
        }),
        nowMs,
      );
    } catch {
      // A thrown handler is a 500 to QStash.
      return { status: 500, nonRetryable: false };
    }
  }

  async #afterFailure(
    message: Message,
    nowMs: number,
    outcome: { status: number; retryAfterMs?: number | undefined } | undefined,
    nonRetryable: boolean,
  ): Promise<void> {
    if (this.#cancelRequested.has(message.messageId)) {
      // Cancelled while in flight: QStash marks it CANCELLED at its next delivery time.
      if (outcome !== undefined) this.#log(message, nowMs, 'failed', outcome.status);
      return;
    }
    if (!nonRetryable && message.retried < message.retries) {
      if (outcome !== undefined) this.#log(message, nowMs, 'retry', outcome.status);
      const delayMs = outcome?.retryAfterMs ?? 2 ** message.retried * 10_000;
      this.#insert({ ...message, runAtMs: nowMs + delayMs, seq: ++this.#seq, retried: message.retried + 1 });
      return;
    }
    if (outcome !== undefined) this.#log(message, nowMs, 'failed', outcome.status);
    const failure: FakeFailureCallback = {
      messageId: message.messageId,
      jobId: message.jobId,
      kind: message.kind,
      retried: message.retried,
      nonRetryable,
    };
    this.#failures.push(failure);
    this.#events.push({ type: 'failure_callback', messageId: message.messageId, jobId: message.jobId, at: new Date(nowMs) });
    await this.#onFailure?.(failure);
  }

  #log(message: Message, nowMs: number, outcome: 'ok' | 'retry' | 'failed' | 'crashed', status?: number): void {
    this.#events.push({
      type: 'delivery',
      messageId: message.messageId,
      jobId: message.jobId,
      retried: message.retried,
      at: new Date(nowMs),
      outcome,
      status,
    });
  }

  #takeEffect(message: Message): FakeDeliveryEffect | null {
    const index = this.#effects.findIndex(
      ({ match }) =>
        (match.messageId === undefined || match.messageId === message.messageId) &&
        (match.jobId === undefined || match.jobId === message.jobId) &&
        (match.kind === undefined || match.kind === message.kind),
    );
    const queued = this.#effects[index];
    if (queued === undefined) return null;
    queued.remaining -= 1;
    if (queued.remaining <= 0) this.#effects.splice(index, 1);
    return queued.effect;
  }

  #insert(message: Message): void {
    const index = this.#queue.findIndex((m) => m.runAtMs > message.runAtMs || (m.runAtMs === message.runAtMs && m.seq > message.seq));
    if (index < 0) this.#queue.push(message);
    else this.#queue.splice(index, 0, message);
  }
}
