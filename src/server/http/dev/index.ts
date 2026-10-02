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
