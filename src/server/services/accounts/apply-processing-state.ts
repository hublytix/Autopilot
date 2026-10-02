import 'server-only';
import { z } from 'zod';
import { currentSubscription, entitlementOf, type SubscriptionSnapshot } from '@/server/domain/entitlement';
import { computeProcessingState } from '@/server/domain/processing-state';
import { ACCOUNT_PROCESSING_STATES, CONNECTION_STATUSES, type AccountProcessingState } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { raiseAlert } from '@/server/jobs/alert';
import { ACCOUNT_CANCEL_EXCEPT_KINDS, cancelJobsInTx } from '@/server/jobs/cancel';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { revokeTokens } from '@/server/security/action-tokens';
import { NotificationKeys, NotificationPredicates } from '@/server/services/notifications/predicates';
import { reserveInTx } from '@/server/services/notifications/reserve';
import { hasBoundOwner } from './emails';
import { NO_POST_COMMIT_WORK, runPostCommitWork, type PostCommitWork } from './post-commit';

// applyProcessingState (PLAN §6.1, D-42, D-48): the only writer of `accounts.processing_state`.
// Every writer of an input calls it: pause/resume, the OAuth callback, the token manager,
// disconnect, billing webhooks and reconcile, onboarding completion and the poll cron.
//
// In one transaction (no network I/O, D-28):
// 1. load the account, its connection and its current subscription;
// 2. entitlement (D-18): `entitlement_lost_at` is set to $now the first time the account is found
//    not entitled, whatever its state (paused included), and cleared when it is entitled again, so
//    each non-entitled period gets exactly one billing-inactive email;
// 3. computeProcessingState, then a compare-and-set on the previous state;
// 4. only the winner runs the transition's side effects:
//    → active:                  every form's intake floor and cursor move to $now; purge_after and
//                               disconnected_at are cleared;
//    → inactive (from any):     the billing_inactive email is reserved, key
//                               billing-inactive:{acct}:{entitlement_lost_at};
//    → revoked / disconnected:  purge_after = $now + 30 d; jobs cancelled (except privacy deletions,
//                               which run whatever the state, D-06); action tokens revoked;
//    → paused, → onboarding:    nothing (pending follow-ups fail their reservation predicates).
// The emails and QStash cancels run after commit (runPostCommitWork).

export const PURGE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export interface AppliedProcessingState {
  readonly accountId: string;
  readonly previous: AccountProcessingState;
  readonly next: AccountProcessingState;
  /** This caller won the compare-and-set and ran the transition's side effects. */
  readonly transitioned: boolean;
  readonly entitled: boolean;
  readonly entitlementLostAt: Date | null;
  /** To run after commit (runPostCommitWork). */
  readonly work: PostCommitWork;
}

const accountSchema = z.object({
  id: z.string(),
  processing_state: z.enum(ACCOUNT_PROCESSING_STATES),
  paused_at: z.date().nullable(),
  onboarding_completed_at: z.date().nullable(),
  trial_ends_at: z.date(),
  entitlement_lost_at: z.date().nullable(),
  connection_status: z.enum(CONNECTION_STATUSES).nullable(),
});

const subscriptionSchema = z.object({
  id: z.string(),
  status: z.string(),
  grace_until: z.date().nullable(),
  created_at: z.date(),
});

async function loadSubscriptions(tx: Db, accountId: string): Promise<SubscriptionSnapshot[]> {
  const rows = await tx.query(`select id, status, grace_until, created_at from subscriptions where account_id = $1`, [accountId]);
  return rows.map((raw) => {
    const row = subscriptionSchema.parse(raw);
    return { id: row.id, status: row.status, graceUntil: row.grace_until, createdAt: row.created_at };
  });
}

/** Steps 2's write: returns the stored `entitlement_lost_at` after the update. */
async function recordEntitlement(tx: Db, accountId: string, isEntitled: boolean, now: Date): Promise<Date | null> {
  const row = isEntitled
    ? await tx.one<{ entitlement_lost_at: Date | null }>(
        `update accounts set entitlement_lost_at = null where id = $1 returning entitlement_lost_at`,
        [accountId],
      )
    : await tx.one<{ entitlement_lost_at: Date | null }>(
        `update accounts set entitlement_lost_at = coalesce(entitlement_lost_at, $2) where id = $1 returning entitlement_lost_at`,
        [accountId, now],
      );
  return row.entitlement_lost_at;
}

/**
 * The whole of steps 1-4 inside the caller's transaction. Returns null when the account does not
 * exist (purged). Run `result.work` with runPostCommitWork after the transaction commits.
 */
