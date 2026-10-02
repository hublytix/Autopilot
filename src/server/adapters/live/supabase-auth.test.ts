import { describe, expect, it, vi } from 'vitest';
import { FakeClock } from '@/server/adapters/fake/clock';
import { isAppError } from '@/server/domain/errors';
import { toCookieHeader } from '@/server/security/cookies';
import { FAKE_SUPABASE_SECRET } from '../../../../test/support/fake-secrets';
import { SupabaseAuthProvider } from './supabase-auth';

// The live AuthProvider against a stubbed fetch (no network): admin calls carry the secret key,
// generateLink only mints a token, verify/refresh write the session cookies onto our response,
// getVerifiedUser never refreshes.

const URL_BASE = 'https://abcdefghijklmnop.supabase.co';
const COOKIE = 'sb-abcdefghijklmnop-auth-token';
const PUBLISHABLE = ['sb_', 'publishable_', 'TestOnlyKey0'].join('');
const USER_ID = '6a1b2c3d-0000-4000-8000-000000000001';
const EMAIL = 'owner@brightside-plumbing.example';
const FAR_FUTURE_S = 4_102_444_800; // 2100-01-01

/** An unsigned-looking HS256 JWT assembled at runtime (never a literal). */
function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return [part({ alg: 'HS256', typ: 'JWT' }), part({ aud: 'authenticated', role: 'authenticated', ...claims }), Buffer.from('test-signature').toString('base64url')].join('.');
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    access_token: jwt({ sub: USER_ID, email: EMAIL, exp: FAR_FUTURE_S }),
    refresh_token: 'refresh-fixture-1',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: FAR_FUTURE_S,
    user: { id: USER_ID, email: EMAIL, aud: 'authenticated', role: 'authenticated' },
    ...overrides,
  };
}

interface Call {
  method: string;
  path: string;
  search: string;
  headers: Headers;
  body: unknown;
}

type Route = (call: Call) => Response;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-supabase-api-version': '2024-01-01' } });
}

