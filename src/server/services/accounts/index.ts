import 'server-only';

// Account lifecycle: the derived processing state (PLAN §6.1) and the account-level owner emails.
export { applyProcessingState, applyProcessingStateInTx, PURGE_AFTER_MS } from './apply-processing-state';
export type { AppliedProcessingState } from './apply-processing-state';
export {
  accountLocalDate,
  billingInactivePlan,
  ensureAccountNotificationsRegistered,
  formatAccountDate,
  HUBSPOT_INSTALL_PATH,
  ownerAlertKey,
  ownerAlertPlan,
  parseReconnectKey,
  reconnectPlan,
  registerAccountNotifications,
} from './emails';
export type { OwnerAlertKind } from './emails';
export { mergePostCommitWork, NO_POST_COMMIT_WORK, runPostCommitWork } from './post-commit';
export type { PostCommitWork } from './post-commit';
