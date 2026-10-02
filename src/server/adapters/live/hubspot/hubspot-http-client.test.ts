import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_WIRE, REFRESH_WIRE } from '@/server/adapters/fake/hubspot';
import { AppError, ConfigError, PermanentError, RevokedError, TransientError, errorCode } from '@/server/domain/errors';
import type { EmailMetadataProperty, HubSpotContactProperty } from '@/server/domain/types';
import { REQUIRED_SCOPES } from '@/server/hubspot/scopes';
import { FAKE_HUBSPOT_REFRESH_TOKEN } from '../../../../../test/support/fake-secrets';
import {
  emptyResponse,
  formFields,
  hangingResponder,
  jsonBody,
  jsonResponse,
  recordingFetch,
  textResponse,
  type Responder,
} from '../../../../../test/hubspot/http-harness';
import { HubSpotHttpClient } from './hubspot-http-client';

const CLIENT_ID = 'fake-hubspot-client-id';
const CLIENT_SECRET = 'fake-hubspot-client-secret';
const ACCESS_TOKEN = 'test-access-token-0001';
const REFRESH_TOKEN = FAKE_HUBSPOT_REFRESH_TOKEN;
const REDIRECT_URI = 'https://autopilot.example.com/api/hubspot/oauth/callback';
const API = 'https://api.hubapi.com';

function client(responder: Responder, options: { timeoutMs?: number; apiVersion?: string } = {}) {
  const recording = recordingFetch(responder);
  return {
    hubspot: new HubSpotHttpClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetch: recording.fetch, ...options }),
    requests: recording.requests,
  };
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected a failure');
}

/** 02.y `token_success_2026_09`, with fake token values. */
const TOKEN_BODY = {
  token_type: 'bearer',
  refresh_token: REFRESH_TOKEN,
  access_token: ACCESS_TOKEN,
  hub_id: 1234567,
  scopes: ['oauth', 'crm.objects.contacts.read', 'forms', 'sales-email-read'],
  token_use: 'access_token',
  expires_in: 1800,
};

afterEach(() => {
  vi.useRealTimers();
});

// -------------------------------------------------------------------------------------------------
// OAuth
// -------------------------------------------------------------------------------------------------

