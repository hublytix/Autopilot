import { NextResponse, type NextRequest } from 'next/server';
import {
  buildCsp,
  generateNonce,
  INBOUND_CSP_HEADERS,
  NONCE_HEADER,
  SECURITY_HEADERS,
  sentryIngestOrigin,
} from '@/server/security/csp';
import type { RefreshedSession } from '@/server/ports/auth';

// The proxy (Next 16, Node runtime; PLAN §7.7, §10.7, NX-CSP-HEADERS):
// - every response it handles gets a fresh nonce CSP and the static security headers; inbound CSP
//   request headers are stripped first, so a client can never choose the policy (or the nonce)
//   Next renders with;
// - session refresh and the login redirect happen ONLY on the app areas: /dashboard, /onboarding
//   (except the email step, which works from the pending_install cookie), /admin and /api/billing.
//   Webhooks, jobs, cron, health, action links, /auth and /dev are never redirected;
// - it never touches the database: it imports only the CSP builder and the AuthProvider's
//   session-refresh adapters (live: @supabase/ssr refresh + getClaims; fake: the signed-cookie check);
// - refreshed cookies go both on the response (for the browser) and into this request's Cookie
//   header (so the page rendering now sees the fresh session, not the expired one).

type SessionRefresh = (request: Request, response: Response) => Promise<RefreshedSession>;

const SESSION_PATH = /^\/(?:dashboard|onboarding|admin|api\/billing)(?:\/|$)/;
const SESSION_EXEMPT = /^\/onboarding\/email(?:\/|$)/;
/** Pages showing personal data (D-49): never cached, never indexed. */
const PRIVATE_PATH = /^\/(?:dashboard|onboarding|admin|auth|login|a|dev|api\/billing|api\/onboarding)(?:\/|$)/;
const LOGIN_PATH = '/login';
/** Headers the AuthProvider may add next to auth cookies (no caching of a response that sets them). */
const PASSED_HEADERS = ['cache-control', 'expires', 'pragma'] as const;

/** Whether `pathname` gets the session refresh and the /login redirect. */
export function needsSession(pathname: string): boolean {
  return SESSION_PATH.test(pathname) && !SESSION_EXEMPT.test(pathname);
}

async function sessionRefresher(): Promise<SessionRefresh> {
  if (process.env.APP_MODE === 'live') return (await import('@/server/adapters/live/auth')).refreshLiveProxySession;
  return (await import('@/server/adapters/fake/auth/proxy-session')).checkFakeProxySession;
}

/**
 * Where the /login redirect points: APP_URL's origin, never one built from the request's Host or
 * X-Forwarded-Host (which a client may forge behind a proxy that passes them through). Next turns a
 * same-host Location into a relative one itself; it cannot take a relative one from the proxy. The
 * request's own origin is used only when APP_URL is unset (fake mode's default).
 */
function loginUrl(request: NextRequest): URL {
  const configured = process.env.APP_URL;
  if (configured !== undefined && configured !== '') {
    try {
      return new URL(LOGIN_PATH, new URL(configured).origin);
    } catch {
      // A malformed APP_URL fails the env check elsewhere; fall back to the request's origin here.
    }
  }
  return new URL(LOGIN_PATH, request.nextUrl.origin);
}

/**
 * name → value from the request's Cookie header, updated with the Set-Cookie values of `response`.
 * With a name listed twice (same name, another Path or Domain) the FIRST occurrence wins, as in
 * security/cookies parseCookieHeader (what the AuthProvider and the services read), so the page sees
 * the same session the refresh checked. Inlined: the proxy may import only the CSP builder and the
 * session-refresh adapters.
 */
function cookiesAfter(cookieHeader: string | null, response: Response): string | null {
  const jar = new Map<string, string>();
  for (const pair of (cookieHeader ?? '').split(';')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    if (name.length > 0 && !jar.has(name)) jar.set(name, pair.slice(eq + 1).trim());
  }
  for (const header of response.headers.getSetCookie()) {
    const [pair = '', ...attributes] = header.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const removed = value.length === 0 || attributes.some((attribute) => /^\s*max-age\s*=\s*0\s*$/i.test(attribute));
    if (removed) jar.delete(name);
    else jar.set(name, value);
  }
  if (jar.size === 0) return null;
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** Copies the refresh's cookies (and its no-cache headers) onto `target`. */
function carrySession(from: Response, target: Response): void {
  for (const value of from.headers.getSetCookie()) target.headers.append('set-cookie', value);
  for (const name of PASSED_HEADERS) {
    const value = from.headers.get(name);
    if (value !== null) target.headers.set(name, value);
  }
}

function secure(response: Response, csp: string, pathname: string): Response {
  response.headers.set('Content-Security-Policy', csp);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);
  if (PRIVATE_PATH.test(pathname)) {
    response.headers.set('Cache-Control', 'private, no-store');
    response.headers.set('X-Robots-Tag', 'noindex');
  }
  return response;
}

export async function proxy(request: NextRequest): Promise<Response> {
  const { pathname } = request.nextUrl;
  const requestHeaders = new Headers(request.headers);
  for (const name of INBOUND_CSP_HEADERS) requestHeaders.delete(name);
  const nonce = generateNonce();
  const csp = buildCsp({
    nonce,
    dev: process.env.NODE_ENV === 'development',
    sentryOrigin: sentryIngestOrigin(process.env.NEXT_PUBLIC_SENTRY_DSN),
  });
  // Next reads the nonce from the request's CSP header and puts it on its scripts; pages and route
  // handlers read it from x-nonce.
  requestHeaders.set('content-security-policy', csp);
  requestHeaders.set(NONCE_HEADER, nonce);

  if (!needsSession(pathname)) {
    return secure(NextResponse.next({ request: { headers: requestHeaders } }), csp, pathname);
  }

  let refreshed: RefreshedSession;
  try {
    refreshed = await (await sessionRefresher())(request, new Response(null));
  } catch {
    // No verifiable session (or no configuration to check one with): fail closed to /login.
    refreshed = { response: new Response(null), user: null };
  }
  if (refreshed.user === null) {
    const login = NextResponse.redirect(loginUrl(request), 303);
    carrySession(refreshed.response, login);
    return secure(login, csp, pathname);
  }
  const cookie = cookiesAfter(request.headers.get('cookie'), refreshed.response);
  if (cookie === null) requestHeaders.delete('cookie');
  else requestHeaders.set('cookie', cookie);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  carrySession(refreshed.response, response);
  return secure(response, csp, pathname);
}

export const config = {
  // Everything but Next's build assets and static files; prefetches are included, so their
  // responses also carry the policy and inbound CSP headers are always stripped.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)'],
};
