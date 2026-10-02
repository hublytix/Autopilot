import 'server-only';
// The cookie helpers live with the fake AuthProvider but are written for the HTTP layer too.
import { withSetCookies } from '@/server/adapters/fake/auth/cookies';
import { errorCode } from '@/server/domain/errors';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { startInstall } from '@/server/services/install/start';

// GET /api/hubspot/install (PLAN §7.3): rate-limited (20/min per IP), sets the signed `state` cookie
// and redirects to HubSpot's consent screen with exactly REQUIRED_SCOPES. Never cached.

/** Where install failures land (with the permission note). */
export const INSTALL_FAILED_PATH = '/install/failed';

const NO_STORE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } as const;

/**
 * The client IP for rate limiting: Vercel's `x-real-ip`, else the first `x-forwarded-for` hop.
 * Only ever hashed (HMAC) before it is stored.
 */
export function clientIp(req: Request): string {
  const real = req.headers.get('x-real-ip')?.trim();
  if (real !== undefined && real.length > 0 && real.length <= 64) return real;
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded !== undefined && forwarded.length > 0 && forwarded.length <= 64) return forwarded;
  return 'unknown';
}

export function redirect(location: string, status: 302 | 303 = 303): Response {
  return new Response(null, { status, headers: { Location: location, ...NO_STORE } });
}

export async function handleHubSpotInstall(req: Request, deps: Deps): Promise<Response> {
  try {
    const result = await startInstall(deps, { ip: clientIp(req) });
    if (result.type === 'rate_limited') {
      return new Response('Too many install attempts. Please try again in a minute.', {
        status: 429,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': String(result.retryAfterSeconds), ...NO_STORE },
      });
    }
    return withSetCookies(redirect(result.location, 302), result.cookies);
  } catch (error) {
    log.error('hubspot install start failed', { event: 'hubspot.install_start_failed', code: errorCode(error) }, error);
    return redirect(`${deps.env.APP_URL}${INSTALL_FAILED_PATH}?reason=unavailable`);
  }
}