describe('authorizeUrl', () => {
  it('matches the research vector byte for byte (%20 for spaces)', () => {
    const { hubspot, requests } = client(() => jsonResponse(200, {}));
    const custom = new HubSpotHttpClient({ clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', clientSecret: CLIENT_SECRET });
    expect(custom.authorizeUrl({ state: 'random-state', redirectUri: REDIRECT_URI, scopes: REQUIRED_SCOPES })).toBe(
      'https://app.hubspot.com/oauth/authorize?client_id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee&redirect_uri=https%3A%2F%2Fautopilot.example.com%2Fapi%2Fhubspot%2Foauth%2Fcallback&scope=oauth%20crm.objects.contacts.read%20forms%20sales-email-read&state=random-state',
    );
    expect(hubspot.authorizeUrl({ state: 's', redirectUri: REDIRECT_URI, scopes: REQUIRED_SCOPES })).not.toContain(CLIENT_SECRET);
    expect(requests).toHaveLength(0);
  });

  it.each([
    ['a missing scope', REQUIRED_SCOPES.slice(0, 3)],
    ['a write scope', [...REQUIRED_SCOPES, 'crm.objects.contacts.write']],
    ['a replaced scope', ['oauth', 'crm.objects.contacts.read', 'forms', 'crm.objects.emails.read']],
  ])('refuses %s (law 2)', (_name, scopes) => {
    const { hubspot } = client(() => jsonResponse(200, {}));
    expect(() => hubspot.authorizeUrl({ state: 's', redirectUri: REDIRECT_URI, scopes })).toThrow(ConfigError);
  });
});

describe('exchangeCode', () => {
  it('posts a form-encoded body to the dated token endpoint and returns the token set', async () => {
    const { hubspot, requests } = client(() => jsonResponse(200, TOKEN_BODY));
    await expect(hubspot.exchangeCode('code-123', REDIRECT_URI)).resolves.toEqual({
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresInSeconds: 1800,
      hubId: '1234567',
      scopes: ['oauth', 'crm.objects.contacts.read', 'forms', 'sales-email-read'],
    });
    const [request] = requests;
    expect(request?.method).toBe('POST');
    expect(request?.url.href).toBe(`${API}/oauth/2026-09/token`);
    expect(request?.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(request?.headers.get('authorization')).toBeNull();
    expect(request && formFields(request)).toEqual({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code: 'code-123',
    });
  });

  it.each([
    ['an expired or reused code (BAD_AUTH_CODE)', REFRESH_WIRE.badAuthCode.body, PermanentError, 'hubspot_bad_auth_code'],
    ['BAD_AUTH_CODE without an error field', { status: 'BAD_AUTH_CODE', message: 'missing or invalid auth code' }, PermanentError, 'hubspot_bad_auth_code'],
    ['a redirect URI mismatch', REFRESH_WIRE.badRedirectUri.body, ConfigError, 'hubspot_oauth_config'],
    ['a bad client id', REFRESH_WIRE.invalidClient.body, ConfigError, 'hubspot_oauth_config'],
    ['BAD_CLIENT_SECRET', { status: 'BAD_CLIENT_SECRET', message: 'x' }, ConfigError, 'hubspot_oauth_config'],
  ] as const)('maps %s', async (_name, body, type, code) => {
    const { hubspot } = client(() => jsonResponse(400, body));
    const error = await failure(hubspot.exchangeCode('code-123', REDIRECT_URI));
    expect(error).toBeInstanceOf(type);
    expect(error.code).toBe(code);
    expect(error.httpStatus).toBe(400);
  });

  it('maps a 502 to TransientError', async () => {
    const { hubspot } = client(() => textResponse(502, '<html>bad gateway</html>'));
    const error = await failure(hubspot.exchangeCode('code-123', REDIRECT_URI));
    expect(error).toBeInstanceOf(TransientError);
    expect(error.code).toBe('hubspot_server_error');
  });

  it('refuses a token response without a refresh token', async () => {
    const { refresh_token: _omitted, ...withoutRefresh } = TOKEN_BODY;
    const { hubspot } = client(() => jsonResponse(200, withoutRefresh));
    const error = await failure(hubspot.exchangeCode('code-123', REDIRECT_URI));
    expect(error).toBeInstanceOf(PermanentError);
    expect(error.code).toBe('hubspot_invalid_response');
  });
});

describe('refresh', () => {
  it('posts grant_type=refresh_token in a form body, never in the URL', async () => {
    const { hubspot, requests } = client(() => jsonResponse(200, TOKEN_BODY));
    await hubspot.refresh(REFRESH_TOKEN);
    const [request] = requests;
    expect(request?.url.href).toBe(`${API}/oauth/2026-09/token`);
    expect(request?.url.search).toBe('');
    expect(request && formFields(request)).toEqual({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
    });
  });

  it('keeps a rotated refresh token, and the old one when the response omits it', async () => {
    const rotated = client(() => jsonResponse(200, { ...TOKEN_BODY, refresh_token: 'rotated-refresh-token' }));
    await expect(rotated.hubspot.refresh(REFRESH_TOKEN)).resolves.toMatchObject({ refreshToken: 'rotated-refresh-token' });
    const { refresh_token: _omitted, ...withoutRefresh } = TOKEN_BODY;
    const kept = client(() => jsonResponse(200, withoutRefresh));
    await expect(kept.hubspot.refresh(REFRESH_TOKEN)).resolves.toMatchObject({ refreshToken: REFRESH_TOKEN, expiresInSeconds: 1800 });
  });

  it.each([
    ['invalid_grant / BAD_REFRESH_TOKEN', () => jsonResponse(400, REFRESH_WIRE.badRefreshToken.body), RevokedError, 'hubspot_refresh_revoked', undefined],
    ['BAD_HUB / access_denied', () => jsonResponse(400, REFRESH_WIRE.badHub.body), RevokedError, 'hubspot_refresh_revoked', undefined],
    ['invalid_client / BAD_CLIENT_ID', () => jsonResponse(400, REFRESH_WIRE.invalidClient.body), ConfigError, 'hubspot_oauth_config', undefined],
    ['a 401 with no revoked marker', () => jsonResponse(401, API_WIRE.unauthorized.body), ConfigError, 'hubspot_oauth_config', undefined],
    ['429 ten-secondly with Retry-After', () => jsonResponse(429, API_WIRE.tenSecondly.body, { 'Retry-After': '7' }), TransientError, 'hubspot_rate_limited', 7000],
    ['429 daily', () => jsonResponse(429, API_WIRE.daily.body), TransientError, 'hubspot_daily_limit', undefined],
    ['477 with Retry-After', () => emptyResponse(477, { 'Retry-After': '3600' }), TransientError, 'hubspot_migration_in_progress', 3_600_000],
    ['423', () => jsonResponse(423, API_WIRE.locked.body), TransientError, 'hubspot_locked', undefined],
    ['a 502 gateway page', () => textResponse(502, '<html>502</html>'), TransientError, 'hubspot_server_error', undefined],
    ['a 200 that is not a token response', () => textResponse(200, '<html>ok</html>'), TransientError, 'hubspot_invalid_response', undefined],
    ['a redirect', () => emptyResponse(302, { Location: 'https://example.com/' }), TransientError, 'hubspot_invalid_response', undefined],
  ] as const)('maps %s', async (_name, respond, type, code, retryAfterMs) => {
    const { hubspot } = client(respond);
    const error = await failure(hubspot.refresh(REFRESH_TOKEN));
    expect(error).toBeInstanceOf(type);
    expect(error.code).toBe(code);
    if (error instanceof TransientError) expect(error.retryAfterMs).toBe(retryAfterMs);
  });

  it('maps a network failure to TransientError hubspot_network', async () => {
    const { hubspot } = client(() => Promise.reject(new TypeError(`fetch failed for ${REFRESH_TOKEN}`)));
    const error = await failure(hubspot.refresh(REFRESH_TOKEN));
    expect(error).toBeInstanceOf(TransientError);
    expect(error.code).toBe('hubspot_network');
    expect(error.httpStatus).toBeUndefined();
  });

  it('never puts the token, the client secret or the body into the error', async () => {
    const body = {
      error: 'invalid_grant',
      error_description: 'refresh token is invalid, expired or revoked',
      status: 'BAD_REFRESH_TOKEN',
      message: 'refresh token is invalid, expired or revoked',
      echoed: REFRESH_TOKEN,
    };
    const { hubspot } = client(() => jsonResponse(400, body));
    const error = await failure(hubspot.refresh(REFRESH_TOKEN));
    const dump = `${String(error)} ${error.message} ${error.stack ?? ''} ${JSON.stringify(error)} ${JSON.stringify(Object.entries(error))}`;
    expect(dump).not.toContain(REFRESH_TOKEN);
    expect(dump).not.toContain(CLIENT_SECRET);
    expect(dump).not.toContain('refresh token is invalid');
    expect('cause' in error).toBe(false);
  });
});

describe('introspect', () => {
  /** 02.y `introspect_refresh_token`, with fake ids. */
  const ACTIVE = {
    active: true,
    token: REFRESH_TOKEN,
    hub_id: 1234567,
    user_id: 222222,
    client_id: CLIENT_ID,
    app_id: 1234444,
    user: 'JDoe@HubSpot.com',
    hub_domain: 'example.com',
    scopes: ['crm.objects.contacts.write', 'oauth', 'crm.objects.contacts.read'],
    token_use: 'refresh_token',
    token_type: 'Bearer',
  };

  it('posts client credentials, the token and the hint in a form body', async () => {
    const { hubspot, requests } = client(() => jsonResponse(200, ACTIVE));
    await expect(hubspot.introspect(REFRESH_TOKEN, 'refresh_token')).resolves.toEqual({
      active: true,
      hubId: '1234567',
      hubDomain: 'example.com',
      userEmail: 'jdoe@hubspot.com',
      scopes: ['crm.objects.contacts.write', 'oauth', 'crm.objects.contacts.read'],
      appId: '1234444',
      tokenType: 'refresh_token',
    });
    const [request] = requests;
    expect(request?.url.href).toBe(`${API}/oauth/2026-09/token/introspect`);
    expect(request && formFields(request)).toEqual({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      token: REFRESH_TOKEN,
      token_type_hint: 'refresh_token',
    });
  });

  it('reads {active:false} as revoked or uninstalled', async () => {
    const { hubspot } = client(() => jsonResponse(200, { active: false }));
    await expect(hubspot.introspect(REFRESH_TOKEN, 'refresh_token')).resolves.toEqual({ active: false });
  });

  it('reads a token HubSpot calls invalid as inactive', async () => {
    const { hubspot } = client(() => jsonResponse(400, REFRESH_WIRE.badRefreshToken.body));
    await expect(hubspot.introspect(REFRESH_TOKEN, 'refresh_token')).resolves.toEqual({ active: false });
  });

  it('falls back to the hint and to nulls when HubSpot omits optional fields', async () => {
    const { hubspot } = client(() => jsonResponse(200, { active: true, hub_id: '42', app_id: '7100001' }));
    await expect(hubspot.introspect(ACCESS_TOKEN, 'access_token')).resolves.toEqual({
      active: true,
      hubId: '42',
      hubDomain: null,
      userEmail: null,
      scopes: [],
      appId: '7100001',
      tokenType: 'access_token',
    });
  });

  it.each([
    ['a client misconfiguration', () => jsonResponse(400, REFRESH_WIRE.invalidClient.body), ConfigError, 'hubspot_oauth_config'],
    ['a 503', () => textResponse(503, 'down'), TransientError, 'hubspot_server_error'],
    ['an active token without hub_id', () => jsonResponse(200, { active: true, app_id: 1 }), PermanentError, 'hubspot_invalid_response'],
    ['a body without active', () => jsonResponse(200, { hub_id: 1 }), PermanentError, 'hubspot_invalid_response'],
  ] as const)('maps %s', async (_name, respond, type, code) => {
    const { hubspot } = client(respond);
    const error = await failure(hubspot.introspect(REFRESH_TOKEN, 'refresh_token'));
    expect(error).toBeInstanceOf(type);
    expect(error.code).toBe(code);
  });
});

describe('revoke', () => {
  it('posts the refresh token with its hint and accepts 200 or 204', async () => {
    for (const respond of [() => jsonResponse(200, {}), () => emptyResponse(204)]) {
      const { hubspot, requests } = client(respond);
      await expect(hubspot.revoke(REFRESH_TOKEN)).resolves.toBeUndefined();
      expect(requests[0]?.url.href).toBe(`${API}/oauth/2026-09/token/revoke`);
      expect(requests[0] && formFields(requests[0])).toEqual({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        token: REFRESH_TOKEN,
        token_type_hint: 'refresh_token',
      });
    }
  });

  it('treats an already revoked token as revoked', async () => {
    const { hubspot } = client(() => jsonResponse(400, REFRESH_WIRE.badRefreshToken.body));
    await expect(hubspot.revoke(REFRESH_TOKEN)).resolves.toBeUndefined();
  });

  it('throws ConfigError for a client misconfiguration and TransientError for a 500', async () => {
    expect(await failure(client(() => jsonResponse(400, REFRESH_WIRE.invalidClient.body)).hubspot.revoke(REFRESH_TOKEN))).toBeInstanceOf(
      ConfigError,
    );
    expect(await failure(client(() => textResponse(500, 'oops')).hubspot.revoke(REFRESH_TOKEN))).toBeInstanceOf(TransientError);
  });
});

// -------------------------------------------------------------------------------------------------
// API calls
// -------------------------------------------------------------------------------------------------

describe('accountDetails', () => {
  /** 02.y `account_details`. */
  const DETAILS = {
    portalId: 123456,
    accountType: 'STANDARD',
    timeZone: 'US/Eastern',
    companyCurrency: 'USD',
    additionalCurrencies: ['EUR'],
    utcOffset: '-05:00',
    utcOffsetMilliseconds: -18000000,
    uiDomain: 'app.hubspot.com',
    dataHostingLocation: 'na1',
  };

  it('reads the dated account-info endpoint with the bearer token', async () => {
    const { hubspot, requests } = client(() => jsonResponse(200, DETAILS));
    await expect(hubspot.accountDetails(ACCESS_TOKEN)).resolves.toEqual({
      portalId: '123456',
      timeZone: 'US/Eastern',
      utcOffsetMilliseconds: -18000000,
      uiDomain: 'app.hubspot.com',
      dataHostingLocation: 'na1',
      accountType: 'STANDARD',
    });
    const [request] = requests;
    expect(request?.method).toBe('GET');
    expect(request?.url.href).toBe(`${API}/account-info/2026-09/details`);
    expect(request?.headers.get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(request?.redirect).toBe('manual');
  });

  it('accepts the EU example with extra fields', async () => {
    const eu = {
      additionalCurrencies: ['NZD', 'AUD', 'EUR'],
      companyCurrency: 'USD',
      createdAt: 1648840584303,
      dataHostingLocation: 'eu1',
      portalId: 12345678,
      portalName: 'Acme Inc',
      timeZone: 'US/Eastern',
      uiDomain: 'app-eu1.hubspot.com',
      utcOffset: '-04:00',
      utcOffsetMilliseconds: -14400000,
      accountType: 'STANDARD',
    };
    const { hubspot } = client(() => jsonResponse(200, eu));
    await expect(hubspot.accountDetails(ACCESS_TOKEN)).resolves.toMatchObject({ portalId: '12345678', uiDomain: 'app-eu1.hubspot.com' });
  });

  it('follows HUBSPOT_API_VERSION', async () => {
    const { hubspot, requests } = client(() => jsonResponse(200, DETAILS), { apiVersion: '2026-03' });
    await hubspot.accountDetails(ACCESS_TOKEN);
    expect(requests[0]?.url.pathname).toBe('/account-info/2026-03/details');
  });

  it('refuses a uiDomain that is not a host name', async () => {
    const { hubspot } = client(() => jsonResponse(200, { ...DETAILS, uiDomain: 'evil.example/phish?x=' }));
    expect((await failure(hubspot.accountDetails(ACCESS_TOKEN))).code).toBe('hubspot_invalid_response');
  });
});

describe('API error mapping', () => {
  it.each([
    ['401', () => jsonResponse(401, API_WIRE.unauthorized.body), PermanentError, 'hubspot_unauthorized', undefined],
    ['403 MISSING_SCOPES', () => jsonResponse(403, API_WIRE.missingScopes.body), PermanentError, 'hubspot_missing_scopes', undefined],
    ['another 403', () => jsonResponse(403, { status: 'error', category: 'FORBIDDEN' }), PermanentError, 'hubspot_forbidden', undefined],
    ['404', () => jsonResponse(404, API_WIRE.notFound.body), PermanentError, 'hubspot_not_found', undefined],
    ['400', () => jsonResponse(400, API_WIRE.badRequest.body), PermanentError, 'hubspot_bad_request', undefined],
    ['414', () => textResponse(414, 'URI too long'), PermanentError, 'hubspot_bad_request', undefined],
    ['423', () => jsonResponse(423, API_WIRE.locked.body), TransientError, 'hubspot_locked', undefined],
    ['429 ten-secondly', () => jsonResponse(429, API_WIRE.tenSecondly.body), TransientError, 'hubspot_rate_limited', undefined],
    ['429 ten-secondly with Retry-After', () => jsonResponse(429, API_WIRE.tenSecondly.body, { 'Retry-After': '10' }), TransientError, 'hubspot_rate_limited', 10_000],
    ['429 search secondly', () => jsonResponse(429, { status: 'error', message: 'You have reached your secondly limit.', errorType: 'RATE_LIMIT' }), TransientError, 'hubspot_rate_limited', undefined],
    ['429 daily (no delay: defer to local midnight)', () => jsonResponse(429, API_WIRE.daily.body, { 'Retry-After': '10' }), TransientError, 'hubspot_daily_limit', undefined],
    ['477 with Retry-After', () => emptyResponse(477, { 'Retry-After': '86400' }), TransientError, 'hubspot_migration_in_progress', 86_400_000],
    ['477 with a date Retry-After', () => emptyResponse(477, { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }), TransientError, 'hubspot_migration_in_progress', undefined],
    ['500', () => textResponse(500, 'error'), TransientError, 'hubspot_server_error', undefined],
    ['503 with Retry-After', () => textResponse(503, 'down', { 'Retry-After': '30' }), TransientError, 'hubspot_server_error', 30_000],
    ['521', () => textResponse(521, 'down'), TransientError, 'hubspot_server_error', undefined],
    ['524', () => textResponse(524, 'timeout'), TransientError, 'hubspot_server_error', undefined],
    ['a 200 HTML page', () => textResponse(200, '<html></html>'), PermanentError, 'hubspot_invalid_response', undefined],
    ['an empty 200', () => emptyResponse(200), PermanentError, 'hubspot_invalid_response', undefined],
    ['a redirect (not followed)', () => emptyResponse(301, { Location: 'https://evil.example/' }), PermanentError, 'hubspot_invalid_response', undefined],
  ] as const)('%s', async (_name, respond, type, code, retryAfterMs) => {
    const { hubspot, requests } = client(respond);
    const error = await failure(hubspot.accountDetails(ACCESS_TOKEN));
    expect(error).toBeInstanceOf(type);
    expect(error.code).toBe(code);
    if (error instanceof TransientError) expect(error.retryAfterMs).toBe(retryAfterMs);
    expect(requests).toHaveLength(1);
  });

  it('carries the HTTP status', async () => {
    const { hubspot } = client(() => jsonResponse(403, API_WIRE.missingScopes.body));
    expect((await failure(hubspot.accountDetails(ACCESS_TOKEN))).httpStatus).toBe(403);
  });
});

describe('timeouts and aborts', () => {
  it('ends an already-aborted call before the network', async () => {
    const { hubspot, requests } = client(() => jsonResponse(200, {}));
    const error = await failure(hubspot.accountDetails(ACCESS_TOKEN, { signal: AbortSignal.abort() }));
    expect(error).toBeInstanceOf(TransientError);
    expect(error.code).toBe('hubspot_timeout');
    expect(error.httpStatus).toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it('ends a call the caller aborts in flight', async () => {
    const { hubspot, requests } = client(hangingResponder());
    const controller = new AbortController();
    const pending = failure(hubspot.refresh(REFRESH_TOKEN, { signal: controller.signal }));
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    controller.abort();
    const error = await pending;
    expect(error).toBeInstanceOf(TransientError);
    expect(error.code).toBe('hubspot_timeout');
  });

  it('ends a call at its own timeout', async () => {
    vi.useFakeTimers();
    const { hubspot, requests } = client(hangingResponder(), { timeoutMs: 8000 });
    const pending = failure(hubspot.listForms(ACCESS_TOKEN));
    await vi.advanceTimersByTimeAsync(7999);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const error = await pending;
    expect(error).toBeInstanceOf(TransientError);
    expect(error.code).toBe('hubspot_timeout');
  });

  it('clears its timer once the call ends', async () => {
    vi.useFakeTimers();
    const { hubspot } = client(() => jsonResponse(200, { total: 3, results: [] }));
    await hubspot.searchEmailsCount(ACCESS_TOKEN, { direction: 'outbound', since: new Date('2026-09-06T00:00:00Z') });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses a non-positive timeout', () => {
    expect(() => new HubSpotHttpClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, timeoutMs: 0 })).toThrow(ConfigError);
  });
});

describe('listForms', () => {
  const form = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: `Form ${id}`,
    formType: 'hubspot',
    archived: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    fieldGroups: [
      { groupType: 'default_group', fields: [{ name: 'email', label: 'Email', fieldType: 'email', objectTypeId: '0-1', required: true, hidden: false }] },
      { groupType: 'progressive', fields: [{ name: 'message', label: 'Message', fieldType: 'multi_line_text', objectTypeId: '0-1', required: false, hidden: true }] },
    ],
    configuration: { createNewContactForNewEmail: true, lifecycleStages: [{ objectTypeId: '0-1', value: 'lead' }] },
    displayOptions: { submitButtonText: 'Send' },
    legalConsentOptions: { type: 'none' },
    ...extra,
  });

  it('asks for hubspot and flow forms (repeated formTypes), live only, 100 per page, and follows paging', async () => {
    const pages: Record<string, unknown> = {
      '': { results: [form('f1')], paging: { next: { after: 'cursor-2', link: 'x' } } },
      'cursor-2': { results: [form('f2', { formType: 'flow' })] },
    };
    const { hubspot, requests } = client((request) => jsonResponse(200, pages[request.url.searchParams.get('after') ?? '']));
    const forms = await hubspot.listForms(ACCESS_TOKEN);
    expect(requests.map((r) => `${r.url.pathname}${r.url.search}`)).toEqual([
      '/marketing/v3/forms?formTypes=hubspot&formTypes=flow&archived=false&limit=100',
      '/marketing/v3/forms?formTypes=hubspot&formTypes=flow&archived=false&limit=100&after=cursor-2',
    ]);
    expect(forms.map((f) => [f.id, f.formType])).toEqual([
      ['f1', 'hubspot'],
      ['f2', 'flow'],
    ]);
    expect(forms[0]).toEqual({
      id: 'f1',
      name: 'Form f1',
      formType: 'hubspot',
      archived: false,
      fieldNames: ['email', 'message'],
      fields: [
        { name: 'email', fieldType: 'email', hidden: false, objectTypeId: '0-1' },
        { name: 'message', fieldType: 'multi_line_text', hidden: true, objectTypeId: '0-1' },
      ],
      lifecycleStages: ['lead'],
      hasSubscriptionConsent: false,
      submitButtonText: 'Send',
    });
  });

  it('detects subscription consent and keeps forms with undocumented shapes', async () => {
    const results = [
      form('consent', { legalConsentOptions: { type: 'explicit_consent_to_process', communicationsCheckboxes: [{ subscriptionTypeId: 1 }] } }),
      form('legit', { legalConsentOptions: { type: 'legitimate_interest', subscriptionTypeIds: [5] } }),
      { id: 'bare', name: 'Pop-up', formType: 'flow' },
    ];
    const { hubspot } = client(() => jsonResponse(200, { results }));
    const forms = await hubspot.listForms(ACCESS_TOKEN);
    expect(forms.map((f) => [f.id, f.hasSubscriptionConsent])).toEqual([
      ['consent', true],
      ['legit', true],
      ['bare', false],
    ]);
    expect(forms[2]).toMatchObject({ fields: [], fieldNames: [], lifecycleStages: [], submitButtonText: undefined });
  });

  it('drops captured and archived forms even if HubSpot returns them (D-07)', async () => {
    const results = [form('ok'), form('captured', { formType: 'captured' }), form('old', { archived: true }), form('blog', { formType: 'blog_comment' })];
    const { hubspot } = client(() => jsonResponse(200, { results }));
    expect((await hubspot.listForms(ACCESS_TOKEN)).map((f) => f.id)).toEqual(['ok']);
  });

  it('stops on a repeated cursor', async () => {
    const { hubspot, requests } = client(() => jsonResponse(200, { results: [], paging: { next: { after: 'same' } } }));
    expect((await failure(hubspot.listForms(ACCESS_TOKEN))).code).toBe('hubspot_invalid_response');
    expect(requests.length).toBeLessThanOrEqual(2);
  });
});

describe('listSubmissions', () => {
  const FORM = 'b1f0c6a2-3d4e-4f50-8a61-7b2c9d0e1f01';

  it('reads one page with limit and after, newest first, as HubSpot returns it', async () => {
    const body = {
      results: [
        {
          conversionId: 'c-2',
          submittedAt: 1790000002000,
          values: [
            { name: 'email', value: 'lead@example.org', objectTypeId: '0-1' },
            { name: 'message', value: 'Need a quote', objectTypeId: '0-1' },
          ],
          pageUrl: 'https://brightside-plumbing.example/contact',
        },
        { submittedAt: '1790000001000', values: [{ name: 'email', value: 'other@example.org' }] },
      ],
      paging: { next: { after: 'next-page', link: 'x' } },
    };
    const { hubspot, requests } = client(() => jsonResponse(200, body));
    const page = await hubspot.listSubmissions(ACCESS_TOKEN, FORM, { limit: 50, after: 'abc' });
    expect(`${requests[0]?.url.pathname}${requests[0]?.url.search}`).toBe(`/form-integrations/v1/submissions/forms/${FORM}?limit=50&after=abc`);
    expect(page).toEqual({
      results: [
        {
          conversionId: 'c-2',
          submittedAt: new Date(1790000002000),
          values: [
            { name: 'email', value: 'lead@example.org', objectTypeId: '0-1' },
            { name: 'message', value: 'Need a quote', objectTypeId: '0-1' },
          ],
          pageUrl: 'https://brightside-plumbing.example/contact',
        },
        { conversionId: undefined, submittedAt: new Date(1790000001000), values: [{ name: 'email', value: 'other@example.org', objectTypeId: undefined }], pageUrl: undefined },
      ],
      nextAfter: 'next-page',
    });
  });

  it('omits nextAfter on the last page', async () => {
    const { hubspot, requests } = client(() => jsonResponse(200, { results: [] }));
    await expect(hubspot.listSubmissions(ACCESS_TOKEN, FORM, { limit: 50 })).resolves.toEqual({ results: [] });
    expect(requests[0]?.url.search).toBe('?limit=50');
  });

  it.each([0, 51, 1.5, Number.NaN])('refuses limit %s before the network', async (limit) => {
    const { hubspot, requests } = client(() => jsonResponse(200, { results: [] }));
    const error = await failure(hubspot.listSubmissions(ACCESS_TOKEN, FORM, { limit }));
    expect(error).toBeInstanceOf(PermanentError);
    expect(error.code).toBe('hubspot_bad_request');
    expect(requests).toHaveLength(0);
  });

  it('maps an unknown form to hubspot_not_found', async () => {
    const { hubspot } = client(() => jsonResponse(404, API_WIRE.notFound.body));
    expect((await failure(hubspot.listSubmissions(ACCESS_TOKEN, FORM, { limit: 50 }))).code).toBe('hubspot_not_found');
  });

  it('refuses a form id that would leave its path segment', async () => {
    const { hubspot, requests } = client(() => jsonResponse(200, { results: [] }));
    const error = await failure(hubspot.listSubmissions(ACCESS_TOKEN, '../../../marketing/v3/forms', { limit: 50 }));
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.code).toBe('hubspot_request_not_allowed');
    expect(requests).toHaveLength(0);
  });
});

describe('getContact', () => {
  const STOP_PROPERTIES = [
    'email',
    'hs_additional_emails',
    'hs_email_optout',
    'hs_email_bad_address',
    'hs_email_hard_bounce_reason_enum',
    'hs_sales_email_last_replied',
  ] as const satisfies readonly HubSpotContactProperty[];

  it('reads one contact by id with only the listed properties and its email associations', async () => {
    const body = {
      id: '101',
      properties: { email: 'lead@example.org', hs_email_optout: 'false', hs_email_bad_address: null, hs_object_id: '101', createdate: 'x' },
      associations: {
        emails: {
          results: [
            { id: '501', type: 'contact_to_email' },
            { id: '502', type: 'contact_to_email' },
            { id: '501', type: 'contact_to_email_unlabeled' },
          ],
          paging: { next: { after: 'assoc-2', link: 'x' } },
        },
      },
      archived: false,
    };
    const { hubspot, requests } = client(() => jsonResponse(200, body));
    await expect(hubspot.getContact(ACCESS_TOKEN, '101', { properties: STOP_PROPERTIES, associations: ['emails'] })).resolves.toEqual({
      id: '101',
      properties: {
        email: 'lead@example.org',
        hs_additional_emails: null,
        hs_email_optout: 'false',
        hs_email_bad_address: null,
        hs_email_hard_bounce_reason_enum: null,
        hs_sales_email_last_replied: null,
      },
      associatedEmailIds: ['501', '502'],
      associationsNextAfter: 'assoc-2',
    });
    const url = requests[0]?.url;
    expect(url?.pathname).toBe('/crm/objects/2026-09/contacts/101');
    expect(url?.searchParams.get('properties')).toBe(STOP_PROPERTIES.join(','));
    expect(url?.searchParams.get('associations')).toBe('emails');
    expect(url?.searchParams.has('idProperty')).toBe(false);
  });

  it('reads a contact by email with idProperty=email', async () => {
    const { hubspot, requests } = client(() => jsonResponse(200, { id: 777, properties: { firstname: 'Jane', lastname: null } }));
    await expect(
      hubspot.getContact(ACCESS_TOKEN, 'jane+leads@example.org', { idProperty: 'email', properties: ['firstname', 'lastname', 'company', 'message', 'email'] }),
    ).resolves.toEqual({ id: '777', properties: { firstname: 'Jane', lastname: null, company: null, message: null, email: null } });
    expect(requests[0]?.url.pathname).toBe('/crm/objects/2026-09/contacts/jane%2Bleads%40example.org');
    expect(requests[0]?.url.search).toBe('?properties=firstname%2Clastname%2Ccompany%2Cmessage%2Cemail&idProperty=email');
  });

  it('returns null on 404 (deleted, or not visible yet)', async () => {
    const { hubspot } = client(() => jsonResponse(404, API_WIRE.notFound.body));
    await expect(hubspot.getContact(ACCESS_TOKEN, '101', { properties: ['email'] })).resolves.toBeNull();
  });

  it('returns the merged id unchanged so the caller can re-map (D-09)', async () => {
    const { hubspot } = client(() => jsonResponse(200, { id: '900', properties: { email: 'lead@example.org' } }));
    await expect(hubspot.getContact(ACCESS_TOKEN, '101', { properties: ['email'] })).resolves.toMatchObject({ id: '900' });
  });

  it('reports no associations when the contact has none', async () => {
    const { hubspot } = client(() => jsonResponse(200, { id: '101', properties: {} }));
    await expect(hubspot.getContact(ACCESS_TOKEN, '101', { properties: ['email'], associations: ['emails'] })).resolves.toEqual({
      id: '101',
      properties: { email: null },
      associatedEmailIds: [],
    });
  });

  it('still maps other errors', async () => {
    const { hubspot } = client(() => jsonResponse(401, API_WIRE.unauthorized.body));
    expect((await failure(hubspot.getContact(ACCESS_TOKEN, '101', { properties: ['email'] }))).code).toBe('hubspot_unauthorized');
  });

  it('refuses a property or association outside the allow-list before the network', async () => {
    const { hubspot, requests } = client(() => jsonResponse(200, { id: '101', properties: {} }));
    const contentProperty = ['email', 'notes_last_contacted'] as unknown as readonly HubSpotContactProperty[];
    expect(await failure(hubspot.getContact(ACCESS_TOKEN, '101', { properties: contentProperty }))).toBeInstanceOf(ConfigError);
    const deals = ['deals'] as unknown as readonly 'emails'[];
    expect(await failure(hubspot.getContact(ACCESS_TOKEN, '101', { properties: ['email'], associations: deals }))).toBeInstanceOf(ConfigError);
    expect(await failure(hubspot.getContact(ACCESS_TOKEN, '..', { properties: ['email'] }))).toBeInstanceOf(ConfigError);
    expect(requests).toHaveLength(0);
  });
});

describe('listContactEmailIds', () => {
  it('reads the dated associations endpoint, accepting numeric and string ids', async () => {
    const body = {
      results: [
        { toObjectId: 501, associationTypes: [{ category: 'HUBSPOT_DEFINED', typeId: 197, label: null }] },
        { toObjectId: '502', associationTypes: [] },
        { toObjectId: 501, associationTypes: [{ category: 'USER_DEFINED', typeId: 9, label: 'x' }] },
      ],
      paging: { next: { after: 'page-3' } },
    };
    const { hubspot, requests } = client(() => jsonResponse(200, body));
    await expect(hubspot.listContactEmailIds(ACCESS_TOKEN, '101', { after: 'assoc-2' })).resolves.toEqual({ ids: ['501', '502'], nextAfter: 'page-3' });
    expect(`${requests[0]?.url.pathname}${requests[0]?.url.search}`).toBe('/crm/objects/2026-09/contacts/101/associations/emails?after=assoc-2');
  });

  it('accepts {id} items and a last page', async () => {
    const { hubspot, requests } = client(() => jsonResponse(200, { results: [{ id: '601', type: 'contact_to_email' }] }));
    await expect(hubspot.listContactEmailIds(ACCESS_TOKEN, '101', {})).resolves.toEqual({ ids: ['601'] });
    expect(requests[0]?.url.search).toBe('');
  });

  it('maps a deleted contact to hubspot_not_found', async () => {
    const { hubspot } = client(() => jsonResponse(404, API_WIRE.notFound.body));
    expect((await failure(hubspot.listContactEmailIds(ACCESS_TOKEN, '101', {}))).code).toBe('hubspot_not_found');
  });
});

describe('batchReadEmails', () => {
  const ALL = ['hs_timestamp', 'hs_email_direction', 'hs_email_status', 'hs_email_from_email', 'hs_email_to_email'] as const satisfies readonly EmailMetadataProperty[];

  const emailRecord = (id: string, properties: Record<string, string | null>) => ({
    id,
    properties: { hs_object_id: id, hs_createdate: '2026-10-01T00:00:00Z', hs_lastmodifieddate: '2026-10-01T00:00:00Z', ...properties },
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    archived: false,
  });

  it('reads in chunks of 100 after removing duplicate ids, with metadata properties only', async () => {
    const ids = Array.from({ length: 250 }, (_v, i) => String(1000 + i));
    const { hubspot, requests } = client((request) => {
      const inputs = (jsonBody(request) as { inputs: { id: string }[] }).inputs;
      return jsonResponse(200, { status: 'COMPLETE', results: inputs.map(({ id }) => emailRecord(id, { hs_timestamp: '2026-10-06T14:13:00Z' })) });
    });
    const emails = await hubspot.batchReadEmails(ACCESS_TOKEN, [...ids, '1000', '1001'], ALL);
    expect(emails).toHaveLength(250);
    expect(requests.map((r) => (jsonBody(r) as { inputs: unknown[] }).inputs.length)).toEqual([100, 100, 50]);
    for (const request of requests) {
      expect(request.method).toBe('POST');
      expect(request.url.href).toBe(`${API}/crm/objects/2026-09/emails/batch/read`);
      expect(request.headers.get('content-type')).toBe('application/json');
      const body = jsonBody(request) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['inputs', 'properties', 'propertiesWithHistory']);
      expect(body.properties).toEqual([...ALL]);
      expect(body.propertiesWithHistory).toEqual([]);
    }
  });

  it('maps metadata: direction, status, lower-cased addresses, ISO or epoch-ms timestamps', async () => {
    const results = [
      emailRecord('1', {
        hs_timestamp: '2026-10-06T14:13:00Z',
        hs_email_direction: 'EMAIL',
        hs_email_status: 'SENT',
        hs_email_from_email: 'Owner@Brightside-Plumbing.example',
        hs_email_to_email: 'Lead@Example.org;  second@example.org ;',
      }),
      emailRecord('2', { hs_timestamp: '1791295980000', hs_email_direction: 'INCOMING_EMAIL', hs_email_status: null, hs_email_from_email: 'lead@example.org', hs_email_to_email: null }),
      emailRecord('3', { hs_timestamp: '2026-10-06T14:13:00Z', hs_email_direction: 'SOMETHING_NEW', hs_email_status: '' }),
      emailRecord('4', { hs_timestamp: null, hs_email_direction: 'EMAIL' }),
      emailRecord('5', { hs_timestamp: 'not a date' }),
    ];
    const { hubspot } = client(() => jsonResponse(207, { status: 'COMPLETE', results, numErrors: 1, errors: [{ status: 'error', category: 'OBJECT_NOT_FOUND' }] }));
    await expect(hubspot.batchReadEmails(ACCESS_TOKEN, ['1', '2', '3', '4', '5', '6'], ALL)).resolves.toEqual([
      {
        id: '1',
        timestamp: new Date('2026-10-06T14:13:00Z'),
        direction: 'EMAIL',
        status: 'SENT',
        fromEmail: 'owner@brightside-plumbing.example',
        toEmails: ['lead@example.org', 'second@example.org'],
      },
      { id: '2', timestamp: new Date(1791295980000), direction: 'INCOMING_EMAIL', fromEmail: 'lead@example.org', toEmails: [] },
      { id: '3', timestamp: new Date('2026-10-06T14:13:00Z'), direction: null, toEmails: [] },
    ]);
  });

  it('maps only the properties it asked for', async () => {
    const { hubspot, requests } = client(() =>
      jsonResponse(200, { results: [emailRecord('1', { hs_timestamp: '2026-10-06T14:13:00Z', hs_email_direction: 'EMAIL', hs_email_from_email: 'a@b.example' })] }),
    );
    await expect(hubspot.batchReadEmails(ACCESS_TOKEN, ['1'], ['hs_timestamp'])).resolves.toEqual([
      { id: '1', timestamp: new Date('2026-10-06T14:13:00Z'), direction: null, toEmails: [] },
    ]);
    expect((jsonBody(requests[0] ?? (undefined as never)) as { properties: unknown }).properties).toEqual(['hs_timestamp']);
  });

  it('makes no call for no ids, or without hs_timestamp (nothing could be kept)', async () => {
    const { hubspot, requests } = client(() => jsonResponse(200, { results: [] }));
    await expect(hubspot.batchReadEmails(ACCESS_TOKEN, [], ALL)).resolves.toEqual([]);
    await expect(hubspot.batchReadEmails(ACCESS_TOKEN, ['1'], ['hs_email_direction'])).resolves.toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it('maps a missing sales-email-read scope to hubspot_missing_scopes (D-03 path b)', async () => {
    const { hubspot } = client(() => jsonResponse(403, API_WIRE.missingScopes.body));
    expect((await failure(hubspot.batchReadEmails(ACCESS_TOKEN, ['1'], ALL))).code).toBe('hubspot_missing_scopes');
  });
});

describe('searchEmailsCount', () => {
  it('counts outbound emails since a time with limit 1 and reads total', async () => {
    const { hubspot, requests } = client(() => jsonResponse(200, { total: 4, results: [{ id: '1', properties: {} }], paging: { next: { after: '1' } } }));
    await expect(hubspot.searchEmailsCount(ACCESS_TOKEN, { direction: 'outbound', since: new Date(1788566400000) })).resolves.toBe(4);
    expect(requests[0]?.url.href).toBe(`${API}/crm/objects/2026-09/emails/search`);
    expect(jsonBody(requests[0] ?? (undefined as never))).toEqual({
      filterGroups: [
        {
          filters: [
            { propertyName: 'hs_timestamp', operator: 'GTE', value: '1788566400000' },
            { propertyName: 'hs_email_direction', operator: 'EQ', value: 'EMAIL' },
          ],
        },
      ],
      properties: ['hs_timestamp', 'hs_email_direction'],
      sorts: [{ propertyName: 'hs_timestamp', direction: 'DESCENDING' }],
      limit: 1,
      after: '0',
    });
  });

  it('counts inbound as INCOMING_EMAIL or FORWARDED_EMAIL', async () => {
    const { hubspot, requests } = client(() => jsonResponse(200, { total: 1, results: [] }));
    await expect(hubspot.searchEmailsCount(ACCESS_TOKEN, { direction: 'inbound', since: new Date(1788566400000) })).resolves.toBe(1);
    const body = jsonBody(requests[0] ?? (undefined as never)) as { filterGroups: { filters: unknown[] }[] };
    expect(body.filterGroups[0]?.filters[1]).toEqual({ propertyName: 'hs_email_direction', operator: 'IN', values: ['INCOMING_EMAIL', 'FORWARDED_EMAIL'] });
  });

  it('refuses an invalid date before the network', async () => {
    const { hubspot, requests } = client(() => jsonResponse(200, { total: 1 }));
    expect((await failure(hubspot.searchEmailsCount(ACCESS_TOKEN, { direction: 'inbound', since: new Date(Number.NaN) }))).code).toBe('hubspot_bad_request');
    expect(requests).toHaveLength(0);
  });

  it('refuses a body without total', async () => {
    const { hubspot } = client(() => jsonResponse(200, { results: [] }));
    expect((await failure(hubspot.searchEmailsCount(ACCESS_TOKEN, { direction: 'inbound', since: new Date(0) }))).code).toBe('hubspot_invalid_response');
  });
});

describe('uninstallApp', () => {
  it('sends DELETE to the dated uninstall endpoint with the bearer token', async () => {
    const { hubspot, requests } = client(() => emptyResponse(204));
    await expect(hubspot.uninstallApp(ACCESS_TOKEN)).resolves.toBeUndefined();
    expect(requests[0]?.method).toBe('DELETE');
    expect(requests[0]?.url.href).toBe(`${API}/appinstalls/2026-09/external-install`);
    expect(requests[0]?.headers.get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(requests[0]?.body).toBeUndefined();
  });

  it('maps failures like any API call', async () => {
    const { hubspot } = client(() => jsonResponse(401, API_WIRE.unauthorized.body));
    expect(errorCode(await failure(hubspot.uninstallApp(ACCESS_TOKEN)))).toBe('hubspot_unauthorized');
  });
});
