import 'server-only';

// The billing pages' read models (PLAN §3 views/, §7.5): /dashboard/billing and its checkout hop.
// Each takes the OwnerScope. The paths and result codes the pages link to come with them.
export { billingPageView, openCheckoutLink } from './billing';
export type { BillingAction, BillingPageView, SubscriptionView } from './billing';
export { BILLING_CHECKOUT_PATH, BILLING_PATH, BILLING_RESULT_CODES } from '@/server/services/billing/controls';
export type { BillingResultCode } from '@/server/services/billing/controls';
