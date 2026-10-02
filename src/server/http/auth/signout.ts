import 'server-only';
import { errorCode } from '@/server/domain/errors';
import { log } from '@/server/obs/log';
import type { Deps, SessionCookie } from '@/server/ports';
import { withSetCookies } from '@/server/security/cookies';
import { isSameOriginRequest } from '@/server/security/same-origin';
import { crossOriginPage } from './confirm';
import { PRIVATE_HEADERS } from './request';

// POST /auth/signout (PLAN §7.2): same-origin only (a cross-site form cannot sign anyone out); ends
// the session at the AuthProvider and clears its cookies, then lands on /login.

export const SIGNED_OUT_PATH = '/login?signed_out=1';

export async function handleSignOut(req: Request, deps: Deps): Promise<Response> {
  if (!isSameOriginRequest(req, deps.env.APP_URL)) {
    log.warn('sign-out refused: cross-origin', { event: 'auth.signout_cross_origin' });
    return crossOriginPage(deps.env.PRODUCT_NAME);
  }
  let cookies: readonly SessionCookie[] = [];
  try {
    cookies = await deps.auth.signOut(req);
  } catch (error) {
    // The browser's cookies are still cleared below only if the adapter named them; log and land on /login.
    log.warn('sign-out failed', { event: 'auth.signout_failed', code: errorCode(error) });
  }
  const response = new Response(null, { status: 303, headers: { Location: `${deps.env.APP_URL}${SIGNED_OUT_PATH}`, ...PRIVATE_HEADERS } });
  return withSetCookies(response, cookies);
}
