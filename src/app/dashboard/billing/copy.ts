import type { BillingResultCode, SubscriptionView } from '@/server/views/billing';
import type { AccountProcessingState } from '@/server/domain/types';

// Every owner-facing sentence of the billing pages (PLAN §7.5, §9.9), in one place for laws 3 and 5
// (scanned by the D-37 copy rule): the price as it is, statuses in plain words, nothing promised that
// the build does not do (no refunds, no return from Razorpay's page, no automatic retry we run).

export const PRICE_LINE = '$49/month after your 14-day free trial.';

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function trialLine(trial: { readonly active: boolean; readonly daysLeft: number; readonly endsOn: string }): string {
  return trial.active ? `Free trial: ${plural(trial.daysLeft, 'day', 'days')} left (it ends on ${trial.endsOn}).` : `Your free trial ended on ${trial.endsOn}.`;
}

/** Is Autopilot running? Said plainly whenever it isn't, because of billing or anything else. */
export const RUNNING_TEXT: Readonly<Record<AccountProcessingState, string | null>> = {
  active: null,
  onboarding: null,
  paused: "You've paused Autopilot, so new leads aren't read or drafted. Billing doesn't change that.",
  inactive: "Autopilot isn't running because your free trial or subscription isn't active, so new leads aren't read or drafted.",
  revoked: "HubSpot is disconnected, so Autopilot can't read new leads until you reconnect, whatever your billing.",
  disconnected: "HubSpot is disconnected, so Autopilot can't read new leads until you reconnect, whatever your billing.",
};

export interface StatusCopy {
  readonly title: string;
  readonly lines: readonly string[];
}

/**
 * The subscription's status in plain words. `supportEmail` is where the owner writes when only a
 * person can sort billing out (a status Razorpay reported that we don't know).
 */
export function subscriptionCopy(subscription: SubscriptionView | null, supportEmail: string): StatusCopy {
  if (subscription === null) return { title: 'No subscription', lines: ["You haven't subscribed yet."] };
  switch (subscription.status) {
    case 'created':
      return { title: 'Checkout not finished', lines: ["You started a checkout on Razorpay's page but it isn't finished yet."] };
    case 'stale':
      return { title: 'Checkout not finished', lines: ["Your last checkout wasn't finished, so you're not subscribed."] };
    case 'expired':
      return { title: 'Checkout expired', lines: ['Your last checkout expired before it was finished, so you\'re not subscribed.'] };
    case 'authenticated':
      // Only a future start_at (the trial's end) means nothing has been charged yet. Without one,
      // Razorpay charges the first $49 when the card is authorised (D-20); never say otherwise.
      if (subscription.firstPaymentAhead && subscription.startsOn !== null) {
        return {
          title: 'Subscribed',
          lines: [
            `Your card is set up. The first $49 payment is taken on ${subscription.startsOn}, when your free trial ends.`,
            'If you cancel before then, nothing is charged and your free trial still runs to its end.',
          ],
        };
      }
      return {
        title: 'Subscribed',
        lines: [
          subscription.startsOn === null
            ? 'Your card is set up. The first $49 payment is taken when you subscribe, not at the end of a free trial.'
            : `Your card is set up. The first $49 payment was due on ${subscription.startsOn}.`,
          "Razorpay confirms the payment shortly; this page shows it once it has.",
        ],
      };
    case 'active':
      if (subscription.cancelAtCycleEnd) {
        return {
          title: 'Cancelled at the end of this period',
          lines: [
            subscription.periodEndsOn === null
              ? "Your subscription stays active until the end of the current billing period, then ends. It isn't renewed."
              : `Your subscription stays active until ${subscription.periodEndsOn}, then ends. It isn't renewed.`,
          ],
        };
      }
      return {
        title: 'Subscribed',
        lines: [subscription.periodEndsOn === null ? '$49/month.' : `$49/month. The current billing period ends on ${subscription.periodEndsOn}.`],
      };
    case 'pending':
      return {
        title: "Your last payment didn't go through",
        lines: [
          subscription.graceUntil === null
            ? "Autopilot has stopped while the payment is outstanding."
            : `Autopilot keeps running until ${subscription.graceUntil}. If the payment still hasn't gone through by then, it stops.`,
          'Razorpay tries the payment again. Update your payment method to fix it now.',
        ],
      };
    case 'halted':
      return {
        title: 'Payments failed',
        lines: ["Razorpay couldn't take your payment and has stopped trying, so Autopilot isn't running. Update your payment method to start again."],
      };
    case 'paused':
      return { title: 'Subscription paused', lines: ["Your subscription is paused, so Autopilot isn't running. Resume it to start again."] };
    case 'cancelled':
      return { title: 'Subscription cancelled', lines: ['Your subscription was cancelled. Subscribe to start again.'] };
    case 'completed':
      return { title: 'Subscription ended', lines: ['Your subscription has ended. Subscribe to start again.'] };
    case 'unknown':
      return {
        title: "We can't read your subscription's status",
        lines: [
          "Razorpay reported a status for your subscription that we don't recognise, so Autopilot isn't running and you can't start a new subscription here. We've been alerted.",
          `Please contact support at ${supportEmail} and we'll sort it out.`,
        ],
      };
  }
}

