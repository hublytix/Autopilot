import 'server-only';
import type { Deps, SessionCookie } from '@/server/ports';
import { REQUIRED_SCOPES } from '@/server/hubspot/scopes';
import { hitFixedWindow, rateLimitKeyHash } from '@/server/services/hubspot/fixed-window';
import { issueStateCookie } from './cookies';

// GET /api/hubspot/install (PLAN §7.3, D-36): 20 per minute per IP (Postgres fixed window, HMAC
// key), then the signed `state` cookie and a redirect to HubSpot's consent screen with exactly
// REQUIRED_SCOPES (fake mode: /dev/fake-hubspot/authorize).

export const INSTALL_RATE_LIMIT = 20;
export const INSTALL_RATE_WINDOW_MS = 60 * 1000;

export type StartInstallResult =
  | { readonly type: 'redirect'; readonly location: string; readonly cookies: readonly SessionCookie[] }
  | { readonly type: 'rate_limited'; readonly retryAfterSeconds: number };

export async function startInstall(deps: Deps, input: { ip: string }): Promise<StartInstallResult> {
  const now = deps.clock.now();
  const hit = await hitFixedWindow(deps.db, {
    keyHash: rateLimitKeyHash(deps.env, `install:ip:${input.ip}`),
    windowMs: INSTALL_RATE_WINDOW_MS,
    now,
  });
  if (hit.count > INSTALL_RATE_LIMIT) {
    return { type: 'rate_limited', retryAfterSeconds: Math.max(1, Math.ceil((hit.windowEnd.getTime() - now.getTime()) / 1000)) };
  }
  const { state, cookie } = issueStateCookie(deps.env, now);
  const location = deps.hubspot.authorizeUrl({ state, redirectUri: deps.env.HUBSPOT_REDIRECT_URI, scopes: REQUIRED_SCOPES });
  return { type: 'redirect', location, cookies: [cookie] };
}
