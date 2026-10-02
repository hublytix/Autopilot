import { describe, expect, it } from 'vitest';
import {
  AppError,
  ConfigError,
  IdempotencyConflictError,
  INVALID_ERROR_CODE,
  PermanentError,
  RevokedError,
  TransientError,
  WebFetchError,
  errorCode,
  isAppError,
  isConfigError,
  isIdempotencyConflict,
  isPermanent,
  isRetryable,
  isRevoked,
  isTransient,
} from './errors';

describe('error hierarchy', () => {
  it('carries the code as the message and a stable name', () => {
    const e = new TransientError('hubspot_rate_limited', { httpStatus: 429, retryAfterMs: 10_000 });
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(AppError);
    expect(e.kind).toBe('transient');
    expect(e.code).toBe('hubspot_rate_limited');
    expect(e.message).toBe('hubspot_rate_limited');
    expect(e.name).toBe('TransientError');
    expect(String(e)).toBe('TransientError: hubspot_rate_limited');
    expect(e.httpStatus).toBe(429);
    expect(e.retryAfterMs).toBe(10_000);
  });

  it('gives each class its own kind and name', () => {
    const cases: [AppError, string, string][] = [
      [new PermanentError('hubspot_not_found'), 'permanent', 'PermanentError'],
      [new ConfigError('hubspot_oauth_config'), 'config', 'ConfigError'],
      [new RevokedError('hubspot_refresh_revoked'), 'revoked', 'RevokedError'],
      [new IdempotencyConflictError(), 'idempotency_conflict', 'IdempotencyConflictError'],
      [new WebFetchError('robots_disallowed'), 'permanent', 'WebFetchError'],
    ];
    for (const [error, kind, name] of cases) {
      expect(error.kind).toBe(kind);
      expect(error.name).toBe(name);
    }
  });

  it('never carries a cause, so wrapped SDK messages cannot leak (law 4)', () => {
    const e = new PermanentError('razorpay_bad_request');
    expect(e.cause).toBeUndefined();
    expect(Object.keys(e)).not.toContain('cause');
  });

  it('replaces a code that looks like user content', () => {
    // Literals, as the compile-time check demands; the runtime check is what is under test.
    const tooLong = 'x'.repeat(65) as 'x';
    for (const code of ['lead@example.com', 'two words', 'https://x.test/a', tooLong, '', '_leading'] as const) {
      const e = new PermanentError(code);
      expect(e.code).toBe(INVALID_ERROR_CODE);
      expect(e.message).toBe(INVALID_ERROR_CODE);
      expect(e.stack ?? '').not.toContain('lead@example.com');
    }
  });

  it('accepts provider-style codes', () => {
    for (const code of ['invalid_idempotent_request', 'BAD_REFRESH_TOKEN', 'hubspot.forms:list', 'http-503'] as const) {
      expect(new TransientError(code).code).toBe(code);
    }
  });

  it('rejects non-literal codes at compile time', () => {
    const fromBody: string = 'anything';
    // @ts-expect-error a code read at runtime is not a literal
    const e = new TransientError(fromBody);
    expect(e.code).toBe('anything');
  });

  it('keeps only a sane retry delay and HTTP status', () => {
    expect(new TransientError('a', { retryAfterMs: 1500.2 }).retryAfterMs).toBe(1501);
    expect(new TransientError('a', { retryAfterMs: 0 }).retryAfterMs).toBe(0);
    expect(new TransientError('a', { retryAfterMs: -1 }).retryAfterMs).toBeUndefined();
    expect(new TransientError('a', { retryAfterMs: Number.NaN }).retryAfterMs).toBeUndefined();
    expect(new TransientError('a', { retryAfterMs: Number.POSITIVE_INFINITY }).retryAfterMs).toBeUndefined();
    expect(new TransientError('a').retryAfterMs).toBeUndefined();
    expect(new PermanentError('a', { httpStatus: 404 }).httpStatus).toBe(404);
    expect(new PermanentError('a', { httpStatus: 42 }).httpStatus).toBeUndefined();
    expect(new PermanentError('a', { httpStatus: 404.5 }).httpStatus).toBeUndefined();
  });

  it('models the Resend 409 conflict on our own key', () => {
    const e = new IdempotencyConflictError();
    expect(e.code).toBe('invalid_idempotent_request');
    expect(e.httpStatus).toBe(409);
    expect(isPermanent(e)).toBe(false);
    expect(isTransient(e)).toBe(false);
    expect(isIdempotencyConflict(e)).toBe(true);
  });

  it('makes WebFetchError a permanent error with a fetch code', () => {
    const e = new WebFetchError('http_error', { httpStatus: 503 });
    expect(isPermanent(e)).toBe(true);
    expect(e.code).toBe('http_error');
    expect(e.httpStatus).toBe(503);
  });
});

describe('guards', () => {
  it('isTransient matches only TransientError', () => {
    expect(isTransient(new TransientError('x'))).toBe(true);
    expect(isTransient(new PermanentError('x'))).toBe(false);
    expect(isTransient(new Error('x'))).toBe(false);
    expect(isTransient('x')).toBe(false);
    expect(isTransient(undefined)).toBe(false);
  });

  it('isRetryable matches every transient-kind AppError and nothing else', () => {
    expect(isRetryable(new TransientError('x'))).toBe(true);
    expect([new PermanentError('p'), new ConfigError('c'), new RevokedError('r'), new IdempotencyConflictError()].some(isRetryable)).toBe(false);
    expect(isRetryable(new Error('x'))).toBe(false);
    expect(isRetryable({ kind: 'transient' })).toBe(false);
  });

  it('each guard matches its own class only', () => {
    const errors = [new TransientError('t'), new PermanentError('p'), new ConfigError('c'), new RevokedError('r')];
    expect(errors.map(isPermanent)).toEqual([false, true, false, false]);
    expect(errors.map(isConfigError)).toEqual([false, false, true, false]);
    expect(errors.map(isRevoked)).toEqual([false, false, false, true]);
    expect(errors.every(isAppError)).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
  });

  it('errorCode never exposes a foreign error message', () => {
    expect(errorCode(new RevokedError('hubspot_refresh_revoked'))).toBe('hubspot_refresh_revoked');
    expect(errorCode(new Error('message with lead@example.com'))).toBe('unknown_error');
    expect(errorCode({ code: 'x' })).toBe('unknown_error');
    expect(errorCode(null)).toBe('unknown_error');
  });
});