export const ACTION_TEXT = {
  subscribe: {
    label: 'Subscribe',
    pending: 'Opening checkout…',
    note: "You'll enter your card on Razorpay's secure page. When you've finished there, come back to this page.",
    // RZP-TRIAL-START-AT: a future-start subscription is authorised with a small charge Razorpay
    // refunds. The date is the start_at the checkout uses (an open checkout's own, D-82).
    billsAtTrialEnd: (firstPaymentOn: string): string =>
      `You set up your card now, and the first $49 payment is taken when your free trial ends on ${firstPaymentOn}. Razorpay may check the card with a small charge that it refunds.`,
    billsNow: 'The first $49 payment is taken when you subscribe.',
  },
  updatePayment: { label: 'Update payment method', note: "Opens Razorpay's page for your subscription, where you can pay with another card." },
  resume: { label: 'Resume subscription', pending: 'Resuming…' },
  /** `authenticated` with the first payment still ahead (a future start_at). */
  cancelTrial: {
    label: 'Cancel subscription',
    pending: 'Cancelling…',
    note: 'Cancels now: nothing is charged, and your free trial still runs to its end.',
  },
  /** `authenticated` whose first payment was due at sign-up (no start_at, or it has passed). */
  cancelAfterPayment: {
    label: 'Cancel subscription',
    pending: 'Cancelling…',
    note: "Cancels now: no further payments are taken. Cancelling doesn't refund a payment already taken.",
  },
  cancelActive: {
    label: 'Cancel subscription',
    pending: 'Cancelling…',
    note: "Your subscription stays active until the end of the current billing period, then ends. It isn't renewed.",
  },
  noLink: "Use the link in Razorpay's email about the failed payment to update your payment method.",
} as const;

export const CHECKOUT_OPEN_TEXT = {
  title: 'Waiting for Razorpay',
  line: "You have a checkout open. Once Razorpay confirms your payment, this page shows it: it checks again every few seconds.",
  manual: 'Check again',
} as const;

export const BILLING_RESULTS: Readonly<Record<BillingResultCode, { tone: 'success' | 'info' | 'warning'; text: string }>> = {
  busy: { tone: 'info', text: 'Another billing change is still in progress. Please try again in a few seconds.' },
  'checkout.unavailable': { tone: 'warning', text: "We couldn't open a checkout with Razorpay just now. Please try again in a minute." },
  'checkout.already_subscribed': { tone: 'info', text: "You're already subscribed, so there's nothing to pay now." },
  'checkout.payment_failed': { tone: 'warning', text: "Your subscription's last payment didn't go through. Update your payment method instead of subscribing again." },
  'checkout.paused': { tone: 'info', text: 'Your subscription is paused. Resume it instead of subscribing again.' },
  'checkout.contact_support': {
    tone: 'warning',
    text: "Your subscription is in a state we don't recognise, so we didn't start a new one (it could charge you twice). Please contact support; the address is below.",
  },
  'checkout.closing': {
    tone: 'warning',
    text: "HubSpot was disconnected more than 30 days ago, so this account is being deleted and can't start a subscription.",
  },
  'cancel.cancelled': { tone: 'success', text: 'Subscription cancelled. Nothing is charged, and your free trial runs to its end.' },
  'cancel.cancelled_after_payment': { tone: 'success', text: "Subscription cancelled. No further payments are taken; cancelling doesn't refund a payment already taken." },
  'cancel.scheduled': { tone: 'success', text: "Subscription cancelled. It stays active until the end of the current billing period and isn't renewed." },
  'cancel.already_scheduled': { tone: 'info', text: 'Your subscription is already set to end with the current billing period.' },
  'cancel.nothing': { tone: 'info', text: "You don't have a subscription to cancel." },
  'cancel.refused': { tone: 'warning', text: "Razorpay didn't accept the cancellation. The status below is what Razorpay says now." },
  'cancel.unavailable': { tone: 'warning', text: "We couldn't reach Razorpay just now, so nothing changed. Please try again in a minute." },
  'resume.resumed': { tone: 'success', text: 'Subscription resumed.' },
  'resume.nothing': { tone: 'info', text: "You don't have a paused subscription to resume." },
  'resume.refused': { tone: 'warning', text: "Razorpay didn't accept the resume. The status below is what Razorpay says now." },
  'resume.unavailable': { tone: 'warning', text: "We couldn't reach Razorpay just now, so nothing changed. Please try again in a minute." },
};

export const CONTINUE_TEXT = {
  title: 'Continue to Razorpay',
  description: "You'll enter your card on Razorpay's secure page. When you've finished there, come back to your billing page.",
  button: 'Continue to Razorpay',
  automatic: 'Taking you there now…',
  back: 'Back to billing',
  missingTitle: 'No checkout to continue',
  missing: 'This checkout has expired or is already finished. Your billing page shows where things stand.',
} as const;
