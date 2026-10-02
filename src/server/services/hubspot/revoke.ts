import 'server-only';
import type { Db } from '@/server/db';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { applyProcessingStateInTx } from '@/server/services/accounts/apply-processing-state';
import { hasBoundOwner } from '@/server/services/accounts/emails';
import { mergePostCommitWork, NO_POST_COMMIT_WORK, runPostCommitWork, type PostCommitWork } from '@/server/services/accounts/post-commit';
import { NotificationKeys, NotificationPredicates } from '@/server/services/notifications/predicates';
import { reserveInTx } from '@/server/services/notifications/reserve';

// The revoked path (PLAN §9.1 step 3, D-10): one transaction holds
// - the compare-and-set on `status='active' AND token_version=$v` that marks the connection revoked
//   and wipes its tokens (so a reconnect that stored fresh tokens meanwhile is never undone),
// - the applyProcessingState transition (→ revoked: purge_after = +30 d, jobs cancelled, action
//   tokens revoked),
// - the `reconnect` reservation, key reconnect:{connection}:{status_changed_at}.
// The email and the QStash cancels run after commit; a lost send is resumed by the sweeper.
// Used by the token manager (a refresh classified revoked) and, in M7, the daily introspection probe.

export type RevokeReason = 'refresh_revoked' | 'introspection_inactive';

export interface RevokeConnectionInput {
  readonly accountId: string;
  readonly connectionId: string;
  /** The `token_version` whose refresh token was found revoked. */
  readonly tokenVersion: number;
  readonly reason: RevokeReason;
}

export type RevokeOutcome =
  /** This caller revoked the connection. */
  | 'revoked'
  /** Someone else already marked it revoked or disconnected. */
  | 'already_inactive'
  /** It is still active with newer tokens (a reconnect or another refresh): nothing was changed. */
  | 'superseded';

export async function revokeConnectionInTx(tx: Db, now: Date, input: RevokeConnectionInput): Promise<{ outcome: RevokeOutcome; work: PostCommitWork }> {
  const row = await tx.maybeOne<{ status_changed_at: Date }>(
    `update hubspot_connections
        set status = 'revoked', status_changed_at = $3, status_reason = $4,
            access_token_enc = null, refresh_token_enc = null, access_expires_at = null,
            refresh_lease_id = null, refresh_lease_until = null
      where id = $1 and status = 'active' and token_version = $2
      returning status_changed_at`,
    [input.connectionId, input.tokenVersion, now, input.reason],
  );
  if (row === null) {
    const current = await tx.maybeOne<{ status: string }>(`select status from hubspot_connections where id = $1`, [input.connectionId]);
    return { outcome: current?.status === 'active' ? 'superseded' : 'already_inactive', work: NO_POST_COMMIT_WORK };
  }

  const applied = await applyProcessingStateInTx(tx, now, input.accountId);
  let reconnect: PostCommitWork = NO_POST_COMMIT_WORK;
  if (await hasBoundOwner(tx, input.accountId)) {
    const dedupeKey = NotificationKeys.reconnect(input.connectionId, row.status_changed_at);
    const reserved = await reserveInTx(tx, {
      kind: 'reconnect',
      dedupeKey,
      accountId: input.accountId,
      predicates: NotificationPredicates.reconnect(input.connectionId, row.status_changed_at),
      now,
    });
    if (reserved !== null) reconnect = { sends: [dedupeKey], cancelled: [] };
  }
  return { outcome: 'revoked', work: mergePostCommitWork(applied?.work ?? NO_POST_COMMIT_WORK, reconnect) };
}

/** The revoked path in its own transaction, then the reconnect email and the QStash cancels. */
export async function revokeConnection(deps: Deps, input: RevokeConnectionInput): Promise<RevokeOutcome> {
  const now = deps.clock.now();
  const { outcome, work } = await deps.db.tx((tx) => revokeConnectionInTx(tx, now, input));
  if (outcome === 'revoked') {
    log.warn('hubspot connection revoked', {
      event: 'hubspot.connection_revoked',
      accountId: input.accountId,
      connectionId: input.connectionId,
      reason: input.reason,
    });
  }
  await runPostCommitWork(deps, work);
  return outcome;
}
