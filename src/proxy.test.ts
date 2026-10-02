import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefreshedSession } from '@/server/ports/auth';

// src/proxy.ts per path class (PLAN §7.7): CSP + security headers everywhere, inbound CSP request
// headers stripped, session refresh and the /login redirect only on the app areas, and refreshed
// cookies propagated to both the response and this request. The two refresh adapters are mocked:
// their own tests cover them (fake: proxy-session.test.ts; live: supabase-auth.test.ts).

type Refresh = (request: Request, response: Response) => Promise<RefreshedSession>;

const fakeRefresh = vi.fn<Refresh>();
const liveRefresh = vi.fn<Refresh>();

vi.mock('@/server/adapters/fake/auth/proxy-session', () => ({ checkFakeProxySession: fakeRefresh }));
vi.mock('@/server/adapters/live/auth', () => ({ refreshLiveProxySession: liveRefresh }));

const { proxy, needsSession, config } = await import('./proxy');

const ORIGIN = 'http://localhost:3000';
const USER = { userId: 'u-1', email: 'owner@example.com' };

function request(path: string, init: { method?: string; headers?: Record<string, string> } = {}): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, { method: init.method ?? 'GET', headers: init.headers ?? {} });
}

function signedIn(): void {
  fakeRefresh.mockImplementation(async (_req, res) => ({ response: res, user: USER }));
}

function signedOut(): void {
  fakeRefresh.mockImplementation(async (_req, res) => ({ response: res, user: null }));
}

/** The request headers the proxy hands on to the page (NextResponse.next({request})). */
function forwarded(res: Response, name: string): string | null {
  return res.headers.get(`x-middleware-request-${name}`);
}

beforeEach(() => {
  fakeRefresh.mockReset();
  liveRefresh.mockReset();
  vi.stubEnv('APP_MODE', 'fake');
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('every response', () => {
  it.each(['/', '/login', '/auth/confirm', '/dashboard', '/a/token/send', '/api/health'])('gets a fresh nonce CSP and the security headers on %s', async (path) => {
    signedIn();
    const res = await proxy(request(path));
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get('strict-transport-security')).toMatch(/^max-age=/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect(res.headers.get('permissions-policy')).toContain('camera=()');
  });

  it('strips inbound CSP request headers and forwards its own policy and nonce to the page', async () => {
    const res = await proxy(
      request('/', {
        headers: {
          'content-security-policy': "script-src 'nonce-attacker'",
          'content-security-policy-report-only': "script-src 'nonce-attacker'",
          'x-nonce': 'attacker',
        },
      }),
    );
    const csp = res.headers.get('content-security-policy') ?? '';
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1] ?? '';
    expect(forwarded(res, 'content-security-policy')).toBe(csp);
    expect(forwarded(res, 'x-nonce')).toBe(nonce);
    expect(forwarded(res, 'content-security-policy-report-only')).toBeNull();
    expect(csp).not.toContain('attacker');
  });

  it('uses a new nonce per request', async () => {
    const a = (await proxy(request('/'))).headers.get('content-security-policy');
    const b = (await proxy(request('/'))).headers.get('content-security-policy');
    expect(a).not.toBe(b);
  });

  it("allows 'unsafe-eval' only in development, and connects to the Sentry ingest origin when configured", async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://publickey@o9.ingest.us.sentry.io/12');
    const csp = (await proxy(request('/'))).headers.get('content-security-policy') ?? '';
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("connect-src 'self' https://o9.ingest.us.sentry.io");
  });

  it('marks personal-data pages private and noindex', async () => {
    signedIn();
    for (const path of ['/dashboard', '/onboarding/email', '/login', '/auth/confirm', '/a/token/send', '/admin']) {
      const res = await proxy(request(path));
      expect(res.headers.get('cache-control'), path).toBe('private, no-store');
      expect(res.headers.get('x-robots-tag'), path).toBe('noindex');
    }
    expect((await proxy(request('/'))).headers.get('x-robots-tag')).toBeNull();
  });
});

