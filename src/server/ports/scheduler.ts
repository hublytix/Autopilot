import 'server-only';
import type { JobKind } from '@/server/domain/types';

// Live: QStash `publishJSON` to `/api/jobs/run` with body `{jobId}` (ids only), `notBefore` only,
// `Upstash-Retries: retries`, `Upstash-Retry-Delay: pow(2, retried) * 10000` and a failure callback
// to `/api/jobs/failed` (PLAN §4, D-11, D-15). Fake: an ordered queue whose `runDue(now)` calls an
// injected dispatch callback. Durable idempotency is the `scheduled_jobs` row, not this port.
//
// Errors: TransientError (429 incl. quota, 5xx, network), PermanentError (other 4xx), ConfigError
// (401/403: bad token or wrong region).

export interface PublishRequest {
  jobId: string;
  kind: JobKind;
  /**
   * When to deliver. Must be within `QSTASH_MAX_DELAY_SECONDS` of now: the jobs layer hops for later
   * targets (PLAN §8.3 step 2).
   */
  runAt: Date;
  /** `{ENV_NAMESPACE}:{dedupe_key}`, plus `:h{hops}` on a re-publish. */
  dedupeId: string;
  /** Redeliveries after the first; 4 for every kind (5 deliveries). */
  retries: number;
}

export interface PublishResult {
  messageId: string;
  /** QStash already had this dedupe id (10-minute window); `messageId` is the original. An error for a re-publish. */
  deduplicated: boolean;
}

export interface Scheduler {
  /** Publishes one job delivery for `runAt`. */
  publish(request: PublishRequest): Promise<PublishResult>;

  /** Cancels one message by id; 404 (already delivered or cancelled) counts as success. Never a bulk cancel. */
  cancel(messageId: string): Promise<void>;
}
