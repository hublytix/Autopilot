import 'server-only';
import { z } from 'zod';
import { errorCode, isAppError } from '@/server/domain/errors';
import type { Db } from '@/server/db';
import { isDbError } from '@/server/db/errors';
import { raiseAlert } from '@/server/jobs/alert';
import { log } from '@/server/obs/log';
import type { Deps, RazorpaySubscription } from '@/server/ports';
import { applyProcessingStateInTx, NO_POST_COMMIT_WORK, runPostCommitWork } from '@/server/services/accounts';
import type { OwnerScope } from '@/server/services/auth/owner-scope';
import { loadPurgeState, purgeEligible } from '@/server/services/purge/eligibility';
import { markStaleInTx } from './apply';
import { withBillingLock } from './lock';
import { loadAccountSubscriptions, lockAccount, type SubscriptionRow } from './rows';
import { checkoutGuard, checkoutTiming, isUsableCheckoutLink, mapRazorpayStatus, SUBSCRIPTION_TOTAL_COUNT, type BlockingStatus, type CheckoutConfig } from '@/server/domain/checkout-guard';
import { applyFetched } from './sync';

// Checkout (PLAN §9.9, D-18, D-20), exactly in PLAN order:
// 1. the lock: accounts.checkout_lock_until, 30 s compare-and-set (lock.ts);
// 2. the guard: block on authenticated/active/pending/halted/paused (pending/halted → "Update payment
//    method" with the stored link; paused → Resume; authenticated/active → already subscribed) and on
//    a status Razorpay doesn't document (`unknown` → contact support, D-82);
// 3. reuse a `created` row's stored link while expire_by > now and (start_at null or > now);
// 4. otherwise re-fetch every other `created` row: a status other than `created` is applied (if it is
//    now live, the guard blocks); still `created`, or the read failed → marked `stale` locally;
// 5. create: total_count 120, quantity 1, customer_notify true, notes {autopilot_account_id};
//    start_at = trial end when more than a day of trial is left, with expire_by = min(now + 7 d,
//    start_at − 60 s); else no start_at and expire_by = now + 7 d. The row is inserted (created_at
//    logical, the link stored) and the owner is sent to the link.
// The owner reaches Razorpay's page through our own /dashboard/billing/checkout page, never by a
// redirect from the form POST: CSP form-action 'self' also covers a form's redirects (D-56 note).
// An account the purge is about to delete (no active connection, past `purge_after`) gets no new
// checkout; and if the account is gone by the time the new subscription is recorded, it is written
// as an open billing tombstone instead, so the reconcile and the webhook cancel it if it is ever
// authorised (D-82: the purge can never miss a subscription created during it).

export type CheckoutOutcome =
  /** Go to Razorpay's hosted page (a new link, or the open checkout's). */
  | { readonly type: 'checkout'; readonly link: string; readonly reused: boolean }
  /** A live subscription exists: no second checkout. */
  | { readonly type: 'blocked'; readonly status: BlockingStatus }
  /** Another billing action of this account is running: try again in a moment. */
  | { readonly type: 'busy' }
  /** Razorpay could not be reached or refused (alerted when it is our configuration). */
  | { readonly type: 'unavailable' }
  /** The account is due for deletion (HubSpot disconnected more than 30 days ago): no new subscription. */
  | { readonly type: 'closing' };

const accountSchema = z.object({ trial_ends_at: z.date() });

function config(deps: Deps): CheckoutConfig {
  return { planId: deps.env.RAZORPAY_PLAN_ID, appUrl: deps.env.APP_URL };
}

function unavailable(error: unknown, accountId: string): CheckoutOutcome {
  if (!isAppError(error) || error.kind === 'config' || error.kind === 'permanent') {
    raiseAlert('billing_checkout_failed', { accountId, errorCode: errorCode(error) });
  } else {
    log.warn('checkout deferred: razorpay unavailable', { event: 'billing.checkout_unavailable', accountId, code: errorCode(error) });
  }
  return { type: 'unavailable' };
}

/** Step 4 for one `created` row that can't be reused. */
async function resolveCreated(deps: Deps, row: SubscriptionRow): Promise<void> {
  const fetchedAt = deps.clock.now();
  try {
    const snapshot = await deps.billing.fetchSubscription(row.providerSubscriptionId);
    if (mapRazorpayStatus(snapshot.status).status !== 'created') {
      await applyFetched(deps, { row, snapshot, fetchedAt });
      return;
    }
  } catch (error) {
    log.warn('created subscription not readable; marked stale', { event: 'billing.created_unreadable', accountId: row.accountId, subscriptionId: row.id, code: errorCode(error) });
  }
  // Razorpay still says `created` (it documents no expiry at expire_by), or the read failed.
  const now = deps.clock.now();
  const result = await deps.db.tx((tx) => markStaleInTx(tx, row, now));
  await runPostCommitWork(deps, result.work);
}