export async function applyProcessingStateInTx(tx: Db, now: Date, accountId: string): Promise<AppliedProcessingState | null> {
  const raw = await tx.maybeOne(
    `select a.id, a.processing_state, a.paused_at, a.onboarding_completed_at, a.trial_ends_at, a.entitlement_lost_at,
            c.status as connection_status
       from accounts a left join hubspot_connections c on c.account_id = a.id
      where a.id = $1`,
    [accountId],
  );
  if (raw === null) return null;
  const account = accountSchema.parse(raw);
  const subscription = currentSubscription(await loadSubscriptions(tx, accountId));
  const inputs = { pausedAt: account.paused_at, onboardingCompletedAt: account.onboarding_completed_at, trialEndsAt: account.trial_ends_at };

  const entitlement = entitlementOf(inputs, subscription, now);
  if (entitlement.reason === 'unknown_status') raiseAlert('billing_unknown_subscription_status', { accountId, subscriptionId: subscription?.id });
  const entitlementLostAt =
    entitlement.entitled === (account.entitlement_lost_at === null)
      ? account.entitlement_lost_at
      : await recordEntitlement(tx, accountId, entitlement.entitled, now);

  const previous = account.processing_state;
  const next = computeProcessingState(inputs, account.connection_status === null ? null : { status: account.connection_status }, subscription, now);
  const unchanged = { accountId, previous, next, transitioned: false, entitled: entitlement.entitled, entitlementLostAt, work: NO_POST_COMMIT_WORK };
  if (next === previous) return unchanged;

  const won = await tx.maybeOne(
    `update accounts set processing_state = $2, processing_state_changed_at = $3 where id = $1 and processing_state = $4 returning id`,
    [accountId, next, now, previous],
  );
  if (won === null) return unchanged;

  const work = await runTransition(tx, { accountId, next, now, entitlementLostAt });
  log.info('processing state changed', { event: 'account.processing_state', accountId, processingState: next, reason: `from_${previous}` });
  return { accountId, previous, next, transitioned: true, entitled: entitlement.entitled, entitlementLostAt, work };
}

interface TransitionInput {
  accountId: string;
  next: AccountProcessingState;
  now: Date;
  entitlementLostAt: Date | null;
}

/** The winner's database side effects (PLAN §6.1 table). */
async function runTransition(tx: Db, input: TransitionInput): Promise<PostCommitWork> {
  const { accountId, now } = input;
  switch (input.next) {
    case 'active':
      await tx.query(
        `update selected_forms set intake_floor_at = $2, cursor_submitted_at = greatest(cursor_submitted_at, $2) where account_id = $1`,
        [accountId, now],
      );
      await tx.query(`update accounts set purge_after = null, disconnected_at = null where id = $1`, [accountId]);
      return NO_POST_COMMIT_WORK;

    case 'inactive': {
      // Inactive means not entitled, so entitlement_lost_at is set; the guard is for the type only.
      if (input.entitlementLostAt === null || !(await hasBoundOwner(tx, accountId))) return NO_POST_COMMIT_WORK;
      const dedupeKey = NotificationKeys.billingInactive(accountId, input.entitlementLostAt);
      const reserved = await reserveInTx(tx, {
        kind: 'billing_inactive',
        dedupeKey,
        accountId,
        predicates: NotificationPredicates.billingInactive(accountId),
        now,
      });
      return reserved === null ? NO_POST_COMMIT_WORK : { sends: [dedupeKey], cancelled: [] };
    }

    case 'revoked':
    case 'disconnected': {
      const purgeAfter = new Date(now.getTime() + PURGE_AFTER_MS);
      await tx.query(
        `update accounts
            set purge_after = $2, disconnected_at = case when $3::boolean then coalesce(disconnected_at, $4) else disconnected_at end
          where id = $1`,
        [accountId, purgeAfter, input.next === 'disconnected', now],
      );
      const cancelled = await cancelJobsInTx(tx, { accountId, exceptKinds: ACCOUNT_CANCEL_EXCEPT_KINDS, reason: input.next, now });
      await revokeTokens(tx, { accountId, now });
      return { sends: [], cancelled: [cancelled] };
    }

    case 'paused':
    case 'onboarding':
      return NO_POST_COMMIT_WORK;
  }
}

/** applyProcessingStateInTx in its own transaction, then the post-commit work. Null when the account is gone. */
export async function applyProcessingState(deps: Deps, accountId: string): Promise<AppliedProcessingState | null> {
  const now = deps.clock.now();
  const result = await deps.db.tx((tx) => applyProcessingStateInTx(tx, now, accountId));
  if (result !== null) await runPostCommitWork(deps, result.work);
  return result;
}
