import 'server-only';
import { z } from 'zod';
import type { Db } from '@/server/db';
import { raiseAlert } from '@/server/jobs/alert';
import { cancelJobsInTx, cancelScheduledMessages, type CancelledJobs } from '@/server/jobs/cancel';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { deletePurgedAuthUser, type AuthUserOutcome } from './auth-user';
import { settleSubscriptionsForPurge, type SettledSubscriptions, type TombstonePlan } from './billing';
import { loadPurgeState, purgeEligible } from './eligibility';
import { deleteFakeOutboxForAccountInTx } from './fake-outbox';

// The account purge (PLAN §9.10 step 5, §9.1 step 6, D-48), run by the account's daily job. In order:
// 1. the purge condition (eligibility.ts): no active connection, and `purge_after < $now` or an
//    orphan (whose connection the orphan step has just set `disconnected`);
// 2. the subscriptions (billing.ts): a live one is cancelled first; paused/pending/halted only
//    alert the admin; network calls, no transaction open;
// 3. the condition again, right before the auth-user delete;
// 4. the auth user (auth-user.ts): the bound owner's, or the pending one, unless another account
//    refers to it. A failure stops the purge here, to be retried (the account still points at it);
// 5. one transaction: the account row locked `for update` and the condition checked a third time;
//    the tombstones (`portal_history`, which keeps the trial from restarting on a reinstall, and one
//    `billing_tombstones` row per subscription: last status, `expire_by`, `resolved_at = $now` for
//    the ones that can no longer charge). The subscriptions are read again under the lock: a row
//    step 2 never saw (a checkout that committed while the purge ran) gets an open tombstone, so the
//    reconcile and the webhook cancel it if it is ever authorised (D-82; a checkout after the lock
//    finds no account and tombstones its subscription itself). The account's jobs cancelled (`account_purge`; an
//    account-wide cancel leaves privacy deletions alone, D-06, and the cascade below removes the
//    content they would remove); `delete from accounts`, which cascades to every account-scoped
//    table: leads, lead content, drafts, tokens, settings, briefs, connection, users…; in fake mode
//    the dev outbox's copies of the account's emails go too (fake-outbox.ts);
// 6. after commit: the QStash cancels and the admin alerts.
// The tombstones are written only with the delete, so a webhook never finds one for a live account.

export type PurgeOutcome =
  | { readonly status: 'not_found' }
  | { readonly status: 'not_due' }
  /** The condition stopped holding during the purge (a reconnect or a bind): nothing was deleted. */
  | { readonly status: 'aborted'; readonly authUser: AuthUserOutcome | 'not_reached' }
  | { readonly status: 'purged'; readonly authUser: AuthUserOutcome; readonly tombstones: number; readonly cancelledSubscriptions: number };

export interface PurgeOptions {
  /** The calling job: its own QStash message is left alone (the delete removes its row). */
  readonly exceptJobId?: string | undefined;
}

const lateRowSchema = z.object({ provider_subscription_id: z.string(), status: z.string(), expire_by: z.date().nullable() });

/** Subscriptions inserted after the settle step read them: open tombstones, never resolved unread. */
async function lateTombstones(tx: Db, accountId: string, settled: SettledSubscriptions): Promise<TombstonePlan[]> {
  const known = new Set(settled.tombstones.map((tombstone) => tombstone.providerSubscriptionId));
  const rows = (await tx.query(`select provider_subscription_id, status, expire_by from subscriptions where account_id = $1 order by created_at, id`, [accountId])).map(
    (raw) => lateRowSchema.parse(raw),
  );
  return rows
    .filter((row) => !known.has(row.provider_subscription_id))
    .map((row) => ({ providerSubscriptionId: row.provider_subscription_id, lastStatus: row.status, expireBy: row.expire_by, checked: false, resolved: false }));
}