/** The account was purged between Razorpay's create and our insert: keep the subscription on record as an open tombstone. */
async function tombstoneOrphanedCheckout(tx: Db, created: RazorpaySubscription, expireBy: Date, now: Date): Promise<void> {
  await tx.query(
    `insert into billing_tombstones (provider_subscription_id, last_status, expire_by, purged_at)
     values ($1, $2, $3, $4)
     on conflict (provider_subscription_id) do update set resolved_at = null, last_checked_at = null`,
    [created.id, created.status.slice(0, 64), expireBy, now],
  );
}

async function checkoutLocked(deps: Deps, accountId: string): Promise<CheckoutOutcome> {
  const raw = await deps.db.maybeOne(`select trial_ends_at from accounts where id = $1`, [accountId]);
  if (raw === null) return { type: 'unavailable' };
  const { trial_ends_at: trialEndsAt } = accountSchema.parse(raw);
  const purge = await loadPurgeState(deps.db, accountId, deps.clock.now());
  if (purge !== null && purgeEligible(purge)) return { type: 'closing' };

  let decision = checkoutGuard(await loadAccountSubscriptions(deps.db, accountId), deps.clock.now(), config(deps));
  if (decision.type === 'create' && decision.recheck.length > 0) {
    for (const row of decision.recheck) await resolveCreated(deps, row);
    decision = checkoutGuard(await loadAccountSubscriptions(deps.db, accountId), deps.clock.now(), config(deps));
  }
  if (decision.type === 'blocked') return { type: 'blocked', status: decision.row.status };
  if (decision.type === 'reuse' && decision.row.shortUrl !== null) return { type: 'checkout', link: decision.row.shortUrl, reused: true };

  const now = deps.clock.now();
  const timing = checkoutTiming(trialEndsAt, now);
  let created: RazorpaySubscription;
  try {
    created = await deps.billing.createSubscription({
      planId: deps.env.RAZORPAY_PLAN_ID,
      totalCount: SUBSCRIPTION_TOTAL_COUNT,
      quantity: 1,
      customerNotify: true,
      startAt: timing.startAt ?? undefined,
      expireBy: timing.expireBy,
      notes: { autopilot_account_id: accountId },
    });
  } catch (error) {
    return unavailable(error, accountId);
  }
  if (!isUsableCheckoutLink(created.shortUrl, deps.env.APP_URL)) {
    raiseAlert('billing_checkout_link_unusable', { accountId, subscriptionId: created.id });
    return { type: 'unavailable' };
  }

  const mapped = mapRazorpayStatus(created.status);
  let recorded: boolean;
  try {
    const result = await deps.db.tx(async (tx) => {
      if (!(await lockAccount(tx, accountId))) {
        await tombstoneOrphanedCheckout(tx, created, created.expireBy ?? timing.expireBy, now);
        return { recorded: false, work: NO_POST_COMMIT_WORK };
      }
      await tx.query(
        `insert into subscriptions (account_id, provider_subscription_id, plan_id, status, status_changed_at, short_url, start_at, expire_by,
                                    current_start, current_end, last_synced_at, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $5, $5)`,
        [
          accountId,
          created.id,
          created.planId,
          mapped.status,
          now,
          created.shortUrl,
          created.startAt ?? timing.startAt,
          created.expireBy ?? timing.expireBy,
          created.currentStart ?? null,
          created.currentEnd ?? null,
        ],
      );
      return { recorded: true, work: (await applyProcessingStateInTx(tx, now, accountId))?.work ?? NO_POST_COMMIT_WORK };
    });
    recorded = result.recorded;
    await runPostCommitWork(deps, result.work);
  } catch (error) {
    // Razorpay holds a subscription we could not record (the lock outlived?): nobody can pay it
    // through us, but the admin should know.
    raiseAlert('billing_checkout_insert_failed', { accountId, subscriptionId: created.id, errorCode: isDbError(error) ? (error.sqlstate ?? error.code) : errorCode(error) });
    return { type: 'unavailable' };
  }
  if (!recorded) {
    log.warn('checkout created for a purged account; tombstoned', { event: 'billing.checkout_account_gone', accountId, subscriptionId: created.id });
    return { type: 'unavailable' };
  }
  log.info('checkout created', { event: 'billing.checkout_created', accountId, subscriptionId: created.id });
  return { type: 'checkout', link: created.shortUrl, reused: false };
}

/** POST /api/billing/checkout's work for the owner's account. */
export async function startCheckout(deps: Deps, scope: OwnerScope): Promise<CheckoutOutcome> {
  const locked = await withBillingLock(deps.db, scope.accountId, deps.clock.now(), () => checkoutLocked(deps, scope.accountId));
  return locked.type === 'busy' ? { type: 'busy' } : locked.value;
}
