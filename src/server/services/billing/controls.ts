import 'server-only';
import type { Deps } from '@/server/ports';
import type { OwnerScope } from '@/server/services/auth/owner-scope';
import { startCheckout, type CheckoutOutcome } from './checkout';
import { cancelSubscriptionForOwner, resumeSubscriptionForOwner, type CancelOutcome, type ResumeOutcome } from './manage';

// The billing page's three actions as one body (PLAN §7.3, §7.5, §9.9): the Server Actions
// (actions/billing) and the POST /api/billing/* route handlers both run it and redirect where it
// says (post/redirect/get), with the outcome as a code in the query, never any content. A checkout
// goes to our own /dashboard/billing/checkout page, which sends the owner on to Razorpay: a form
// POST must not end in a redirect to another origin (CSP form-action 'self', D-56).

export const BILLING_PATH = '/dashboard/billing';
export const BILLING_CHECKOUT_PATH = '/dashboard/billing/checkout';

export type BillingControl = 'checkout' | 'cancel' | 'resume';

/** Every `?result=` code /dashboard/billing can show (the page has the words). */
export const BILLING_RESULT_CODES = [
  'busy',
  'checkout.unavailable',
  'checkout.already_subscribed',
  'checkout.payment_failed',
  'checkout.paused',
  'checkout.contact_support',
  'checkout.closing',
  'cancel.cancelled',
  'cancel.cancelled_after_payment',
  'cancel.scheduled',
  'cancel.already_scheduled',
  'cancel.nothing',
  'cancel.refused',
  'cancel.unavailable',
  'resume.resumed',
  'resume.nothing',
  'resume.refused',
  'resume.unavailable',
] as const;
export type BillingResultCode = (typeof BILLING_RESULT_CODES)[number];

function withResult(code: BillingResultCode): string {
  return `${BILLING_PATH}?result=${code}`;
}

function checkoutPath(outcome: CheckoutOutcome): string {
  switch (outcome.type) {
    case 'checkout':
      return BILLING_CHECKOUT_PATH;
    case 'busy':
      return withResult('busy');
    case 'unavailable':
      return withResult('checkout.unavailable');
    case 'closing':
      return withResult('checkout.closing');
    case 'blocked':
      switch (outcome.status) {
        case 'pending':
        case 'halted':
          return withResult('checkout.payment_failed');
        case 'paused':
          return withResult('checkout.paused');
        case 'unknown':
          return withResult('checkout.contact_support');
        case 'authenticated':
        case 'active':
          return withResult('checkout.already_subscribed');
      }
  }
}

function cancelResult(outcome: CancelOutcome): BillingResultCode {
  // An `authenticated` subscription cancelled after its first payment was due (no start_at, or a
  // start_at already past) must not be told "nothing is charged" (laws 3 and 5).
  if (outcome.type === 'cancelled') return outcome.beforeFirstPayment ? 'cancel.cancelled' : 'cancel.cancelled_after_payment';
  return CANCEL_RESULTS[outcome.type];
}

const CANCEL_RESULTS: Readonly<Record<Exclude<CancelOutcome['type'], 'cancelled'>, BillingResultCode>> = {
  cancel_scheduled: 'cancel.scheduled',
  already_scheduled: 'cancel.already_scheduled',
  nothing_to_cancel: 'cancel.nothing',
  refused: 'cancel.refused',
  unavailable: 'cancel.unavailable',
  busy: 'busy',
};

const RESUME_RESULTS: Readonly<Record<ResumeOutcome['type'], BillingResultCode>> = {
  resumed: 'resume.resumed',
  nothing_to_resume: 'resume.nothing',
  refused: 'resume.refused',
  unavailable: 'resume.unavailable',
  busy: 'busy',
};

/** Runs one billing action for the owner's account; returns the path to redirect to. */
export async function runBillingControl(deps: Deps, scope: OwnerScope, control: BillingControl): Promise<string> {
  switch (control) {
    case 'checkout':
      return checkoutPath(await startCheckout(deps, scope));
    case 'cancel':
      return withResult(cancelResult(await cancelSubscriptionForOwner(deps, scope)));
    case 'resume':
      return withResult(RESUME_RESULTS[(await resumeSubscriptionForOwner(deps, scope)).type]);
  }
}
