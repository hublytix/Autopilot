import 'server-only';
import {
  AnthropicError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from '@anthropic-ai/sdk';

// Classifies what `messages.create` threw, after the SDK's own retries (D-24)
// [AI-SDK-ERRORS-RETRIES, V2]:
// - TRANSIENT (the job backs off and retries): APIConnectionError and its timeout subclass,
//   APIUserAbortError (our per-call budget signal fired, possibly during an SDK retry sleep),
//   InternalServerError (500/504/529…), ConflictError (409), a 408, and a RateLimitError that carries
//   retry-after;
// - FATAL-CONFIG (needs-touch at once plus an admin alert; never loops): 400, 401, 403, 404 (a bad
//   or retired model id, D-25), 402 billing, 413, 422, the tier spend-cap 429
//   (`enforced_spend_limit_reached`, no retry-after), any other 429 without retry-after, any other
//   4xx, and a plain AnthropicError raised client-side (e.g. the non-streaming duration guard).
// The SDK's messages are never read: a 400 can quote request fields and a parse error quotes model
// output [AI-SDK-LOGGING-PRIVACY]. Only the class, status, request id and our own code survive.

export type AnthropicFailureKind = 'transient' | 'fatal_config';

export const ANTHROPIC_ERROR_CODES = [
  'aborted',
  'timeout',
  'connection_error',
  'overloaded',
  'server_error',
  'conflict',
  'request_timeout',
  'rate_limited',
  'spend_cap',
  'rate_limited_no_retry_after',
  'bad_request',
  'authentication_failed',
  'permission_denied',
  'model_not_found',
  'billing_error',
  'request_too_large',
  'unprocessable',
  'api_error',
  'client_error',
  'unexpected_error',
] as const;
export type AnthropicErrorCode = (typeof ANTHROPIC_ERROR_CODES)[number];

export interface ClassifiedAnthropicError {
  failure: AnthropicFailureKind;
  errorCode: AnthropicErrorCode;
  /** A safe class name for logs (e.g. `RateLimitError`). */
  errorName: string;
  httpStatus?: number | undefined;
  /** From the `request-id` header, when the API answered. */
  requestId?: string | undefined;
  /** From `retry-after-ms` / `retry-after` (seconds or an HTTP date), transient only. */
  retryAfterMs?: number | undefined;
}

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

function safeName(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const name = (error as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof name === 'string' && SAFE_NAME.test(name)) return name;
  }
  return 'Error';
}

function safeRequestId(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && REQUEST_ID.test(value) ? value : undefined;
}

/** Delay the response asked for, in ms; `now` resolves an HTTP-date `retry-after` (D-28). */
export function retryAfterMs(headers: Headers | undefined, now: Date): number | undefined {
  if (headers === undefined) return undefined;
  const ms = headers.get('retry-after-ms');
  if (ms !== null && /^\d+(?:\.\d+)?$/.test(ms.trim())) {
    const value = Number(ms.trim());
    if (value > 0 && Number.isFinite(value)) return Math.ceil(value);
  }
  const raw = headers.get('retry-after');
  if (raw === null) return undefined;
  const value = raw.trim();
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const seconds = Number(value);
    return seconds > 0 && Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : undefined;
  }
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  const delta = at - now.getTime();
  return delta > 0 ? Math.ceil(delta) : undefined;
}

/** True for the tier monthly spend cap: 429 with `details.error_code` `enforced_spend_limit_reached`. */
export function isSpendCapError(error: unknown): boolean {
  if (!(error instanceof RateLimitError)) return false;
  const body: unknown = error.error;
  if (typeof body !== 'object' || body === null) return false;
  const inner: unknown = (body as { error?: unknown }).error;
  if (typeof inner !== 'object' || inner === null) return false;
  const details: unknown = (inner as { details?: unknown }).details;
  if (typeof details !== 'object' || details === null) return false;
  return (details as { error_code?: unknown }).error_code === 'enforced_spend_limit_reached';
}

function fatal(errorCode: AnthropicErrorCode, error: unknown, extra: Partial<ClassifiedAnthropicError> = {}): ClassifiedAnthropicError {
  return { failure: 'fatal_config', errorCode, errorName: safeName(error), ...extra };
}

function transient(errorCode: AnthropicErrorCode, error: unknown, extra: Partial<ClassifiedAnthropicError> = {}): ClassifiedAnthropicError {
  return { failure: 'transient', errorCode, errorName: safeName(error), ...extra };
}

/** Maps anything `messages.create` threw to TRANSIENT or FATAL-CONFIG with a safe code. */
export function classifyAnthropicError(error: unknown, now: Date): ClassifiedAnthropicError {
  // Connection-level errors and our own abort carry no status, headers or request id.
  if (error instanceof APIUserAbortError) return transient('aborted', error);
  if (error instanceof APIConnectionTimeoutError) return transient('timeout', error);
  if (error instanceof APIConnectionError) return transient('connection_error', error);

  if (error instanceof APIError) {
    const status = typeof error.status === 'number' ? error.status : undefined;
    const meta: Partial<ClassifiedAnthropicError> = { httpStatus: status, requestId: safeRequestId(error.requestID) };
    if (error instanceof RateLimitError) {
      if (isSpendCapError(error)) return fatal('spend_cap', error, meta);
      const delay = retryAfterMs(error.headers, now);
      return delay === undefined ? fatal('rate_limited_no_retry_after', error, meta) : transient('rate_limited', error, { ...meta, retryAfterMs: delay });
    }
    if (error instanceof InternalServerError) return transient(status === 529 ? 'overloaded' : 'server_error', error, meta);
    if (error instanceof ConflictError) return transient('conflict', error, meta);
    if (error instanceof BadRequestError) return fatal('bad_request', error, meta);
    if (error instanceof AuthenticationError) return fatal('authentication_failed', error, meta);
    if (error instanceof PermissionDeniedError) return fatal('permission_denied', error, meta);
    if (error instanceof NotFoundError) return fatal('model_not_found', error, meta);
    if (error instanceof UnprocessableEntityError) return fatal('unprocessable', error, meta);
    if (status === 402) return fatal('billing_error', error, meta);
    if (status === 413) return fatal('request_too_large', error, meta);
    if (status === 408) return transient('request_timeout', error, meta);
    if (status !== undefined && status >= 500) return transient('server_error', error, meta);
    return fatal('api_error', error, meta);
  }
  if (error instanceof AnthropicError) return fatal('client_error', error);
  return fatal('unexpected_error', error);
}
