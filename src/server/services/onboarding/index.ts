import 'server-only';

// Onboarding (brief §4, PLAN §6.1, §7.4, §7.5, D-07, D-12, D-33, D-46, D-48): form selection with
// newsletter detection, preferences with notify-address verification and change alerts, and the
// onboarding-complete gate. The brief editor lives in services/brief, the baseline in
// services/baseline. Import from here.
export {
  formatChangedOn,
  isSettingsChangeAlertKey,
  parseSettingsChangeAlertKey,
  resumeSettingsChangeAlert,
  SETTINGS_CHANGE_ALERT_KIND,
  SETTINGS_PATH,
  settingsChangeAlertKey,
  settingsChangeAlertPlan,
} from './change-alerts';
export { FormSelectionSchema, listFormsForSelection, saveFormSelection, selectedFormCount } from './forms';
export type { FormChoice, FormSelectionRefusal, FormSelectionResult, FormsListResult, FormsOptions, FormsUnavailableReason } from './forms';
export { completeOnboarding, getOnboardingGate, ONBOARDING_REQUIREMENTS } from './gate';
export type { CompleteOnboardingResult, OnboardingGate, OnboardingRequirement } from './gate';
export { isLikelyNewsletter, newsletterSignal } from './newsletter';
export type { NewsletterFormInput, NewsletterSignal } from './newsletter';
export { registerOnboardingNotifications } from './notifications';
export {
  ACTION_LINK_LIMITS,
  addressHmac,
  confirmNotifyAddress,
  hitActionLinkLimits,
  parseVerifyNotifyKey,
  resumeVerifyNotify,
  VERIFY_LINK_VALID_DAYS,
  verifyNotifyKey,
  verifyNotifyLinkState,
  verifyNotifyPath,
  verifyNotifyPlan,
} from './notify-verification';
export type { VerifyNotifyRequest, VerifyNotifyState } from './notify-verification';
export {
  getPreferences,
  isValidTimezone,
  looksLikeHubSpotBcc,
  MAX_NOTIFY_EMAILS,
  PreferencesInputSchema,
  savePreferences,
  validatePreferences,
  VERIFY_EMAILS_PER_DAY,
} from './preferences';
export type {
  NotifyAddressView,
  PreferenceIssue,
  PreferenceIssueCode,
  PreferencesInput,
  PreferencesView,
  SavedPreferences,
  SavePreferencesResult,
  ValidationContext,
  ValidPreferences,
} from './preferences';
export { allowedHoursPerWeek, DEFAULT_QUIET_END_HOUR, DEFAULT_QUIET_START_HOUR, isQuietHour, isValidHour } from './quiet-hours';