describe('session refresh scope', () => {
  it.each(['/dashboard', '/dashboard/leads/42', '/onboarding', '/onboarding/brief', '/onboarding/forms', '/admin', '/admin/accounts', '/api/billing/checkout'])(
    'refreshes and redirects to /login without a session on %s',
    async (path) => {
      signedOut();
      const res = await proxy(request(path, { method: path.startsWith('/api/') ? 'POST' : 'GET' }));
      expect(fakeRefresh).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`${ORIGIN}/login`);
      expect(res.headers.get('content-security-policy')).not.toBeNull();
    },
  );

  it.each(['/dashboard', '/onboarding/brief', '/admin', '/api/billing/resume'])('lets a signed-in request through on %s', async (path) => {
    signedIn();
    const res = await proxy(request(path));
    expect(fakeRefresh).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it.each([
    '/onboarding/email',
    '/api/hubspot/webhooks',
    '/api/hubspot/install',
    '/api/hubspot/oauth/callback',
    '/api/razorpay/webhook',
    '/api/jobs/run',
    '/api/jobs/failed',
    '/api/cron/poll',
    '/api/health',
    '/a/token/send',
    '/auth/confirm',
    '/auth/signout',
    '/dev',
    '/dev/fake-hubspot/authorize',
    '/login',
    '/',
    '/dashboards',
    '/administrator',
  ])('never refreshes or redirects %s', async (path) => {
    signedOut();
    const res = await proxy(request(path, { method: 'POST' }));
    expect(fakeRefresh).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(needsSession(path)).toBe(false);
  });

  it('fails closed to /login when the session check throws', async () => {
    fakeRefresh.mockRejectedValue(new Error('env_invalid'));
    const res = await proxy(request('/dashboard'));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/login`);
  });

  it('builds the /login redirect from APP_URL, never from a forged Host or X-Forwarded-Host', async () => {
    vi.stubEnv('APP_URL', 'https://app.autopilot.example');
    signedOut();
    const forged = new NextRequest('https://evil.example/dashboard', { headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' } });
    const res = await proxy(forged);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://app.autopilot.example/login');
  });

  it('uses the live adapter in live mode and the fake one otherwise', async () => {
    vi.stubEnv('APP_MODE', 'live');
    liveRefresh.mockImplementation(async (_req, res) => ({ response: res, user: USER }));
    await proxy(request('/dashboard'));
    expect(liveRefresh).toHaveBeenCalledTimes(1);
    expect(fakeRefresh).not.toHaveBeenCalled();
  });

  it('runs on every page path, not only the app areas (the CSP must reach every HTML response)', () => {
    const [matcher] = config.matcher;
    const pattern = new RegExp(`^${(matcher ?? '').replace('/((?!', '/(?!').replace(').*)', ').*')}$`);
    for (const path of ['/', '/login', '/auth/confirm', '/a/x/send', '/dashboard']) expect(pattern.test(path), path).toBe(true);
    for (const path of ['/_next/static/chunk.js', '/_next/image', '/favicon.ico']) expect(pattern.test(path), path).toBe(false);
  });
});

describe('cookie propagation', () => {
  it("puts refreshed cookies on the response and into this request's Cookie header", async () => {
    fakeRefresh.mockImplementation(async (_req, res) => {
      res.headers.append('set-cookie', 'sb-ref-auth-token=base64-NEW; Path=/; HttpOnly; SameSite=Lax; Secure');
      res.headers.append('set-cookie', 'sb-ref-auth-token.1=; Path=/; Max-Age=0');
      res.headers.set('cache-control', 'private, no-cache, no-store, must-revalidate, max-age=0');
      return { response: res, user: USER };
    });
    const res = await proxy(request('/dashboard', { headers: { cookie: 'sb-ref-auth-token=base64-OLD; sb-ref-auth-token.1=tail; theme=dark' } }));
    expect(res.headers.getSetCookie()).toEqual([
      'sb-ref-auth-token=base64-NEW; Path=/; HttpOnly; SameSite=Lax; Secure',
      'sb-ref-auth-token.1=; Path=/; Max-Age=0',
    ]);
    expect(forwarded(res, 'cookie')).toBe('sb-ref-auth-token=base64-NEW; theme=dark');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('carries cookie removals onto the /login redirect', async () => {
    fakeRefresh.mockImplementation(async (_req, res) => {
      res.headers.append('set-cookie', 'ap_session=; Path=/; Max-Age=0');
      return { response: res, user: null };
    });
    const res = await proxy(request('/dashboard', { headers: { cookie: 'ap_session=expired.value' } }));
    expect(res.status).toBe(303);
    expect(res.headers.getSetCookie()).toEqual(['ap_session=; Path=/; Max-Age=0']);
  });

  it('keeps the first of two same-named cookies, as the services read them', async () => {
    fakeRefresh.mockImplementation(async (_req, res) => {
      res.headers.append('set-cookie', 'theme=light; Path=/');
      return { response: res, user: USER };
    });
    const res = await proxy(request('/dashboard', { headers: { cookie: 'ap_session=first.sig; ap_session=second.sig; theme=dark' } }));
    expect(forwarded(res, 'cookie')).toBe('ap_session=first.sig; theme=light');
  });

  it('leaves the request cookies alone when nothing was refreshed', async () => {
    signedIn();
    const res = await proxy(request('/dashboard', { headers: { cookie: 'ap_session=v.sig' } }));
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(forwarded(res, 'cookie')).toBe('ap_session=v.sig');
  });
});
