import 'server-only';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { checkoutTiming, DAY_MS, firstPaymentAhead, isReusableCheckout, isUsableCheckoutLink, type CheckoutConfig } from '@/server/domain/checkout-guard';
import { currentSubscription } from '@/server/domain/entitlement';
import { ACCOUNT_PROCESSING_STATES, type AccountProcessingState, type SubscriptionStatus } from '@/server/domain/types';
import type { Deps } from '@/server/ports';
import type { OwnerScope } from '@/server/services/auth/owner-scope';
import { loadAccountSubscriptions, type SubscriptionRow } from '@/server/services/billing/rows';

// The billing page's read model (PLAN §3 views/, §7.5, §9.9): read through the OwnerScope's account
// only, from our own rows (no Razorpay call on a page view; webhooks and the reconcile keep them
// current). It says where the trial stands, which subscription matters (the current one, as
// entitlement picks it: the newest that still holds a mandate, else the newest, D-81), and the one
// action that fits: Subscribe, Update payment method (the stored link), Resume or Cancel. When the
// first $49 is taken comes from the row itself (its start_at, D-82): an `authenticated` row without
// a future start_at was charged at authorisation, and an open checkout keeps the start_at it was
// created with.

export type BillingAction = 'subscribe' | 'update_payment' | 'resume' | 'cancel' | 'none';

export interface SubscriptionView {
  readonly status: SubscriptionStatus;
  /** `authenticated`: the start_at date (when the first payment is or was due), if it has one. */
  readonly startsOn: string | null;
  /**
   * `authenticated` with a start_at still ahead: nothing has been charged yet. False without a
   * start_at (Razorpay charges the first $49 when the card is authorised) or once it has passed.
   */
  readonly firstPaymentAhead: boolean;
  /** The end of the current billing period (`active`), e.g. when a scheduled cancel takes effect. */
  readonly periodEndsOn: string | null;
  readonly cancelAtCycleEnd: boolean;
  /** `pending`: until when Autopilot keeps running (date and time); null after it. */
  readonly graceUntil: string | null;
}

export interface BillingPageView {
  /** The zone dates are shown in (UTC when the account's is unknown). */
  readonly zone: string;
  readonly processingState: AccountProcessingState;
  readonly trial: { readonly active: boolean; readonly daysLeft: number; readonly endsOn: string };
  readonly subscription: SubscriptionView | null;
  readonly action: BillingAction;
  /** The stored hosted link behind "Update payment method" (`pending`/`halted`). */
  readonly updatePaymentLink: string | null;
  /** A checkout is open (a reusable `created` subscription): the page checks again by itself. */
  readonly checkoutOpen: boolean;
  /**
   * Subscribe now: the date the first $49 is taken, or null when it is taken at once. The open
   * checkout Subscribe would reuse decides it (its own start_at); without one, D-20's rule for a new
   * subscription (the trial's end with more than a day of it left).
   */
  readonly subscribeFirstPaymentOn: string | null;
  /** `subscribeFirstPaymentOn !== null`. */
  readonly subscribeBillsAtTrialEnd: boolean;
  /** Where the owner writes when billing needs a person (an `unknown` status): D-27's Reply-To. */
  readonly supportEmail: string;
}

const accountSchema = z.object({
  processing_state: z.enum(ACCOUNT_PROCESSING_STATES),
  trial_ends_at: z.date(),
  timezone: z.string().nullable(),
});

function zoneOf(timezone: string | null): string {
  if (timezone === null || timezone.trim() === '') return 'UTC';
  return DateTime.fromMillis(0, { zone: timezone }).isValid ? timezone : 'UTC';
}

function dateIn(at: Date, zone: string): string {
  return DateTime.fromJSDate(at, { zone }).setLocale('en-GB').toFormat('d LLL yyyy');
}

function dateTimeIn(at: Date, zone: string): string {
  return DateTime.fromJSDate(at, { zone }).setLocale('en-GB').toFormat('d LLL yyyy, HH:mm');
}


