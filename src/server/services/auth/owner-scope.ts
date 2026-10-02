import 'server-only';
import { z } from 'zod';
import { PermanentError } from '@/server/domain/errors';
import type { Env } from '@/server/env';
import type { AuthUser, Deps } from '@/server/ports';

// Who is asking (PLAN §3, §7.1, §10.8): `requireOwner` turns a verified session into an
// OwnerScope {accountId, userId}, the only way to get one, and owner-facing repositories take it
// as their first argument, so a page or action can never read another account by passing ids.
// `requireAdmin` accepts a verified session whose email is in ADMIN_EMAILS. Sessions are read from
// the request's cookies through the AuthProvider (verified, never refreshed: the proxy refreshes).

declare const OWNER_SCOPE: unique symbol;

/** The verified owner of one account. Created only by requireOwner/resolveOwner (and a test helper). */
export interface OwnerScope {
  readonly accountId: string;
  readonly userId: string;
  readonly [OWNER_SCOPE]: true;
}

/** No verified session, or the session's user owns no account: pages redirect to /login. */
export class OwnerRequiredError extends PermanentError<'auth_owner_required'> {
  override readonly name: string = 'OwnerRequiredError';

  constructor() {
    super('auth_owner_required', { httpStatus: 401 });
  }
}

/** Not a verified admin session: the admin pages answer 404 as if they did not exist. */
export class AdminRequiredError extends PermanentError<'auth_admin_required'> {
  override readonly name: string = 'AdminRequiredError';

  constructor() {
    super('auth_admin_required', { httpStatus: 404 });
  }
}

export function isOwnerRequiredError(error: unknown): error is OwnerRequiredError {
  return error instanceof OwnerRequiredError;
}

export function isAdminRequiredError(error: unknown): error is AdminRequiredError {
  return error instanceof AdminRequiredError;
}

function ownerScope(accountId: string, userId: string): OwnerScope {
  return Object.freeze({ accountId, userId }) as OwnerScope;
}

const ownerRow = z.object({ account_id: z.string() });

/** The owner scope of the request's verified session, or null (no session, or not a bound owner). */
export async function resolveOwner(deps: Deps, request: Request): Promise<OwnerScope | null> {
  const user = await deps.auth.getVerifiedUser(request);
  if (user === null) return null;
  // Bound means both sides agree: the users row and accounts.owner_user_id.
  const raw = await deps.db.maybeOne(
    `select u.account_id
       from users u join accounts a on a.id = u.account_id and a.owner_user_id = u.auth_user_id
      where u.auth_user_id = $1`,
    [user.userId],
  );
  return raw === null ? null : ownerScope(ownerRow.parse(raw).account_id, user.userId);
}

/** The owner scope, or OwnerRequiredError. */
export async function requireOwner(deps: Deps, request: Request): Promise<OwnerScope> {
  const scope = await resolveOwner(deps, request);
  if (scope === null) throw new OwnerRequiredError();
  return scope;
}

/** True when `email` (any case) is listed in ADMIN_EMAILS. */
export function isAdminEmail(env: Env, email: string): boolean {
  const normalised = email.trim().toLowerCase();
  return normalised.length > 0 && env.ADMIN_EMAILS.includes(normalised);
}

/** The verified admin user, or null. */
export async function resolveAdmin(deps: Deps, request: Request): Promise<AuthUser | null> {
  const user = await deps.auth.getVerifiedUser(request);
  return user !== null && isAdminEmail(deps.env, user.email) ? user : null;
}

/** The verified admin user, or AdminRequiredError (rendered as a 404). */
export async function requireAdmin(deps: Deps, request: Request): Promise<AuthUser> {
  const admin = await resolveAdmin(deps, request);
  if (admin === null) throw new AdminRequiredError();
  return admin;
}

/** Tests of owner-scoped repositories only; refused outside NODE_ENV=test. */
export function createOwnerScopeForTest(accountId: string, userId: string): OwnerScope {
  if (process.env.NODE_ENV !== 'test') throw new Error('owner_scope_test_helper_outside_tests');
  return ownerScope(accountId, userId);
}
