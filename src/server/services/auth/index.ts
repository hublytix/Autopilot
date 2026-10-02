import 'server-only';

// Sign-in and ownership (PLAN §7.2, §9.1 step 2, §10.3, D-22, D-35, D-36): magic links with login
// intents, /login, POST /auth/confirm (with the one-statement owner bind), the onboarding email step,
// and requireOwner/requireAdmin, the only source of an OwnerScope. Import from here.
export { bindOwner, confirmMagicLink } from './confirm';
export type { BindResult, ConfirmInput, ConfirmOutcome } from './confirm';
export {
  ADMIN_HOME,
  LOGIN_LATENCY_FLOOR_MS,
  LOGIN_NEUTRAL_MESSAGE,
  normaliseEmail,
  ONBOARDING_NEXT,
  OWNER_HOME,
  requestLoginLink,
} from './login';
export type { LoginInput, LoginOptions, LoginResult } from './login';
export { consumeLoginIntent, insertLoginIntent, LOGIN_LINK_TTL_MS, loginIntentKey } from './login-intents';
export type { ConsumedLoginIntent, NewLoginIntent } from './login-intents';
export { CONFIRM_PATH, deliverMagicLink, ensureAuthUser, issueMagicLink, magicLinkUrl, sendMagicLink } from './magic-link';
export type { IssuedMagicLink, MagicLinkRequest } from './magic-link';
export { DEFAULT_NEXT_PATH, safeNextPath } from './next-path';
export { onboardingEmailContext, PENDING_OWNER_TTL_MS, submitOnboardingEmail } from './onboarding-email';
export type { OnboardingEmailContext, OnboardingEmailInput, OnboardingEmailOutcome } from './onboarding-email';
export {
  AdminRequiredError,
  createOwnerScopeForTest,
  isAdminEmail,
  isAdminRequiredError,
  isOwnerRequiredError,
  OwnerRequiredError,
  requireAdmin,
  requireOwner,
  resolveAdmin,
  resolveOwner,
} from './owner-scope';
export type { OwnerScope } from './owner-scope';
export { AUTH_RATE_LIMITS, AUTH_RATE_WINDOW_MS, hitAuthLimit, takeInstallEmailSlot } from './rate-limits';
export type { AuthRoute, LimitCheck } from './rate-limits';
