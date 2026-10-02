import 'server-only';

// The HubSpot install (PLAN §7.3, §9.1 step 1, D-35): the start (rate limit, state cookie, consent
// redirect) and the callback (branches a-d), plus the pending_install cookie /onboarding/email reads.
export { completeInstall, TRIAL_MS } from './callback';
export type { CallbackInput, CallbackOptions, InstallFailureReason, InstallOutcome } from './callback';
export {
  clearStateCookie,
  issuePendingInstallCookie,
  issueStateCookie,
  PENDING_INSTALL_COOKIE_NAME,
  PENDING_INSTALL_TTL_MS,
  readPendingInstall,
  secureCookies,
  signCookieValue,
  STATE_COOKIE_NAME,
  STATE_COOKIE_TTL_MS,
  verifyCookieValue,
  verifyState,
} from './cookies';
export type { PendingInstall } from './cookies';
export { RECONNECT_NEXT, sendReconnectMagicLink } from './reconnect-magic-link';
export type { ReconnectMagicLinkInput, SendReconnectMagicLink } from './reconnect-magic-link';
export { INSTALL_RATE_LIMIT, INSTALL_RATE_WINDOW_MS, startInstall } from './start';
export type { StartInstallResult } from './start';
export { resolveTimezone } from './timezone';
export type { ResolvedTimezone } from './timezone';
