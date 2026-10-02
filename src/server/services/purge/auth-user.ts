import 'server-only';
import type { Deps } from '@/server/ports';
import { authUserReference, deleteAuthUserUnlessReferenced, type AuthUserReference } from '@/server/services/auth/auth-user-deletion';
import type { PurgeState } from './eligibility';

// The auth user a purge deletes (PLAN §9.1 step 6, §9.10 step 5, D-35, D-48, D-82): the bound
// owner's, or for an account without one the pending owner's auth user this account's email step
// created. Either is deleted only when nothing outside this account refers to it
// (services/auth/auth-user-deletion.ts): no other account's `users` row has that auth user (or its
// address), no other account lists it as its owner or as `pending_owner_auth_user_id`, no other
// unbound install has its address as an unexpired pending owner email (that install's magic link
// signs in this very user), and the address is not an admin's (D-62's guard). The address is the
// one we stored, else the AuthProvider's (a branch-(b) reinstall clears the pending email but keeps
// the user's id), so the address checks always run. A user kept only because another install is
// pending on it is queued and deleted by the daily cron once that reference lapses.

export type AuthUserOutcome =
  /** Deleted (or already gone). */
  | 'deleted'
  /** Another account owns it or is pending on it, or it is an admin's: kept. */
  | 'kept'
  /** The account has no auth user to delete. */
  | 'none';

/** The user to delete and its address (when known), or null. */
export function purgeAuthUser(state: PurgeState): { userId: string; email: string | null } | null {
  if (state.ownerUserId !== null) return { userId: state.ownerUserId, email: state.ownerEmail };
  if (state.pendingOwnerAuthUserId !== null) return { userId: state.pendingOwnerAuthUserId, email: state.pendingOwnerEmail };
  return null;
}

/** What outside `accountId` still refers to the auth user (see the header). */
export async function authUserReferencedElsewhere(
  deps: Pick<Deps, 'db' | 'env' | 'clock' | 'auth'>,
  input: { accountId: string; userId: string; email: string | null },
): Promise<AuthUserReference> {
  return authUserReference(deps, { userId: input.userId, email: input.email, exceptAccountId: input.accountId });
}

/** Deletes the account's auth user unless it is referenced elsewhere. AuthProvider errors propagate (the purge retries). */
export async function deletePurgedAuthUser(deps: Pick<Deps, 'db' | 'env' | 'clock' | 'auth'>, state: PurgeState): Promise<AuthUserOutcome> {
  const user = purgeAuthUser(state);
  if (user === null) return 'none';
  return deleteAuthUserUnlessReferenced(deps, { userId: user.userId, email: user.email, exceptAccountId: state.accountId });
}
