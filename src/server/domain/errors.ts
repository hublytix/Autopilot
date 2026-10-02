import 'server-only';
import type { WebFetchErrorCode } from './types';

// The typed error hierarchy every port and service uses. An error carries only a machine-readable
// `code` (a literal chosen by the thrower), an optional HTTP status and, for transient errors, an
// optional retry delay. It never carries user content, tokens, provider messages or a `cause`
// (law 4, PLAN §10.10): the message is the code itself.

export type ErrorKind = 'transient' | 'permanent' | 'config' | 'revoked' | 'idempotency_conflict';

/** Accepts only string-literal types, so a code read from a response body or user input does not compile. */
export type LiteralCode<C extends string> = string extends C ? never : C;

export interface ErrorDetails {
  /** HTTP status of the failed call, when there was one. */
  httpStatus?: number | undefined;
}

export interface TransientErrorDetails extends ErrorDetails {
  /** How long the provider asked us to wait (Retry-After), in milliseconds. */
  retryAfterMs?: number | undefined;
}

// Defence in depth for the compile-time check above: no spaces, `@`, `/` or long strings.
const CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
export const INVALID_ERROR_CODE = 'invalid_error_code';

function safeCode(code: string): string {
  return CODE_PATTERN.test(code) ? code : INVALID_ERROR_CODE;
}

function safeHttpStatus(status: number | undefined): number | undefined {
  return status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

export abstract class AppError extends Error {
  abstract readonly kind: ErrorKind;
  /** Machine-readable code, e.g. `hubspot_rate_limited`; also the message. */
  readonly code: string;
  readonly httpStatus: number | undefined;

  protected constructor(code: string, details: ErrorDetails | undefined) {
    const safe = safeCode(code);
    super(safe);
    this.code = safe;
    this.httpStatus = safeHttpStatus(details?.httpStatus);
  }
}

/** Worth retrying later (429, 5xx, timeouts, network): jobs return 5xx so QStash backs off. */
export class TransientError<C extends string = string> extends AppError {
  override readonly name: string = 'TransientError';
  readonly kind = 'transient';
  readonly retryAfterMs: number | undefined;

  constructor(code: LiteralCode<C>, details?: TransientErrorDetails) {
    super(code, details);
    const retryAfterMs = details?.retryAfterMs;
    this.retryAfterMs =
      retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? Math.ceil(retryAfterMs) : undefined;
  }
}

/** Retrying will not help (bad request, not found, validation): run the failure path. */
export class PermanentError<C extends string = string> extends AppError {
  override readonly name: string = 'PermanentError';
  readonly kind = 'permanent';

  constructor(code: LiteralCode<C>, details?: ErrorDetails) {
    super(code, details);
  }
}

/** Operator misconfiguration (bad client id or secret, wrong key mode): alert once, never revoke portals. */
export class ConfigError<C extends string = string> extends AppError {
  override readonly name: string = 'ConfigError';
  readonly kind = 'config';

  constructor(code: LiteralCode<C>, details?: ErrorDetails) {
    super(code, details);
  }
}

/** The HubSpot connection is revoked (refresh `invalid_grant`, `BAD_REFRESH_TOKEN`, `BAD_HUB`): terminal (D-11). */
export class RevokedError<C extends string = string> extends AppError {
  override readonly name: string = 'RevokedError';
  readonly kind = 'revoked';

  constructor(code: LiteralCode<C>, details?: ErrorDetails) {
    super(code, details);
  }
}

/**
 * Resend 409 `invalid_idempotent_request`: an earlier attempt with this idempotency key already sent
 * the email (with a different payload), so the reservation is marked sent (PLAN §8.4 step 4, D-45).
 */
export class IdempotencyConflictError extends AppError {
  override readonly name: string = 'IdempotencyConflictError';
  readonly kind = 'idempotency_conflict';

  constructor() {
    super('invalid_idempotent_request', { httpStatus: 409 });
  }
}

/** `WebFetcher.fetch` refused or failed one page; the brief builder skips that page (PLAN §9.7, §10.4). */
export class WebFetchError extends PermanentError<WebFetchErrorCode> {
  override readonly name: string = 'WebFetchError';
  declare readonly code: WebFetchErrorCode;

  constructor(code: WebFetchErrorCode, details?: ErrorDetails) {
    super(code, details);
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export function isTransient(e: unknown): e is TransientError {
  return e instanceof TransientError;
}

/**
 * Worth retrying: any AppError of kind `transient`, i.e. a TransientError or a transient DbError
 * (connection failure, serialization failure, deadlock, …). Job handlers use this rather than
 * `isTransient`, which matches TransientError only.
 */
export function isRetryable(e: unknown): e is AppError {
  return e instanceof AppError && e.kind === 'transient';
}

export function isPermanent(e: unknown): e is PermanentError {
  return e instanceof PermanentError;
}

export function isConfigError(e: unknown): e is ConfigError {
  return e instanceof ConfigError;
}

export function isRevoked(e: unknown): e is RevokedError {
  return e instanceof RevokedError;
}

export function isIdempotencyConflict(e: unknown): e is IdempotencyConflictError {
  return e instanceof IdempotencyConflictError;
}

/** A code that is always safe to log: the AppError's code, otherwise `unknown_error`. */
export function errorCode(e: unknown): string {
  return e instanceof AppError ? e.code : 'unknown_error';
}
