import 'server-only';
import type { Deps } from '@/server/ports';
import { claimOnce, hitFixedWindow, rateLimitKeyHash } from '@/server/security/rate-limit';

// Rate limits on the auth routes (D-36, PLAN §10.3): Postgres fixed windows keyed by an HMAC of the
// route and the IP or the lower-cased email, so `rate_limits` never holds either.
//   /login and /onboarding/email: 5 per 15 min per IP, 3 per 15 min per email;
//   /onboarding/email also: at most 3 distinct emails per pending install;
//   POST /auth/confirm: 10 per 15 min per IP.

export const AUTH_RATE_WINDOW_MS = 15 * 60 * 1000;

export const AUTH_RATE_LIMITS = {
  login: { ip: 5, email: 3 },
  onboardingEmail: { ip: 5, email: 3, distinctEmailsPerInstall: 3 },
  confirm: { ip: 10 },
} as const;

export type AuthRoute = 'login' | 'onboarding_email' | 'confirm';

export interface LimitCheck {
  readonly limited: boolean;
  /** Seconds until the window ends (for Retry-After). */
  readonly retryAfterSeconds: number;
}

/** Counts one hit for `subject` ("ip:…" or "email:…") on `route` and says whether it is over `limit`. */
export async function hitAuthLimit(deps: Deps, route: AuthRoute, subject: string, limit: number): Promise<LimitCheck> {
  const now = deps.clock.now();
  const hit = await hitFixedWindow(deps.db, {
    keyHash: rateLimitKeyHash(deps.env, `auth:${route}:${subject}`),
    windowMs: AUTH_RATE_WINDOW_MS,
    now,
  });
  return { limited: hit.count > limit, retryAfterSeconds: Math.max(1, Math.ceil((hit.windowEnd.getTime() - now.getTime()) / 1000)) };
}

/**
 * The per-install distinct-email limit (D-36): an email already accepted for this install passes
 * again; a new one takes one of the install's slots. The install is the pending_install cookie's
 * account and `installedAt`, so a reinstall starts with fresh slots. Markers live in `rate_limits`
 * with the install instant as their window, for the 24 h the cookie lasts.
 */
export async function takeInstallEmailSlot(deps: Deps, install: { accountId: string; installedAt: Date }, email: string): Promise<boolean> {
  const scope = `auth:onboarding_email:install:${install.accountId}:${install.installedAt.toISOString()}`;
  const acceptedKey = rateLimitKeyHash(deps.env, `${scope}:accepted:${email}`);
  const seen = await deps.db.maybeOne(`select 1 as seen from rate_limits where key_hash = $1 and window_start = $2`, [acceptedKey, install.installedAt]);
  if (seen !== null) return true;
  // One slot per new email; windowMs 1 pins the counter's window to the install instant itself.
  const slots = await hitFixedWindow(deps.db, { keyHash: rateLimitKeyHash(deps.env, `${scope}:distinct`), windowMs: 1, now: install.installedAt });
  if (slots.count > AUTH_RATE_LIMITS.onboardingEmail.distinctEmailsPerInstall) return false;
  await claimOnce(deps.db, { keyHash: acceptedKey, windowStart: install.installedAt });
  return true;
}