function stub(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
    const call: Call = { method: request.method, path: url.pathname, search: url.search, headers: request.headers, body: text === '' ? null : JSON.parse(text) };
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`];
    if (route === undefined) return json(404, { code: 'not_found', message: 'no stub' });
    return route(call);
  });
  return { calls, fetch: fetchStub as unknown as typeof fetch };
}

function provider(routes: Record<string, Route>, clock = new FakeClock(new Date('2026-10-06T14:00:00.000Z'))) {
  const net = stub(routes);
  const auth = new SupabaseAuthProvider({ url: URL_BASE, publishableKey: PUBLISHABLE, secretKey: FAKE_SUPABASE_SECRET, clock, fetch: net.fetch });
  return { auth, ...net, clock };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return error.code;
    throw error;
  }
  throw new Error('expected an error');
}

describe('SupabaseAuthProvider admin calls', () => {
  it('creates an unconfirmed user with the secret key', async () => {
    const { auth, calls } = provider({ 'POST /auth/v1/admin/users': () => json(200, { id: USER_ID, email: EMAIL }) });
    expect(await auth.createUser(' Owner@Brightside-Plumbing.example ')).toEqual({ userId: USER_ID });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ email: EMAIL, email_confirm: false });
    expect(calls[0]?.headers.get('apikey')).toBe(FAKE_SUPABASE_SECRET);
  });

  it('maps an existing email to PermanentError auth_user_exists', async () => {
    const { auth } = provider({ 'POST /auth/v1/admin/users': () => json(422, { code: 'email_exists', message: 'A user with this email address has already been registered' }) });
    expect(await codeOf(auth.createUser(EMAIL))).toBe('auth_user_exists');
  });

  it('maps 429 and 5xx to transient errors, and an unauthorised key to a config error', async () => {
    expect(await codeOf(provider({ 'POST /auth/v1/admin/users': () => json(429, { code: 'over_request_rate_limit' }) }).auth.createUser(EMAIL))).toBe('auth_rate_limited');
    expect(await codeOf(provider({ 'POST /auth/v1/admin/users': () => json(503, { message: 'down' }) }).auth.createUser(EMAIL))).toBe('auth_unavailable');
    expect(await codeOf(provider({ 'POST /auth/v1/admin/users': () => json(401, { code: 'no_authorization' }) }).auth.createUser(EMAIL))).toBe('auth_config');
  });

  it('generateLink mints a magic-link token and calls nothing that sends email', async () => {
    const { auth, calls } = provider({
      'POST /auth/v1/admin/generate_link': () =>
        json(200, {
          id: USER_ID,
          email: EMAIL,
          action_link: `${URL_BASE}/auth/v1/verify?token=x&type=magiclink`,
          email_otp: '123456',
          hashed_token: 'a'.repeat(56),
          redirect_to: 'http://localhost:3000',
          verification_type: 'magiclink',
        }),
    });
    expect(await auth.generateLink(EMAIL)).toEqual({ hashedToken: 'a'.repeat(56), userId: USER_ID });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /auth/v1/admin/generate_link']);
    expect(calls[0]?.body).toMatchObject({ type: 'magiclink', email: EMAIL });
  });

  it('treats deleting a user that is already gone as success', async () => {
    const { auth } = provider({ [`DELETE /auth/v1/admin/users/${USER_ID}`]: () => json(404, { code: 'user_not_found' }) });
    await expect(auth.deleteUser(USER_ID)).resolves.toBeUndefined();
  });

  it('finds a user by email across pages, case-insensitively', async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, email: `user${i}@example.com` }));
    const { auth } = provider({
      'GET /auth/v1/admin/users': (call) =>
        call.search.includes('page=1&')
          ? json(200, { users: page(1000) })
          : json(200, { users: [{ id: USER_ID, email: 'OWNER@brightside-plumbing.example' }] }),
    });
    expect(await auth.findUserByEmail(EMAIL)).toEqual({ userId: USER_ID });
    const { auth: empty } = provider({ 'GET /auth/v1/admin/users': () => json(200, { users: [] }) });
    expect(await empty.findUserByEmail(EMAIL)).toBeNull();
  });
});

describe('SupabaseAuthProvider sessions', () => {
  it('verify: verifyOtp with the token hash, and the session cookies come back for our response', async () => {
    const { auth, calls } = provider({ 'POST /auth/v1/verify': () => json(200, session()) });
    const verified = await auth.verify('b'.repeat(56), 'email');
    expect(calls[0]?.body).toMatchObject({ token_hash: 'b'.repeat(56), type: 'email' });
    expect(verified).toMatchObject({ userId: USER_ID, email: EMAIL });
    const cookie = verified?.cookies.find((c) => c.name === COOKIE);
    expect(cookie?.value.startsWith('base64-')).toBe(true);
    expect(cookie?.options).toMatchObject({ path: '/', httpOnly: true, secure: true, sameSite: 'lax' });
  });

  it('verify: an expired or used token is no session, an outage is transient', async () => {
    const expired = provider({ 'POST /auth/v1/verify': () => json(403, { code: 'otp_expired', message: 'Token has expired or is invalid' }) });
    expect(await expired.auth.verify('b'.repeat(56), 'email')).toBeNull();
    const down = provider({ 'POST /auth/v1/verify': () => json(502, { message: 'bad gateway' }) });
    expect(await codeOf(down.auth.verify('b'.repeat(56), 'email'))).toBe('auth_unavailable');
  });

  it('getVerifiedUser verifies the stored access token and never refreshes', async () => {
    const { auth: verifier } = provider({ 'POST /auth/v1/verify': () => json(200, session()) });
    const cookies = (await verifier.verify('b'.repeat(56), 'email'))?.cookies ?? [];
    const { auth, calls } = provider({ 'GET /auth/v1/user': () => json(200, { id: USER_ID, email: EMAIL }) });
    const request = new Request('https://app.example/dashboard', { headers: { cookie: toCookieHeader(cookies) } });
    expect(await auth.getVerifiedUser(request)).toEqual({ userId: USER_ID, email: EMAIL });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /auth/v1/user']);
    expect(calls[0]?.headers.get('authorization')).toMatch(/^Bearer ey/);
  });

  it('getVerifiedUser: no cookie, an expired session or a rejected token is no user', async () => {
    const { auth, calls } = provider({ 'GET /auth/v1/user': () => json(403, { code: 'bad_jwt' }) });
    expect(await auth.getVerifiedUser(new Request('https://app.example/'))).toBeNull();
    const expired = Buffer.from(JSON.stringify(session({ expires_at: 1_000 }))).toString('base64url');
    expect(await auth.getVerifiedUser(new Request('https://app.example/', { headers: { cookie: `${COOKIE}=base64-${expired}` } }))).toBeNull();
    expect(calls).toHaveLength(0);
    const fresh = Buffer.from(JSON.stringify(session())).toString('base64url');
    expect(await auth.getVerifiedUser(new Request('https://app.example/', { headers: { cookie: `${COOKIE}=base64-${fresh}` } }))).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('refreshSession: cookies set during a refresh reach the response, with no-cache headers', async () => {
    const refreshed = session({ access_token: jwt({ sub: USER_ID, email: EMAIL, exp: FAR_FUTURE_S, n: 2 }), refresh_token: 'refresh-fixture-2' });
    const { auth, calls } = provider({
      'POST /auth/v1/token': () => json(200, refreshed),
      'GET /auth/v1/user': () => json(200, { id: USER_ID, email: EMAIL }),
    });
    const stale = Buffer.from(JSON.stringify(session({ expires_at: 1_000 }))).toString('base64url');
    const request = new Request('https://app.example/dashboard', { headers: { cookie: `${COOKIE}=base64-${stale}; other=1` } });
    const result = await auth.refreshSession(request, new Response(null));
    expect(calls.map((c) => `${c.method} ${c.path}${c.search}`)).toEqual(['POST /auth/v1/token?grant_type=refresh_token', 'GET /auth/v1/user']);
    expect(calls[0]?.body).toEqual({ refresh_token: 'refresh-fixture-1' });
    expect(result.user).toEqual({ userId: USER_ID, email: EMAIL });
    const setCookies = result.response.headers.getSetCookie();
    const written = setCookies.find((c) => c.startsWith(`${COOKIE}=base64-`)) ?? '';
    expect(written).toMatch(/HttpOnly/);
    expect(written).toMatch(/SameSite=Lax/);
    const stored = JSON.parse(Buffer.from(written.slice(`${COOKIE}=base64-`.length).split(';')[0] ?? '', 'base64url').toString('utf8')) as { refresh_token: string };
    expect(stored.refresh_token).toBe('refresh-fixture-2');
    expect(result.response.headers.get('cache-control')).toContain('no-store');
  });

  it('refreshSession: a fresh session passes through untouched; none means no user', async () => {
    const { auth } = provider({ 'GET /auth/v1/user': () => json(200, { id: USER_ID, email: EMAIL }) });
    const fresh = Buffer.from(JSON.stringify(session())).toString('base64url');
    const result = await auth.refreshSession(new Request('https://app.example/', { headers: { cookie: `${COOKIE}=base64-${fresh}` } }), new Response(null));
    expect(result.user).toEqual({ userId: USER_ID, email: EMAIL });
    expect(result.response.headers.getSetCookie()).toEqual([]);
    const none = await auth.refreshSession(new Request('https://app.example/'), new Response(null));
    expect(none.user).toBeNull();
  });

  it('signOut revokes the session and clears every chunk of its cookie', async () => {
    const { auth, calls } = provider({ 'POST /auth/v1/logout': () => new Response(null, { status: 204 }) });
    const fresh = Buffer.from(JSON.stringify(session())).toString('base64url');
    const cleared = await auth.signOut(new Request('https://app.example/', { headers: { cookie: `${COOKIE}.0=base64-${fresh.slice(0, 10)}; ${COOKIE}.1=${fresh.slice(10)}; other=1` } }));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toContain('POST /auth/v1/logout');
    expect(cleared.map((c) => c.name).sort()).toEqual([`${COOKIE}.0`, `${COOKIE}.1`]);
    for (const cookie of cleared) expect(cookie.options.maxAge).toBe(0);
  });
});
