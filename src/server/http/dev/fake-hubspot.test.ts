import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CookieJar } from '@/server/security/cookies';
import { createJobRegistry } from '@/server/jobs/registry';
import { createJobTestRig, type JobTestRig } from '@/server/jobs/testing';
import { REQUIRED_SCOPES } from '@/server/hubspot/scopes';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import { handleHubSpotCallback } from '../hubspot-callback';
import { handleHubSpotInstall } from '../hubspot-install';
import {
  buildConsentView,
  FAKE_HUBSPOT_AUTHORIZE_PATH,
  FAKE_HUBSPOT_DECISION_PATH,
  handleFakeHubSpotDecision,
  handleFakeHubSpotDecisionOtherMethod,
  type SearchParamsRecord,
} from './fake-hubspot';
import { devToolsEnabled, getDevContext, type DevContext } from './guard';
import { isSameOriginRequest } from './same-origin';

const getDb = setUpTestDb();

let rig: JobTestRig;
let ctx: DevContext;

beforeEach(() => {
  rig = createJobTestRig(getDb(), createJobRegistry());
  ctx = { env: rig.deps.env, fakes: rig.fakes };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const url = (path: string): string => `${rig.deps.env.APP_URL}${path}`;

/** The query of the fake's authorize URL, as Next hands it to the page. */
function authorizeParams(overrides: Record<string, string | null> = {}): SearchParamsRecord {
  const authorize = new URL(
    rig.deps.hubspot.authorizeUrl({ state: 'state-nonce-1', redirectUri: rig.deps.env.HUBSPOT_REDIRECT_URI, scopes: REQUIRED_SCOPES }),
  );
  const params: Record<string, string> = Object.fromEntries(authorize.searchParams);
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) delete params[name];
    else params[name] = value;
  }
  return params;
}

function decisionRequest(fields: Record<string, string>, headers: Record<string, string> = { Origin: rig.deps.env.APP_URL }): Request {
  return new Request(url(FAKE_HUBSPOT_DECISION_PATH), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

function approveFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    client_id: rig.deps.env.HUBSPOT_CLIENT_ID,
    redirect_uri: rig.deps.env.HUBSPOT_REDIRECT_URI,
    state: 'state-nonce-1',
    scope: REQUIRED_SCOPES.join(' '),
    decision: 'approve',
    ...overrides,
  };
}

describe('/dev outside fake mode', () => {
  it('the consent page and the decision route are 404s', async () => {
    expect(buildConsentView(authorizeParams(), null)).toEqual({ kind: 'not_found' });
    const post = await handleFakeHubSpotDecision(decisionRequest(approveFields()), null);
    expect(post.status).toBe(404);
    expect(post.headers.get('location')).toBeNull();
    expect(handleFakeHubSpotDecisionOtherMethod(null).status).toBe(404);
  });

  it('devToolsEnabled is true only for APP_MODE=fake, and fails closed on an invalid environment', async () => {
    vi.stubEnv('APP_MODE', 'fake');
    expect(devToolsEnabled()).toBe(true);
    vi.stubEnv('APP_MODE', 'live');
    expect(devToolsEnabled()).toBe(false);
    await expect(getDevContext()).resolves.toBeNull();
    vi.stubEnv('APP_MODE', 'staging');
    expect(devToolsEnabled()).toBe(false);
  });
});

describe('GET /dev/fake-hubspot/authorize', () => {
  it('shows the requested scopes for the configured app', () => {
    expect(FAKE_HUBSPOT_AUTHORIZE_PATH).toBe(new URL(rig.deps.hubspot.authorizeUrl({ state: 's', redirectUri: 'r', scopes: [] })).pathname);
    const view = buildConsentView(authorizeParams(), ctx);
    expect(view).toEqual({
      kind: 'consent',
      request: {
        clientId: rig.deps.env.HUBSPOT_CLIENT_ID,
        redirectUri: rig.deps.env.HUBSPOT_REDIRECT_URI,
        state: 'state-nonce-1',
        scopes: [...REQUIRED_SCOPES],
        optionalScopes: [],
      },
      portal: { portalId: '1234567', hubDomain: rig.fakes.hubspot.portal.hubDomain, accountType: rig.fakes.hubspot.portal.accountType },
      decisionPath: FAKE_HUBSPOT_DECISION_PATH,
    });
  });

  it.each<[string, Record<string, string | null>, string]>([
    ['an unknown client id', { client_id: 'someone-else' }, 'client_id'],
    ['another redirect URI', { redirect_uri: 'https://evil.example/callback' }, 'redirect_uri'],
    ['no state', { state: null }, 'state'],
    ['a state with spaces', { state: 'a b' }, 'state'],
    ['no scopes', { scope: '' }, 'scope'],
    ['a malformed scope', { scope: 'oauth <script>' }, 'scope'],
  ])('refuses %s', (_label, overrides, reason) => {
    expect(buildConsentView(authorizeParams(overrides), ctx)).toEqual({ kind: 'invalid', reason });
  });

  it('refuses a repeated parameter', () => {
    expect(buildConsentView({ ...authorizeParams(), state: ['a', 'b'] }, ctx)).toEqual({ kind: 'invalid', reason: 'state' });
  });
});

