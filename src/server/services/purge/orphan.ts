import 'server-only';
import { errorCode } from '@/server/domain/errors';
import type { Db } from '@/server/db';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { applyProcessingStateInTx } from '@/server/services/accounts/apply-processing-state';
import { NO_POST_COMMIT_WORK, runPostCommitWork, type PostCommitWork } from '@/server/services/accounts/post-commit';
import { forAccount, type Sleep } from '@/server/services/hubspot';
import { loadPurgeState } from './eligibility';

// Orphan installs (PLAN §9.1 step 6, D-48): an account with no bound owner, whose last install is
// more than 7 days old and which has no unexpired pending owner, is uninstalled and then purged at
// once (purge.ts), deleting its pending auth user only when nothing else refers to it.
// 1. the uninstall API (`DELETE /appinstalls/…/external-install`), best effort, while the connection
//    still holds tokens (HubSpot emails the portal's admins);
// 2. one transaction, locking `accounts` before the connection (docs/ARCHITECTURE.md): the orphan
//    condition re-checked under the lock (a bind or a branch-(b) reinstall wins), the tokens wiped,
//    the connection `disconnected` (`status_reason = 'orphan_uninstalled'`), and applyProcessingState
//    (→ disconnected: jobs cancelled except privacy deletions, action tokens revoked);
// 3. after commit, the QStash cancels.

export const ORPHAN_STATUS_REASON = 'orphan_uninstalled';

export type OrphanOutcome =
  /** Not an orphan (bound, recently installed, or a pending owner is still on time). */
  | 'not_orphan'
  /** Its connection is now disconnected: purge it. */
  | 'disconnected';

async function disconnectInTx(tx: Db, accountId: string, now: Date): Promise<PostCommitWork | null> {
  // The lock comes first; the condition is then read under it.
  const locked = await tx.maybeOne(`select id from accounts where id = $1 for no key update`, [accountId]);
  if (locked === null) return null;
  const state = await loadPurgeState(tx, accountId, now);
  if (state === null || !state.orphan) return null;
  await tx.query(
    `update hubspot_connections
        set status = 'disconnected', status_reason = $3,
            status_changed_at = case when status <> 'disconnected' then $2 else status_changed_at end,
            access_token_enc = null, refresh_token_enc = null, access_expires_at = null,
            refresh_lease_id = null, refresh_lease_until = null
      where account_id = $1 and (status <> 'disconnected' or access_token_enc is not null or refresh_token_enc is not null)`,
    [accountId, now, ORPHAN_STATUS_REASON],
  );
  return (await applyProcessingStateInTx(tx, now, accountId))?.work ?? NO_POST_COMMIT_WORK;
}

/** Uninstalls and disconnects an orphan account (see the header). */
export async function disconnectOrphan(deps: Deps, accountId: string, options: { sleep?: Sleep | undefined } = {}): Promise<OrphanOutcome> {
  const state = await loadPurgeState(deps.db, accountId, deps.clock.now());
  if (state === null || !state.orphan) return 'not_orphan';

  if (state.connectionActive) {
    try {
      await forAccount(deps, accountId, { sleep: options.sleep }).uninstallApp();
    } catch (error) {
      // Best effort: the tokens are wiped below either way.
      log.warn('orphan uninstall failed', { event: 'purge.orphan_uninstall_failed', accountId, code: errorCode(error) }, error);
    }
  }

  const work = await deps.db.tx((tx) => disconnectInTx(tx, accountId, deps.clock.now()));
  if (work === null) return 'not_orphan';
  await runPostCommitWork(deps, work);
  log.info('orphan install disconnected', { event: 'purge.orphan_disconnected', accountId });
  return 'disconnected';
}
