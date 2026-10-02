import {
  AnthropicError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { classifyAnthropicError, isSpendCapError, retryAfterMs } from './errors';

const NOW = new Date('2026-10-02T12:00:00.000Z');

/** What the SDK builds from an HTTP error response (APIError.generate picks the subclass). */
function apiError(status: number, type: string, headers: Record<string, string> = {}, details?: Record<string, unknown>): APIError {
  const body = { type: 'error', error: { type, message: 'messages.0.content: "Hi Maya, about your leaking tap" is invalid', ...(details ? { details } : {}) }, request_id: 'req_011' };
  return APIError.generate(status, body, undefined, new Headers({ 'request-id': 'req_011', ...headers }));
}

describe('classifyAnthropicError (D-24)', () => {
  it.each([
    ['our abort signal fired (APIUserAbortError)', new APIUserAbortError(), 'aborted'],
    ['a client timeout', new APIConnectionTimeoutError(), 'timeout'],
    ['a connection failure', new APIConnectionError({ message: 'socket hang up' }), 'connection_error'],
    ['529 overloaded', apiError(529, 'overloaded_error'), 'overloaded'],
    ['500 api_error', apiError(500, 'api_error'), 'server_error'],
    ['504 timeout_error', apiError(504, 'timeout_error'), 'server_error'],
    ['409 conflict', apiError(409, 'conflict_error'), 'conflict'],
    ['408 request timeout', apiError(408, 'timeout_error'), 'request_timeout'],
  ])('TRANSIENT: %s', (_label, error, code) => {
    expect(classifyAnthropicError(error, NOW)).toMatchObject({ failure: 'transient', errorCode: code });
  });

  it('TRANSIENT: a 429 with retry-after carries the delay', () => {
    expect(classifyAnthropicError(apiError(429, 'rate_limit_error', { 'retry-after': '30' }), NOW)).toEqual({
      failure: 'transient',
      errorCode: 'rate_limited',
      errorName: 'RateLimitError',
      httpStatus: 429,
      requestId: 'req_011',
      retryAfterMs: 30_000,
    });
  });

  it.each([
    ['400 invalid request (bad params, schema too complex, a spend limit we set)', apiError(400, 'invalid_request_error'), 'bad_request'],
    ['401 bad key', apiError(401, 'authentication_error'), 'authentication_failed'],
    ['403 permission', apiError(403, 'permission_error'), 'permission_denied'],
    ['404 bad or retired model id (D-25)', apiError(404, 'not_found_error'), 'model_not_found'],
    ['402 billing', apiError(402, 'billing_error'), 'billing_error'],
    ['413 request too large', apiError(413, 'request_too_large'), 'request_too_large'],
    ['422 unprocessable', apiError(422, 'invalid_request_error'), 'unprocessable'],
    ['another 4xx', apiError(418, 'invalid_request_error'), 'api_error'],
    ['a 429 without retry-after', apiError(429, 'rate_limit_error'), 'rate_limited_no_retry_after'],
    ['the duration guard (a plain AnthropicError)', new AnthropicError('Streaming is required for operations that may take longer than 10 minutes.'), 'client_error'],
    ['a non-SDK throw', new TypeError('x is not a function'), 'unexpected_error'],
  ])('FATAL-CONFIG: %s', (_label, error, code) => {
    expect(classifyAnthropicError(error, NOW)).toMatchObject({ failure: 'fatal_config', errorCode: code });
  });

  it('FATAL-CONFIG: the tier spend-cap 429, even with a retry-after header', () => {
    const capped = apiError(429, 'rate_limit_error', { 'retry-after': '5' }, { error_code: 'enforced_spend_limit_reached' });
    expect(isSpendCapError(capped)).toBe(true);
    expect(classifyAnthropicError(capped, NOW)).toMatchObject({ failure: 'fatal_config', errorCode: 'spend_cap', httpStatus: 429, requestId: 'req_011' });
    expect(isSpendCapError(apiError(429, 'rate_limit_error'))).toBe(false);
  });

  it('never carries the SDK message (it can quote request content)', () => {
    for (const error of [apiError(400, 'invalid_request_error'), apiError(529, 'overloaded_error'), new APIConnectionError({ message: 'Maya <maya@example.com>' })]) {
      const text = JSON.stringify(classifyAnthropicError(error, NOW));
      expect(text).not.toContain('Maya');
      expect(text).not.toContain('leaking');
    }
  });
});

describe('retryAfterMs', () => {
  it('reads retry-after-ms first, then retry-after seconds or an HTTP date relative to the Clock', () => {
    expect(retryAfterMs(new Headers({ 'retry-after-ms': '1500', 'retry-after': '30' }), NOW)).toBe(1500);
    expect(retryAfterMs(new Headers({ 'retry-after': '2.5' }), NOW)).toBe(2500);
    expect(retryAfterMs(new Headers({ 'retry-after': 'Fri, 02 Oct 2026 12:01:00 GMT' }), NOW)).toBe(60_000);
  });

  it('ignores absent, past, zero or unreadable values', () => {
    expect(retryAfterMs(undefined, NOW)).toBeUndefined();
    expect(retryAfterMs(new Headers(), NOW)).toBeUndefined();
    expect(retryAfterMs(new Headers({ 'retry-after': '0' }), NOW)).toBeUndefined();
    expect(retryAfterMs(new Headers({ 'retry-after': 'Fri, 02 Oct 2026 11:00:00 GMT' }), NOW)).toBeUndefined();
    expect(retryAfterMs(new Headers({ 'retry-after': 'soon' }), NOW)).toBeUndefined();
  });
});
