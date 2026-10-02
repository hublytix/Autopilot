import { FAKE_ANTHROPIC_KEY, FAKE_JWT, FAKE_RAZORPAY_KEY, FAKE_SUPABASE_SECRET } from '../support/fake-secrets';

// Sensitive fixture values for the observability proof tests (PLAN §11). They live in their own
// module so that no test source line around a throw site contains them (ContextLines would
// otherwise ship them as pre_context; the shared options also set frameContextLines: 0).

/** Lead message text: content that must never reach logs or Sentry (law 4). */
export const LEAD_MESSAGE = 'FIXTURE_LEAD_MESSAGE_42 Hi, I need a quote for 40 chairs, call me at 555-0100';
export const LEAD_MESSAGE_MARKERS = ['FIXTURE_LEAD_MESSAGE_42', 'quote for 40 chairs', '555-0100'];

export const LEAD_EMAIL = 'lead.fixture-7f3a@example.com';
export const OWNER_EMAIL = 'owner.fixture-7f3a@example.org';
export const DRAFT_BODY = 'FIXTURE_DRAFT_BODY_77 Thanks for reaching out about the chairs';

export const ACTION_TOKEN = 'apt_Zx9QvB3kLmN0pR5tUw8yA1cE4gH7jK2oS6vX0zB3dF5';
export const HUBSPOT_ACCESS_TOKEN = ['CIrToaiiMhIHAAEAQAAAARiO1ooB', 'IOP0sgEokuLtAEaOaTFnToZ3VjUbtl46MAAAAEAAAAAgAAAA'].join('');
export const HUBSPOT_REFRESH_TOKEN = ['na1', '1f2e-3d4c-5b6a-7980-a1b2c3d4e5f6'].join('-');
export const RESEARCH_TOKEN = 'hsat_SECRET_ACCESS_TOKEN_123';
export const SUPABASE_SECRET = FAKE_SUPABASE_SECRET;
export const ANTHROPIC_KEY = FAKE_ANTHROPIC_KEY;
export const RAZORPAY_KEY = FAKE_RAZORPAY_KEY;
export const SESSION_COOKIE = 'ap_session=c2Vzc2lvbi1maXh0dXJlLTdmM2EuZXlKaGJHY2lPaUpJVXpJMU5pSjk';
export const JWT = FAKE_JWT;
export const OAUTH_CODE = 'fixture-oauth-code-7f3a';
export const OAUTH_STATE = 'fixture-oauth-state-7f3a';
export const MAGIC_LINK_HASH = 'pkce_fixturehash7f3a9b2c';
export const SHA256_HEX = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

/** Every value that must be absent from a serialised log line or Sentry envelope. */
export const FORBIDDEN = [
  ...LEAD_MESSAGE_MARKERS,
  LEAD_EMAIL,
  OWNER_EMAIL,
  'FIXTURE_DRAFT_BODY_77',
  ACTION_TOKEN,
  ACTION_TOKEN.slice(4),
  HUBSPOT_ACCESS_TOKEN,
  HUBSPOT_REFRESH_TOKEN,
  RESEARCH_TOKEN,
  SUPABASE_SECRET,
  ANTHROPIC_KEY,
  RAZORPAY_KEY,
  SESSION_COOKIE.split('=')[1] ?? SESSION_COOKIE,
  JWT,
  OAUTH_CODE,
  OAUTH_STATE,
  MAGIC_LINK_HASH,
  SHA256_HEX,
];

/** The first forbidden value found in `text`, or undefined. */
export function findForbidden(text: string, forbidden: readonly string[] = FORBIDDEN): string | undefined {
  return forbidden.find((value) => text.includes(value));
}
