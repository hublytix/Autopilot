import 'server-only';

// Auth route handlers and page guards (PLAN §7.2, §7.5): /auth/confirm (GET page, POST verify),
// /auth/signout, and requireOwnerPage/requireAdminPage/onboardingAccess for Server Components.
export { AUTH_ERROR_PATH, crossOriginPage, handleConfirmGet, handleConfirmPost } from './confirm';
export type { AuthErrorReason } from './confirm';
export { LOGIN_PATH, onboardingAccess, ownerFromHeaders, requireAdminPage, requireAdminRequest, requireOwnerPage } from './guards';
export type { OnboardingAccess } from './guards';
export { escapeHtml, htmlPage } from './html';
export { onboardingEmailPageState } from './onboarding-email';
export type { OnboardingEmailContext } from './onboarding-email';
export { PRIVATE_HEADERS, requestFromHeaders } from './request';
export type { HeadersLike } from './request';
export { handleSignOut, SIGNED_OUT_PATH } from './signout';