async function writeTombstonesAndDelete(
  deps: Pick<Deps, 'db' | 'clock' | 'env'>,
  accountId: string,
  settled: SettledSubscriptions,
  options: PurgeOptions,
): Promise<{ deleted: false } | { deleted: true; cancelledJobs: CancelledJobs; late: readonly TombstonePlan[] }> {
  const now = deps.clock.now();
  return deps.db.tx(async (tx) => {
    const state = await loadPurgeState(tx, accountId, now, true);
    if (state === null || !purgeEligible(state)) return { deleted: false };
    await tx.query(`insert into portal_history (hubspot_portal_id, first_trial_started_at) values ($1, $2) on conflict (hubspot_portal_id) do nothing`, [
      state.portalId,
      state.trialStartedAt,
    ]);
    const late = await lateTombstones(tx, accountId, settled);
    for (const tombstone of [...settled.tombstones, ...late]) {
      await tx.query(
        `insert into billing_tombstones (provider_subscription_id, last_status, expire_by, purged_at, last_checked_at, resolved_at)
         values ($1, $2, $3::timestamptz, $4::timestamptz, case when $5::boolean then $4::timestamptz end, case when $6::boolean then $4::timestamptz end)
         on conflict (provider_subscription_id) do update
           set last_status = excluded.last_status, expire_by = coalesce(excluded.expire_by, billing_tombstones.expire_by),
               last_checked_at = coalesce(excluded.last_checked_at, billing_tombstones.last_checked_at),
               resolved_at = coalesce(billing_tombstones.resolved_at, excluded.resolved_at)`,
        [tombstone.providerSubscriptionId, tombstone.lastStatus, tombstone.expireBy, now, tombstone.checked, tombstone.resolved],
      );
    }
    const cancelledJobs = await cancelJobsInTx(tx, { accountId, reason: 'account_purge', now, exceptJobId: options.exceptJobId });
    if (deps.env.APP_MODE === 'fake') await deleteFakeOutboxForAccountInTx(tx, accountId);
    await tx.query(`delete from accounts where id = $1`, [accountId]);
    return { deleted: true, cancelledJobs, late };
  });
}

/** Purges the account when it is due (see the header). Network errors propagate: the caller retries. */
export async function purgeAccountIfDue(deps: Deps, accountId: string, options: PurgeOptions = {}): Promise<PurgeOutcome> {
  const first = await loadPurgeState(deps.db, accountId, deps.clock.now());
  if (first === null) return { status: 'not_found' };
  if (!purgeEligible(first)) return { status: 'not_due' };

  const settled = await settleSubscriptionsForPurge(deps, accountId);

  // Re-checked right before the auth-user delete (PLAN §9.10 step 5).
  const beforeDelete = await loadPurgeState(deps.db, accountId, deps.clock.now());
  if (beforeDelete === null) return { status: 'not_found' };
  if (!purgeEligible(beforeDelete)) {
    log.warn('account purge aborted', { event: 'purge.aborted', accountId, reason: 'before_auth_user' });
    return { status: 'aborted', authUser: 'not_reached' };
  }
  const authUser = await deletePurgedAuthUser(deps, beforeDelete);

  const result = await writeTombstonesAndDelete(deps, accountId, settled, options);
  if (!result.deleted) {
    // Only a reconnect in the last moments can do this; the owner's auth user may be gone already.
    raiseAlert('account_purge_aborted', { accountId, outcome: authUser });
    return { status: 'aborted', authUser };
  }
  await cancelScheduledMessages(deps, result.cancelledJobs);
  for (const subscription of settled.manual) {
    raiseAlert('billing_purge_cancel_in_dashboard', { subscriptionId: subscription.providerSubscriptionId, status: subscription.status });
  }
  for (const tombstone of result.late) {
    // Created while the purge ran: left to the reconcile (open tombstone), but the admin should know.
    raiseAlert('billing_purge_late_subscription', { subscriptionId: tombstone.providerSubscriptionId, status: tombstone.lastStatus });
  }
  log.info('account purged', {
    event: 'purge.account',
    accountId,
    reason: beforeDelete.purgeDue ? 'purge_after' : 'orphan',
    outcome: authUser,
    count: settled.tombstones.length,
    total: settled.cancelled.length,
  });
  return { status: 'purged', authUser, tombstones: settled.tombstones.length + result.late.length, cancelledSubscriptions: settled.cancelled.length };
}
