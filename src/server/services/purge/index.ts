import 'server-only';

// The account purge, orphan installs and the billing tombstones (PLAN §9.1 step 6, §9.10 steps 5-6,
// D-48). The account's daily job runs the orphan step and the purge; the daily cron runs the
// tombstone reconcile (the per-subscription rule is the billing service's, shared with its webhook).
export { authUserReferencedElsewhere, deletePurgedAuthUser, purgeAuthUser } from './auth-user';
export type { AuthUserOutcome } from './auth-user';
export { settleSubscriptionsForPurge } from './billing';
export type { SettledSubscriptions, TombstonePlan } from './billing';
export { loadPurgeState, ORPHAN_AFTER_MS, purgeEligible } from './eligibility';
export type { PurgeState } from './eligibility';
export { disconnectOrphan, ORPHAN_STATUS_REASON } from './orphan';
export type { OrphanOutcome } from './orphan';
export { purgeAccountIfDue } from './purge';
export type { PurgeOptions, PurgeOutcome } from './purge';
export { CANCEL_FIRST_STATUSES, MANUAL_CANCEL_STATUSES, normalizedStatus, TERMINAL_STATUSES, tombstoneResolved } from './statuses';
export { reconcileBillingTombstones, TOMBSTONE_RECONCILE_LIMIT } from './tombstones';
export type { TombstoneReconcileSummary } from './tombstones';
