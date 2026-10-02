import 'server-only';
import { z } from 'zod';
import { errorCode, isConfigError } from '@/server/domain/errors';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { isAdminEmail } from './owner-scope';

// Deleting a Supabase auth user we created for a pending owner (D-35, D-48, D-62, D-82; law 4). The
// onboarding email step deletes the pending user it replaces, and the purge deletes the account's
// owner or pending user, but only when nothing else refers to it:
// - its address is an admin's (ADMIN_EMAILS): never deleted;
// - another account's `users` row has it (by auth id or by address), or another account lists it as
//   owner: it belongs to someone, never deleted;
// - another account lists it as `pending_owner_auth_user_id`, or another unbound install has its
//   address as an unexpired pending owner email (that install's magic link signs in this very
//   user): kept FOR NOW, and queued (`auth_user_deletions`) so the daily cron checks again once
//   that pending owner has bound (then it is theirs) or expired (then it is deleted).
// The address comes from our rows when we still have it, else from the AuthProvider by id (a
// branch-(b) reinstall clears `pending_owner_email` but keeps the pending user's id), so the
// address checks never silently drop out. A delete that fails is queued too and retried daily.
// Ids and codes only in logs; the address is never logged or stored by this module.

export type AuthUserReference =
  /** An ADMIN_EMAILS address. */
  | 'admin'
  /** Another account's owner (users row by id or address, or owner_user_id). */
  | 'owner'
  /** Another account's pending owner (id, or an unexpired pending email): check again later. */
  | 'pending'
  /** Nothing refers to it. */
  | 'none'
  /** No such auth user (already deleted). */
  | 'gone';

export interface AuthUserTarget {
  readonly userId: string;
  /** The address we stored for it, if any; null → asked from the AuthProvider. */
  readonly email: string | null;
  /** References from this account don't count (the account being purged); null: every account counts. */
  readonly exceptAccountId: string | null;
}

type GuardDeps = Pick<Deps, 'db' | 'env' | 'clock' | 'auth'>;

const NO_ACCOUNT = '00000000-0000-0000-0000-000000000000';

/** Who still refers to the auth user (see the header). AuthProvider errors propagate. */
export async function authUserReference(deps: GuardDeps, target: AuthUserTarget): Promise<AuthUserReference> {
  let address = target.email?.trim().toLowerCase() ?? null;
  if (address === null || address === '') {
    address = await deps.auth.getUserEmail(target.userId);
    if (address === null) return 'gone';
  }
  if (isAdminEmail(deps.env, address)) return 'admin';
  const row = await deps.db.maybeOne<{ owner: boolean; pending: boolean }>(
    `select exists (select 1 from users where account_id <> $2::uuid and (auth_user_id = $1::uuid or lower(email) = $3))
            or exists (select 1 from accounts where id <> $2::uuid and owner_user_id = $1::uuid) as owner,
            exists (select 1 from accounts where id <> $2::uuid and pending_owner_auth_user_id = $1::uuid)
            or exists (select 1 from accounts
                        where id <> $2::uuid and owner_user_id is null and lower(pending_owner_email) = $3 and pending_owner_expires_at > $4) as pending`,
    [target.userId, target.exceptAccountId ?? NO_ACCOUNT, address, deps.clock.now()],
  );
  if (row?.owner === true) return 'owner';
  if (row?.pending === true) return 'pending';
  return 'none';
}

/** Queues the user for the daily retry (idempotent). */
export async function queueAuthUserDeletion(deps: Pick<Deps, 'db' | 'clock'>, userId: string): Promise<void> {
  await deps.db.query(`insert into auth_user_deletions (auth_user_id, requested_at) values ($1, $2) on conflict (auth_user_id) do nothing`, [userId, deps.clock.now()]);
}

export type AuthUserDeleteOutcome =
  /** Deleted now (or already gone). */
  | 'deleted'
  /** Referenced elsewhere: kept (queued when that reference may lapse). */
  | 'kept';

/**
 * Deletes the auth user unless something refers to it (see the header). A pending reference queues
 * it for the daily retry. AuthProvider errors propagate (the caller retries, or queues it).
 */
export async function deleteAuthUserUnlessReferenced(deps: GuardDeps, target: AuthUserTarget): Promise<AuthUserDeleteOutcome> {
  const reference = await authUserReference(deps, target);
  switch (reference) {
    case 'gone':
      return 'deleted';
    case 'none':
      await deps.auth.deleteUser(target.userId);
      return 'deleted';
    case 'pending':
      await queueAuthUserDeletion(deps, target.userId);
      return 'kept';
    case 'admin':
    case 'owner':
      return 'kept';
  }
}

export const AUTH_USER_DELETION_LIMIT = 50;

export interface AuthUserDeletionSummary {
  readonly checked: number;
  readonly deleted: number;
  /** Someone's owner or an admin now: dropped from the queue, never deleted. */
  readonly claimed: number;
  /** Still another install's pending owner: checked again tomorrow. */
  readonly waiting: number;
  readonly failed: number;
  /** Left for tomorrow because the time budget ran out. */
  readonly deferred: number;
}

const queuedSchema = z.object({ auth_user_id: z.string() });

/** The daily cron's step: at most `limit` queued users, least recently tried first. Counts only. */
export async function retryAuthUserDeletions(
  deps: GuardDeps,
  options: { limit?: number | undefined; deadline?: Date | undefined } = {},
): Promise<AuthUserDeletionSummary> {
  const rows = (
    await deps.db.query(`select auth_user_id from auth_user_deletions order by last_attempt_at nulls first, requested_at, auth_user_id limit $1`, [
      options.limit ?? AUTH_USER_DELETION_LIMIT,
    ])
  ).map((raw) => queuedSchema.parse(raw));
  const counts = { checked: 0, deleted: 0, claimed: 0, waiting: 0, failed: 0, deferred: 0 };
  for (const [index, row] of rows.entries()) {
    if (options.deadline !== undefined && deps.clock.now().getTime() >= options.deadline.getTime()) {
      counts.deferred = rows.length - index;
      break;
    }
    const userId = row.auth_user_id;
    counts.checked += 1;
    try {
      const outcome = await authUserReference(deps, { userId, email: null, exceptAccountId: null });
      if (outcome === 'pending') {
        counts.waiting += 1;
        await deps.db.query(`update auth_user_deletions set last_attempt_at = $2 where auth_user_id = $1`, [userId, deps.clock.now()]);
        continue;
      }
      if (outcome === 'none') {
        await deps.auth.deleteUser(userId);
        counts.deleted += 1;
      } else if (outcome === 'gone') {
        counts.deleted += 1;
      } else {
        counts.claimed += 1;
      }
      await deps.db.query(`delete from auth_user_deletions where auth_user_id = $1`, [userId]);
    } catch (error) {
      counts.failed += 1;
      log.warn('queued auth user not deleted', { event: 'auth.queued_user_delete_failed', code: errorCode(error) });
      await deps.db.query(`update auth_user_deletions set last_attempt_at = $2 where auth_user_id = $1`, [userId, deps.clock.now()]);
      // Every other call would fail the same way.
      if (isConfigError(error)) break;
    }
  }
  if (counts.checked > 0) log.info('queued auth users checked', { event: 'auth.queued_user_deletions', count: counts.checked, total: counts.deleted });
  return counts;
}
