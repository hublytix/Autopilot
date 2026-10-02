import { describe, expect, it } from 'vitest';
import { API_WIRE, FakeHubSpot, REFRESH_WIRE, wireResponseOf } from '@/server/adapters/fake/hubspot';
import { FakeClock } from '@/server/adapters/fake/clock';
import { ConfigError, RevokedError, TransientError, errorCode } from '@/server/domain/errors';
import type { RefreshFailureClass } from '@/server/domain/types';
import { classifyRefreshFailure } from './refresh-classifier';

// D-11's table, on the exact bodies from research (HS-OAUTH-REFRESH-ERRORS, HS-V2-AUTH-CODE-ERRORS,
// HS-429-SHAPE, 02.y) and on the wire fixtures the fake HubSpot simulates.

/** 02.y `refresh_revoked`, verbatim. */
const REFRESH_REVOKED = {
  error: 'invalid_grant',
  error_description: 'refresh token is invalid, expired or revoked',
  status: 'BAD_REFRESH_TOKEN',
  message: 'refresh token is invalid, expired or revoked',
};
/** 02.y `refresh_bad_hub` as corrected by the verifier. */
const REFRESH_BAD_HUB = { status: 'BAD_HUB', message: 'missing or unknown hub id', error: 'access_denied' };
/** 02.y `refresh_bad_client` (message text unknown). */
const REFRESH_BAD_CLIENT = { error: 'invalid_client', status: 'BAD_CLIENT_ID', message: 'missing or invalid client id' };
/** 02.y `rate_limited_daily`, verbatim. */
const RATE_LIMITED_DAILY = {
  status: 'error',
  message: 'You have reached your daily limit.',
  errorType: 'RATE_LIMIT',
  correlationId: 'c033cdaa-2c40-4a64-ae48-b4cec88dad24',
  policyName: 'DAILY',
  requestId: '3d3e35b7-0dae-4b9f-a6e3-9c230cbcf8dd',
};
/** 02.y `rate_limited_ten_secondly`, the verifier's real observed body. */
const RATE_LIMITED_TEN_SECONDLY = {
  status: 'error',
  message: 'You have reached your ten_secondly_rolling limit.',
  errorType: 'RATE_LIMIT',
  correlationId: '20f98dfa-05b6-4d27-8d96-ecfde54ca211',
  policyName: 'TEN_SECONDLY_ROLLING',
  groupName: 'publicapi:private_app-api-calls-ten-secondly:1512050:26892217',
};
/** 02.y `rate_limited_search_secondly`. */
const RATE_LIMITED_SEARCH = { status: 'error', message: 'You have reached your secondly limit.', errorType: 'RATE_LIMIT' };

const cases: readonly { name: string; status: number | null; body: unknown; expected: RefreshFailureClass }[] = [
  // revoked
  { name: 'invalid_grant / BAD_REFRESH_TOKEN (400)', status: 400, body: REFRESH_REVOKED, expected: 'revoked' },
  { name: 'BAD_HUB / access_denied (400)', status: 400, body: REFRESH_BAD_HUB, expected: 'revoked' },
  { name: 'access_denied alone', status: 400, body: { error: 'access_denied' }, expected: 'revoked' },
  { name: 'BAD_REFRESH_TOKEN without an error field', status: 400, body: { status: 'BAD_REFRESH_TOKEN', message: 'missing or invalid refresh token' }, expected: 'revoked' },
  { name: 'BAD_HUB without an error field', status: 400, body: { status: 'BAD_HUB' }, expected: 'revoked' },
  { name: 'invalid_grant on a 401', status: 401, body: { error: 'invalid_grant' }, expected: 'revoked' },
  { name: 'the body as raw JSON text', status: 400, body: JSON.stringify(REFRESH_REVOKED), expected: 'revoked' },
  // config
  { name: 'invalid_client / BAD_CLIENT_ID', status: 400, body: REFRESH_BAD_CLIENT, expected: 'config' },
  { name: 'unauthorized_client', status: 400, body: { error: 'unauthorized_client' }, expected: 'config' },
  { name: 'invalid_request', status: 400, body: { error: 'invalid_request' }, expected: 'config' },
  { name: 'unsupported_grant_type', status: 400, body: { error: 'unsupported_grant_type' }, expected: 'config' },
  { name: 'BAD_CLIENT_ID', status: 400, body: { status: 'BAD_CLIENT_ID' }, expected: 'config' },
  { name: 'BAD_CLIENT_SECRET', status: 400, body: { status: 'BAD_CLIENT_SECRET', message: 'bad client secret' }, expected: 'config' },
  { name: 'BAD_REDIRECT_URI', status: 400, body: { status: 'BAD_REDIRECT_URI' }, expected: 'config' },
  { name: 'BAD_GRANT_TYPE', status: 400, body: { status: 'BAD_GRANT_TYPE' }, expected: 'config' },
  { name: 'error decides before status (invalid_client + BAD_REFRESH_TOKEN)', status: 400, body: { error: 'invalid_client', status: 'BAD_REFRESH_TOKEN' }, expected: 'config' },
  { name: 'a 401 without a revoked marker', status: 401, body: { status: 'error', category: 'INVALID_AUTHENTICATION' }, expected: 'config' },
  { name: 'an unknown 4xx status', status: 400, body: { status: 'SOMETHING_NEW' }, expected: 'config' },
  { name: 'a 403', status: 403, body: null, expected: 'config' },
  { name: 'a 404 HTML page', status: 404, body: '<html>not found</html>', expected: 'config' },
  { name: 'mistyped fields', status: 400, body: { error: 42, status: ['BAD_HUB'] }, expected: 'config' },
  // transient
  { name: 'no response (timeout or network)', status: null, body: null, expected: 'transient' },
  { name: '423', status: 423, body: null, expected: 'transient' },
  { name: '429 TEN_SECONDLY_ROLLING', status: 429, body: RATE_LIMITED_TEN_SECONDLY, expected: 'transient' },
  { name: '429 DAILY', status: 429, body: RATE_LIMITED_DAILY, expected: 'transient' },
  { name: '429 search secondly', status: 429, body: RATE_LIMITED_SEARCH, expected: 'transient' },
  { name: '429 even with invalid_grant', status: 429, body: REFRESH_REVOKED, expected: 'transient' },
  { name: '477 migration', status: 477, body: null, expected: 'transient' },
  { name: '500', status: 500, body: null, expected: 'transient' },
  { name: '502 gateway page', status: 502, body: '<html><body><h1>502</h1></body></html>', expected: 'transient' },
  { name: '503 with invalid_grant', status: 503, body: REFRESH_REVOKED, expected: 'transient' },
  { name: '504', status: 504, body: null, expected: 'transient' },
  { name: '521', status: 521, body: null, expected: 'transient' },
  { name: '524', status: 524, body: null, expected: 'transient' },
  { name: '526', status: 526, body: null, expected: 'transient' },
];

