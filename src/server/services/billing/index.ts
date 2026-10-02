import 'server-only';

// Billing (PLAN §9.9, D-18 to D-20): Razorpay subscriptions behind the Billing port. Checkout, cancel
// and resume for the owner; the webhook's fetch-and-apply; the tombstone reconcile for purged
// accounts. The pure rules (guard, reuse, timing, status mapping, grace) live in
// domain/checkout-guard.ts and are re-exported here; entitlement is pure too (domain/entitlement.ts)
// and applyProcessingState (services/accounts) acts on it. The billing page's read model is
// views/billing.
export { applySnapshotInTx, markStaleInTx } from './apply';
export type { AppliedSnapshot, ApplyOutcome, ApplySnapshotInput } from './apply';
export { startCheckout } from './checkout';
export type { CheckoutOutcome } from './checkout';
export { BILLING_CHECKOUT_PATH, BILLING_PATH, BILLING_RESULT_CODES, runBillingControl } from './controls';
export type { BillingControl, BillingResultCode } from './controls';
export { BILLING_LOCK_MS, releaseBillingLock, takeBillingLock, withBillingLock } from './lock';
export { cancelSubscriptionForOwner, resumeSubscriptionForOwner } from './manage';
export type { CancelOutcome, ResumeOutcome } from './manage';
export { loadAccountSubscriptions, loadSubscriptionByProviderId, parseSubscriptionRow } from './rows';
export type { SubscriptionRow } from './rows';
export {
  appliedStatus,
  CHECKOUT_BLOCKING_STATUSES,
  CHECKOUT_LINK_TTL_MS,
  checkoutGuard,
  checkoutTiming,
  GRACE_MS,
  graceAfter,
  firstPaymentAhead,
  isBlockingStatus,
  isLiveStatus,
  isReusableCheckout,
  isTerminalStatus,
  isUsableCheckoutLink,
  LIVE_STATUSES,
  mapRazorpayStatus,
  SUBSCRIPTION_TOTAL_COUNT,
  TERMINAL_STATUSES,
} from '@/server/domain/checkout-guard';
export type { BlockingStatus, CheckoutConfig, CheckoutDecision, CheckoutTiming, GraceInput, GuardRow, MappedStatus } from '@/server/domain/checkout-guard';
export { applyFetched, enforceOneLiveSubscription, syncSubscription } from './sync';
export { loadTombstone, reconcileTombstone } from './tombstone';
export type { TombstoneOutcome, TombstoneRow } from './tombstone';
export { processRazorpayWebhook, razorpayDedupeKey, RAZORPAY_WEBHOOK_MAX_AGE_MS, RAZORPAY_WEBHOOK_MAX_FUTURE_MS } from './webhook';
export type { RazorpayWebhookInput, RazorpayWebhookOutcome, RazorpayWebhookResult } from './webhook';
