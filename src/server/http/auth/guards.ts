import 'server-only';
import { notFound, redirect } from 'next/navigation';
import type { AuthUser, Deps } from '@/server/ports';
import { readRequestCookie } from '@/server/security/cookies';
import { requireAdmin, resolveAdmin, resolveOwner, type OwnerScope } from '@/server/services/auth/owner-scope';
import { PENDING_INSTALL_COOKIE_NAME, readPendingInstall } from '@/server/services/install/cookies';
import { requestFromHeaders, type HeadersLike } from './request';

// Page guards for Server Components (PLAN §7.1, §7.5): pages pass `await headers()` and get an
// OwnerScope (or a redirect to /login), the admin user (or a 404, as if /admin did not exist), or
// the onboarding layout's owner-or-pending answer. Every check reads the verified session through
// requireOwner/requireAdmin; the proxy's cookie check is only the first line.

export const LOGIN_PATH = '/login';

/** The OwnerScope of the request's verified session, or null. */
export async function ownerFromHeaders(deps: Deps, headers: HeadersLike): Promise<OwnerScope | null> {
  return resolveOwner(deps, requestFromHeaders(deps.env.APP_URL, headers));
}

/** The OwnerScope, or a redirect to /login (throws Next's redirect). */
export async function requireOwnerPage(deps: Deps, headers: HeadersLike): Promise<OwnerScope> {
  const scope = await ownerFromHeaders(deps, headers);
  if (scope === null) redirect(LOGIN_PATH);
  return scope;
}

/** The admin user, or Next's notFound(): /admin answers 404 to everyone else. */
export async function requireAdminPage(deps: Deps, headers: HeadersLike): Promise<AuthUser> {
  const admin = await resolveAdmin(deps, requestFromHeaders(deps.env.APP_URL, headers));
  if (admin === null) notFound();
  return admin;
}

/** requireAdmin for route handlers (AdminRequiredError → map to 404). */
export async function requireAdminRequest(deps: Deps, request: Request): Promise<AuthUser> {
  return requireAdmin(deps, request);
}

export type OnboardingAccess = 'owner' | 'pending' | 'none';

/**
 * The onboarding layout's guard: `owner` with a bound owner's verified session, else `pending`
 * with a genuine, unexpired pending_install cookie (the email step checks it is the newest
 * install), else `none`.
 */
export async function onboardingAccess(deps: Deps, headers: HeadersLike): Promise<OnboardingAccess> {
  const request = requestFromHeaders(deps.env.APP_URL, headers);
  if ((await resolveOwner(deps, request)) !== null) return 'owner';
  const pending = readPendingInstall(deps.env, readRequestCookie(request, PENDING_INSTALL_COOKIE_NAME), deps.clock.now());
  return pending === null ? 'none' : 'pending';
}