describe('classifyRefreshFailure', () => {
  it.each(cases)('$name → $expected', ({ status, body, expected }) => {
    expect(classifyRefreshFailure(status, body)).toBe(expected);
  });

  it('classifies the fake HubSpot wire fixtures as the fake simulates them', () => {
    const fixture = (w: { status: number | null; body: unknown }): RefreshFailureClass => classifyRefreshFailure(w.status, w.body);
    expect(fixture(REFRESH_WIRE.badRefreshToken)).toBe('revoked');
    expect(fixture(REFRESH_WIRE.badHub)).toBe('revoked');
    expect(fixture(REFRESH_WIRE.invalidClient)).toBe('config');
    expect(fixture(REFRESH_WIRE.badRedirectUri)).toBe('config');
    expect(fixture(API_WIRE.tenSecondly)).toBe('transient');
    expect(fixture(API_WIRE.daily)).toBe('transient');
    expect(fixture(API_WIRE.locked)).toBe('transient');
    // An API-style 401 at the token endpoint is not proof of revocation (HS-OAUTH-REFRESH-ERRORS).
    expect(fixture(API_WIRE.unauthorized)).toBe('config');
  });
});

describe('FakeHubSpot through the real classifier', () => {
  function fakeWithClassifier(): FakeHubSpot {
    return new FakeHubSpot({ clock: new FakeClock(new Date('2026-10-05T12:00:00Z')), classifyRefreshFailure });
  }

  async function refreshFailure(fake: FakeHubSpot, refreshToken: string): Promise<unknown> {
    return fake.refresh(refreshToken).then(
      () => undefined,
      (error: unknown) => error,
    );
  }

  it('a revoked refresh token is RevokedError', async () => {
    const fake = fakeWithClassifier();
    const { refreshToken } = fake.installTokens();
    fake.revokeToken();
    const error = await refreshFailure(fake, refreshToken);
    expect(error).toBeInstanceOf(RevokedError);
    expect(errorCode(error)).toBe('hubspot_refresh_revoked');
    expect(wireResponseOf(error)?.body).toEqual(REFRESH_WIRE.badRefreshToken.body);
  });

  it('a deleted portal (BAD_HUB) is RevokedError', async () => {
    const fake = fakeWithClassifier();
    const { refreshToken } = fake.installTokens();
    fake.setRefreshMode({ kind: 'revoked', variant: 'bad_hub' });
    expect(await refreshFailure(fake, refreshToken)).toBeInstanceOf(RevokedError);
  });

  it('a bad client id is ConfigError and does not revoke', async () => {
    const fake = fakeWithClassifier();
    const { refreshToken } = fake.installTokens();
    fake.setRefreshMode('config');
    const error = await refreshFailure(fake, refreshToken);
    expect(error).toBeInstanceOf(ConfigError);
    expect(errorCode(error)).toBe('hubspot_oauth_config');
  });

  it.each([429, 502, 503] as const)('a %i is TransientError', async (failure) => {
    const fake = fakeWithClassifier();
    const { refreshToken } = fake.installTokens();
    fake.setRefreshMode({ kind: 'transient', times: 1, failure });
    expect(await refreshFailure(fake, refreshToken)).toBeInstanceOf(TransientError);
    await expect(fake.refresh(refreshToken)).resolves.toMatchObject({ refreshToken });
  });

  it('a 477 is TransientError carrying Retry-After', async () => {
    const fake = fakeWithClassifier();
    const { refreshToken } = fake.installTokens();
    fake.setRefreshMode({ kind: 'migration', retryAfterSeconds: 3600 });
    const error = await refreshFailure(fake, refreshToken);
    expect(error).toBeInstanceOf(TransientError);
    expect((error as TransientError).retryAfterMs).toBe(3_600_000);
  });
});
