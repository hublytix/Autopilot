import 'server-only';

// The /dev routes (fake mode only; 404 otherwise; PLAN §7.6). Route and page files stay thin.
export { devNotFound, devToolsEnabled, getDevContext } from './guard';
export type { DevContext } from './guard';
export {
  buildConsentView,
  FAKE_HUBSPOT_AUTHORIZE_PATH,
  FAKE_HUBSPOT_DECISION_PATH,
  fakeHubSpotConsentView,
  handleFakeHubSpotDecision,
  handleFakeHubSpotDecisionOtherMethod,
} from './fake-hubspot';
export type { AuthorizeRejection, AuthorizeRequest, ConsentPortal, ConsentView, SearchParamsRecord } from './fake-hubspot';
export { DEV_ACTION_PATH, DEV_EMAIL_PATH, DEV_PANEL_PATH, FAKE_CHECKOUT_BASE_PATH } from './context';
export type { DevPanelClock, DevPanelContext, FakeStartingState } from './context';
export { ADVANCE_UNITS, buildDevPanelView, DEV_ACTIONS, DEV_ERRORS, devResult, formatInstant } from './panel';
export type { AdvanceUnit, DevAccount, DevAction, DevContact, DevError, DevForm, DevOutboxRow, DevPanelView, DevResult, DevSubscription } from './panel';
export { handleDevAction, handleDevActionOtherMethod, runDueJobsNow } from './dev-actions';
export { buildDevOutboxMail, withNewTabLinks } from './outbox';
export type { DevOutboxMail } from './outbox';
export { resetFakeState, truncateAllTables } from './reset';