function actionFor(row: SubscriptionRow | null, appUrl: string): { action: BillingAction; link: string | null } {
  if (row === null) return { action: 'subscribe', link: null };
  switch (row.status) {
    case 'authenticated':
      return { action: 'cancel', link: null };
    case 'active':
      return { action: row.cancelAtCycleEnd ? 'none' : 'cancel', link: null };
    case 'pending':
    case 'halted':
      return isUsableCheckoutLink(row.shortUrl, appUrl) ? { action: 'update_payment', link: row.shortUrl } : { action: 'none', link: null };
    case 'paused':
      return { action: 'resume', link: null };
    case 'unknown':
      // Razorpay reported a status we don't know: no new checkout (it may hold a mandate); support.
      return { action: 'none', link: null };
    default:
      return { action: 'subscribe', link: null };
  }
}

function checkoutConfig(deps: Deps): CheckoutConfig {
  return { planId: deps.env.RAZORPAY_PLAN_ID, appUrl: deps.env.APP_URL };
}

/** /dashboard/billing for the owner's account. Null when the account is gone. */
export async function billingPageView(deps: Deps, scope: OwnerScope): Promise<BillingPageView | null> {
  const raw = await deps.db.maybeOne(`select processing_state, trial_ends_at, timezone from accounts where id = $1`, [scope.accountId]);
  if (raw === null) return null;
  const account = accountSchema.parse(raw);
  const now = deps.clock.now();
  const zone = zoneOf(account.timezone);
  const rows = await loadAccountSubscriptions(deps.db, scope.accountId);
  const row = currentSubscription(rows);
  const { action, link } = actionFor(row, deps.env.APP_URL);
  const msLeft = account.trial_ends_at.getTime() - now.getTime();
  const open = openCheckout(rows, now, checkoutConfig(deps));
  const firstPaymentAt = open !== null ? (firstPaymentAhead(open.startAt, now) ? open.startAt : null) : checkoutTiming(account.trial_ends_at, now).startAt;

  return {
    zone,
    processingState: account.processing_state,
    trial: { active: msLeft > 0, daysLeft: msLeft > 0 ? Math.ceil(msLeft / DAY_MS) : 0, endsOn: dateIn(account.trial_ends_at, zone) },
    subscription:
      row === null
        ? null
        : {
            status: row.status,
            startsOn: row.status === 'authenticated' && row.startAt !== null ? dateIn(row.startAt, zone) : null,
            firstPaymentAhead: row.status === 'authenticated' && firstPaymentAhead(row.startAt, now),
            periodEndsOn: row.status === 'active' && row.currentEnd !== null ? dateIn(row.currentEnd, zone) : null,
            cancelAtCycleEnd: row.cancelAtCycleEnd,
            graceUntil: row.status === 'pending' && row.graceUntil !== null && row.graceUntil.getTime() > now.getTime() ? dateTimeIn(row.graceUntil, zone) : null,
          },
    action,
    updatePaymentLink: link,
    checkoutOpen: open !== null,
    subscribeFirstPaymentOn: firstPaymentAt === null ? null : dateIn(firstPaymentAt, zone),
    subscribeBillsAtTrialEnd: firstPaymentAt !== null,
    supportEmail: deps.env.EMAIL_REPLY_TO,
  };
}

/** The open checkout Subscribe would reuse (the checkout guard's choice: the newest reusable row), or null. */
function openCheckout(rows: readonly SubscriptionRow[], now: Date, config: CheckoutConfig): SubscriptionRow | null {
  return rows.filter((row) => isReusableCheckout(row, now, config)).at(-1) ?? null;
}

/**
 * /dashboard/billing/checkout: the open checkout's hosted link for the owner's account (the one the
 * checkout just created or reused), or null when there is none any more (expired, finished).
 */
export async function openCheckoutLink(deps: Deps, scope: OwnerScope): Promise<string | null> {
  const rows = await loadAccountSubscriptions(deps.db, scope.accountId);
  return openCheckout(rows, deps.clock.now(), checkoutConfig(deps))?.shortUrl ?? null;
}
