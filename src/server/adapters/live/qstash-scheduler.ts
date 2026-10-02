import 'server-only';
import { Client, QstashError, QstashRatelimitError, QstashDailyRatelimitError } from '@upstash/qstash';
import { ConfigError, PermanentError, TransientError } from '@/server/domain/errors';
import { JOB_FAILED_PATH, JOB_RETRY_DELAY_EXPRESSION, JOB_RUN_PATH } from '@/server/jobs/types';
import type { Clock } from '@/server/ports/clock';
import type { PublishRequest, PublishResult, Scheduler } from '@/server/ports/scheduler';

// The live Scheduler (PLAN §4, D-11, D-15, QS-PUBLISH-WIRE, QS-CANCEL): QStash `publishJSON` to
// `{APP_URL}/api/jobs/run` with the body `{jobId}` (ids only), `notBefore` in unix seconds (never
// `delay`), the dedupe id, `retries` (4), `Upstash-Retry-Delay: pow(2, retried) * 10000` and a
// failure callback to `{APP_URL}/api/jobs/failed`. Cancel is by message id only (DELETE
// /v2/messages/{id}); a 404 (already delivered or cancelled) is success, and there is no bulk path.
// The client is pinned: explicit token and base URL, `devMode: false` (QS-DEVMODE-KEY-OVERRIDE),
// telemetry off, and no SDK network retries (an unpublished job is the sweeper's to retry).
//
// Errors: 429 → TransientError, 5xx and network → TransientError, 401/403 → ConfigError (bad token
// or wrong region), other 4xx → PermanentError. Provider messages are never kept.

export interface QstashSchedulerOptions {
  token: string;
  /** QSTASH_URL: the region's API base, copied from the console (QS-ENV-REGION). */
  baseUrl: string;
  /** APP_URL (an origin). */
  appUrl: string;
  clock: Clock;
}

function mapError(error: unknown): Error {
  if (error instanceof QstashRatelimitError || error instanceof QstashDailyRatelimitError) {
    return new TransientError('qstash_rate_limited', { httpStatus: 429 });
  }
  if (error instanceof QstashError) {
    const status = error.status;
    if (status === undefined) return new TransientError('qstash_network_error');
    if (status === 429) return new TransientError('qstash_rate_limited', { httpStatus: status });
    if (status >= 500) return new TransientError('qstash_server_error', { httpStatus: status });
    if (status === 401 || status === 403) return new ConfigError('qstash_unauthorized', { httpStatus: status });
    return new PermanentError('qstash_bad_request', { httpStatus: status });
  }
  return new TransientError('qstash_network_error');
}

function isNotFound(error: unknown): boolean {
  return error instanceof QstashError && error.status === 404;
}

export class QstashScheduler implements Scheduler {
  readonly #client: Client;
  readonly #clock: Clock;
  readonly #runUrl: string;
  readonly #failedUrl: string;

  constructor(options: QstashSchedulerOptions) {
    this.#client = new Client({
      token: options.token,
      baseUrl: options.baseUrl,
      devMode: false,
      enableTelemetry: false,
      retry: false,
    });
    this.#clock = options.clock;
    this.#runUrl = `${options.appUrl}${JOB_RUN_PATH}`;
    this.#failedUrl = `${options.appUrl}${JOB_FAILED_PATH}`;
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    const runAtMs = request.runAt.getTime();
    if (request.jobId.length === 0 || request.dedupeId.length === 0 || !Number.isFinite(runAtMs)) {
      throw new PermanentError('qstash_bad_request');
    }
    // Rounded up, so QStash never delivers before runAt; omitted when due now (QS-DELAY-HEADERS).
    const notBefore = runAtMs > this.#clock.now().getTime() ? Math.ceil(runAtMs / 1000) : undefined;
    try {
      const response = await this.#client.publishJSON({
        url: this.#runUrl,
        body: { jobId: request.jobId },
        ...(notBefore === undefined ? {} : { notBefore }),
        deduplicationId: request.dedupeId,
        retries: request.retries,
        retryDelay: JOB_RETRY_DELAY_EXPRESSION,
        failureCallback: this.#failedUrl,
      });
      return { messageId: response.messageId, deduplicated: response.deduplicated === true };
    } catch (error) {
      throw mapError(error);
    }
  }

  async cancel(messageId: string): Promise<void> {
    if (messageId.length === 0) throw new PermanentError('qstash_bad_request');
    try {
      // The single-id form: DELETE /v2/messages/{id}. Never the array or filter forms.
      await this.#client.messages.delete(messageId);
    } catch (error) {
      if (isNotFound(error)) return;
      throw mapError(error);
    }
  }
}