describe('POST /dev/fake-hubspot/authorize/decision', () => {
  it('Approve redirects to the redirect URI with a working single-use code and the same state', async () => {
    const res = await handleFakeHubSpotDecision(decisionRequest(approveFields()), ctx);
    expect(res.status).toBe(303);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');

    const location = new URL(res.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(rig.deps.env.HUBSPOT_REDIRECT_URI);
    expect(location.searchParams.get('state')).toBe('state-nonce-1');
    const code = location.searchParams.get('code') ?? '';
    await expect(rig.deps.hubspot.exchangeCode(code, rig.deps.env.HUBSPOT_REDIRECT_URI)).resolves.toMatchObject({ refreshToken: expect.any(String) });
    await expect(rig.deps.hubspot.exchangeCode(code, rig.deps.env.HUBSPOT_REDIRECT_URI)).rejects.toThrow('hubspot_bad_auth_code');
  });

  it('Cancel redirects with error=access_denied and the state, minting no code', async () => {
    const res = await handleFakeHubSpotDecision(decisionRequest(approveFields({ decision: 'deny' })), ctx);
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('state-nonce-1');
    expect(location.searchParams.has('code')).toBe(false);
    expect(rig.fakes.hubspot.snapshot().oauth.authCodes).toEqual([]);
  });

  it.each<[string, Record<string, string>]>([
    ['a cross-site Origin', { Origin: 'https://evil.example' }],
    ['an Origin on another port', { Origin: 'http://localhost:3001' }],
    ['Sec-Fetch-Site cross-site', { 'Sec-Fetch-Site': 'cross-site' }],
    ['neither Origin nor Sec-Fetch-Site', {}],
  ])('refuses %s with 403', async (_label, headers) => {
    const res = await handleFakeHubSpotDecision(decisionRequest(approveFields(), headers), ctx);
    expect(res.status).toBe(403);
    expect(rig.fakes.hubspot.snapshot().oauth.authCodes).toEqual([]);
  });

  it('accepts Sec-Fetch-Site same-origin without an Origin header', async () => {
    const res = await handleFakeHubSpotDecision(decisionRequest(approveFields(), { 'Sec-Fetch-Site': 'same-origin' }), ctx);
    expect(res.status).toBe(303);
  });

  it.each<[string, Record<string, string>]>([
    ['another redirect URI (no open redirect)', { redirect_uri: 'https://evil.example/callback' }],
    ['an unknown client id', { client_id: 'someone-else' }],
    ['no decision', { decision: '' }],
    ['an unknown decision', { decision: 'maybe' }],
    ['a bad state', { state: '' }],
  ])('answers 400 to %s', async (_label, overrides) => {
    const res = await handleFakeHubSpotDecision(decisionRequest(approveFields(overrides)), ctx);
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('answers 400 to a repeated field and to a body that is not a form', async () => {
    const repeated = new Request(url(FAKE_HUBSPOT_DECISION_PATH), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: rig.deps.env.APP_URL },
      body: `${new URLSearchParams(approveFields()).toString()}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}`,
    });
    expect((await handleFakeHubSpotDecision(repeated, ctx)).status).toBe(400);
    const json = new Request(url(FAKE_HUBSPOT_DECISION_PATH), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: rig.deps.env.APP_URL },
      body: JSON.stringify(approveFields()),
    });
    expect((await handleFakeHubSpotDecision(json, ctx)).status).toBe(400);
  });

  it('answers 405 to other methods in fake mode', async () => {
    expect(handleFakeHubSpotDecisionOtherMethod(ctx).status).toBe(405);
    const get = await handleFakeHubSpotDecision(new Request(url(FAKE_HUBSPOT_DECISION_PATH)), ctx);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
  });

  it('completes a real install: install → consent → Approve → callback (branch a)', async () => {
    const jar = new CookieJar();
    const started = await handleHubSpotInstall(jar.request(url('/api/hubspot/install'), { headers: { 'x-real-ip': '203.0.113.7' } }), rig.deps);
    jar.storeFrom(started);
    const consentUrl = new URL(started.headers.get('location') ?? '');
    expect(consentUrl.pathname).toBe(FAKE_HUBSPOT_AUTHORIZE_PATH);

    const view = buildConsentView(Object.fromEntries(consentUrl.searchParams), ctx);
    if (view.kind !== 'consent') throw new Error(`consent view: ${view.kind}`);
    const approved = await handleFakeHubSpotDecision(
      decisionRequest({
        client_id: view.request.clientId,
        redirect_uri: view.request.redirectUri,
        state: view.request.state,
        scope: view.request.scopes.join(' '),
        decision: 'approve',
      }),
      ctx,
    );
    const callback = await handleHubSpotCallback(jar.request(approved.headers.get('location') ?? ''), rig.deps);
    expect(callback.status).toBe(303);
    expect(new URL(callback.headers.get('location') ?? '').pathname).toBe('/onboarding/email');
    expect(await getDb().query('select portal_id, status from hubspot_connections')).toEqual([{ portal_id: '1234567', status: 'active' }]);
  });
});

describe('isSameOriginRequest', () => {
  const appUrl = 'http://localhost:3000';
  const req = (headers: Record<string, string>): Request => new Request(`${appUrl}/x`, { method: 'POST', headers });

  it('compares Origin with the APP_URL origin, else requires Sec-Fetch-Site same-origin', () => {
    expect(isSameOriginRequest(req({ Origin: 'http://localhost:3000' }), appUrl)).toBe(true);
    expect(isSameOriginRequest(req({ Origin: 'null' }), appUrl)).toBe(false);
    expect(isSameOriginRequest(req({ Origin: 'https://localhost:3000' }), appUrl)).toBe(false);
    // An Origin that disagrees wins over a same-origin Sec-Fetch-Site.
    expect(isSameOriginRequest(req({ Origin: 'https://evil.example', 'Sec-Fetch-Site': 'same-origin' }), appUrl)).toBe(false);
    expect(isSameOriginRequest(req({ 'Sec-Fetch-Site': 'same-origin' }), appUrl)).toBe(true);
    expect(isSameOriginRequest(req({ 'Sec-Fetch-Site': 'same-site' }), appUrl)).toBe(false);
    expect(isSameOriginRequest(req({}), appUrl)).toBe(false);
  });
});
