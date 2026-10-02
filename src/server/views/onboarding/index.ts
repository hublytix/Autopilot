import 'server-only';

// Read models for the onboarding pages (PLAN §3 views/, §7.4, §7.5). Each takes the OwnerScope
// (the verify-notify page takes its action token instead).
export { baselinePageView } from './baseline';
export type { BaselinePageView } from './baseline';
export { briefPageView } from './brief';
export type { BriefPageView } from './brief';
export { formsPageView } from './forms';
export type { FormsPageView } from './forms';
export { preferencesPageView } from './preferences';
export type { PreferencesPageView } from './preferences';
export { onboardingStatus } from './status';
export type { OnboardingStatusDto } from './status';
export { verifyNotifyPageState } from './verify-notify';
export type { VerifyNotifyState } from './verify-notify';
