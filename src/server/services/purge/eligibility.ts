import 'server-only';
import { z } from 'zod';
import type { Db } from '@/server/db';

// When an account is purged (PLAN §9.1 step 6, §9.10 step 5, D-48): no connection is active, and
// either its `purge_after` has passed (30 days after a revoke or disconnect), or it is an orphan:
// no bound owner, the last install more than 7 days ago, and no unexpired pending owner. A
// branch-(b) reinstall moves `last_install_at` (restarting the orphan clock) and makes the
// connection active again, so it is never purged on that clock.

export const ORPHAN_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface PurgeState {
  readonly accountId: string;
  readonly portalId: string;
  readonly trialStartedAt: Date;
  readonly ownerUserId: string | null;
  readonly ownerEmail: string | null;
  readonly pendingOwnerAuthUserId: string | null;
  readonly pendingOwnerEmail: string | null;
  /** `purge_after < $now`. */
  readonly purgeDue: boolean;
  /** No bound owner, last install over 7 days ago, no unexpired pending owner. */
  readonly orphan: boolean;
  readonly connectionActive: boolean;
}

const stateSchema = z.object({
  id: z.string(),
  hubspot_portal_id: z.string(),
  trial_started_at: z.date(),
  owner_user_id: z.string().nullable(),
  owner_email: z.string().nullable(),
  pending_owner_auth_user_id: z.string().nullable(),
  pending_owner_email: z.string().nullable(),
  purge_due: z.boolean(),
  orphan: z.boolean(),
  connection_active: z.boolean(),
});

/**
 * The account's purge inputs at `now`; null when the account is gone. `lock` takes the row lock
 * the purge's final transaction needs (`for update`: the row is about to be deleted).
 */
export async function loadPurgeState(db: Db, accountId: string, now: Date, lock = false): Promise<PurgeState | null> {
  if (lock) await db.query(`select id from accounts where id = $1 for update`, [accountId]);
  const raw = await db.maybeOne(
    `select a.id, a.hubspot_portal_id, a.trial_started_at, a.owner_user_id, u.email as owner_email,
            a.pending_owner_auth_user_id, a.pending_owner_email,
            (a.purge_after is not null and a.purge_after < $2) as purge_due,
            (a.owner_user_id is null and a.last_install_at < $3
              and (a.pending_owner_expires_at is null or a.pending_owner_expires_at <= $2)) as orphan,
            exists (select 1 from hubspot_connections c where c.account_id = a.id and c.status = 'active') as connection_active
       from accounts a
       left join users u on u.account_id = a.id and u.auth_user_id = a.owner_user_id
      where a.id = $1`,
    [accountId, now, new Date(now.getTime() - ORPHAN_AFTER_MS)],
  );
  if (raw === null) return null;
  const row = stateSchema.parse(raw);
  return {
    accountId: row.id,
    portalId: row.hubspot_portal_id,
    trialStartedAt: row.trial_started_at,
    ownerUserId: row.owner_user_id,
    ownerEmail: row.owner_email,
    pendingOwnerAuthUserId: row.pending_owner_auth_user_id,
    pendingOwnerEmail: row.pending_owner_email,
    purgeDue: row.purge_due,
    orphan: row.orphan,
    connectionActive: row.connection_active,
  };
}

/** No connection is active, and the purge date passed or the account is an orphan. */
export function purgeEligible(state: PurgeState): boolean {
  return !state.connectionActive && (state.purgeDue || state.orphan);
}
