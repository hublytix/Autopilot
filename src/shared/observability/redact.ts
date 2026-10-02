// One shared redaction for logs and Sentry (PLAN §10.10, §11; D-23; law 4). Client- and
// server-safe: no `server-only`, no Node APIs.
//
// redact() masks secrets and personal data that have a recognisable shape: URLs' query strings,
// fragments and credentials, action-link path tokens (/a/<token>/…), emails, Authorization
// values, JWTs, our own ciphertexts, vendor keys (sb_secret_, sk-ant-, rzp_, re_, sig_, …),
// HubSpot tokens, key=value secrets and long hex/base64 strings. It cannot recognise free text
// such as a lead's message: callers must keep content out entirely (allow-listed log fields,
// code-only error messages; see scrub.ts and src/server/obs/log.ts).

export const REDACTED = '[redacted]';
export const ACTION_TOKEN_PLACEHOLDER = '[token]';

/**
 * Machine-readable strings that are safe to keep verbatim (log `msg` values, breadcrumb
 * categories): lower-case, no spaces, at most 64 characters, and nothing redact() would mask.
 * Token-like shapes are refused even when they look code-like: long hex or digit runs (hashes,
 * ids, phone numbers) and HubSpot hublet-prefixed tokens (`na1-…`).
 */
const SAFE_CODE = /^[a-z][a-z0-9_.:-]{0,63}$/;
const LONG_HEX_RUN = /[0-9a-f]{16,}/i;
const LONG_DIGIT_RUN = /\d{5,}/;
const HUBLET_TOKEN = /^(?:pat-)?(?:na|eu|ap)\d/;

export function isSafeCode(value: string): boolean {
  return (
    SAFE_CODE.test(value) &&
    !LONG_HEX_RUN.test(value) &&
    !LONG_DIGIT_RUN.test(value) &&
    !HUBLET_TOKEN.test(value) &&
    redact(value) === value
  );
}

/**
 * An error code as our errors carry them (`db_error`, `crypto_auth_failed`): snake_case with at
 * least one underscore. The underscore is what tells a code from a lone word that could be a
 * lead's first name, and the snake_case shape refuses domains, paths and dashed tokens. Exception
 * values and breadcrumb messages are kept only when they pass this (scrub.ts).
 */
const ERROR_CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

export function isSafeErrorCode(value: string): boolean {
  return ERROR_CODE.test(value) && isSafeCode(value);
}

// ---------------------------------------------------------------------------------------------
// URLs and paths
// ---------------------------------------------------------------------------------------------

// The first path segment after /a/ is an owner action token (PLAN §7.4, D-45).
const ACTION_PATH_START = /^\/a\/[^/?#]+/;

function maskQueryAndFragment(rest: string): string {
  if (rest === '') return '';
  return (rest.startsWith('?') ? `?${REDACTED}` : '') + (rest.includes('#') ? `#${REDACTED}` : '');
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function redactSegment(segment: string): string {
  if (segment === '' || segment === ACTION_TOKEN_PLACEHOLDER) return segment;
  const decoded = safeDecode(segment);
  const masked = redactTokens(decoded);
  return masked === decoded ? segment : masked;
}

/** A path with the action token replaced, token-shaped segments masked, query and fragment masked. */
export function sanitizePath(path: string): string {
  const cut = path.search(/[?#]/);
  const pathname = cut === -1 ? path : path.slice(0, cut);
  const rest = cut === -1 ? '' : path.slice(cut);
  const masked = pathname
    .replace(ACTION_PATH_START, `/a/${ACTION_TOKEN_PLACEHOLDER}`)
    .split('/')
    .map(redactSegment)
    .join('/');
  return masked + maskQueryAndFragment(rest);
}

/**
 * A URL reduced to scheme, host and sanitised path: credentials, query string and fragment are
 * masked and the action token is replaced. Strings without a scheme are sanitised as paths.
 * Opaque links (mailto:, tel:) and anything unparseable keep only their scheme.
 */
export function sanitizeUrl(raw: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
  if (scheme === null) return sanitizePath(raw);
  if (!raw.slice(scheme[0].length).startsWith('//')) return `${scheme[1]}:${REDACTED}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `${scheme[1]}:${REDACTED}`;
  }
  const credentials = url.username !== '' || url.password !== '' ? `${REDACTED}@` : '';
  const tail = (url.search !== '' ? `?${REDACTED}` : '') + (url.hash !== '' ? `#${REDACTED}` : '');
  return `${url.protocol}//${credentials}${url.host}${sanitizePath(url.pathname)}${tail}`;
}

// ---------------------------------------------------------------------------------------------
// Free text
// ---------------------------------------------------------------------------------------------

type Replacer = (match: string, ...groups: string[]) => string;
type Rule = readonly [RegExp, string | Replacer];

// Every pattern starts at the beginning of a run (a lookbehind or a literal prefix), so a long
// input cannot make the engine retry a quantifier from every position inside it.
const URL_RULES: readonly Rule[] = [
  // Absolute URLs (any scheme with an authority, incl. postgres://user:pass@…).
  [/(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi, (match) => sanitizeUrl(match)],
  // Opaque links carry their payload after the colon (compose links: mailto:lead@…?body=…).
  [/(?<![a-z0-9+.-])(mailto|tel|sms):[^\s"'<>`]+/gi, (_m, scheme: string) => `${scheme}:${REDACTED}`],
  // Relative paths: mask a query string or fragment.
  [
    /(^|[\s"'(=,])(\/[^\s"'?#<>]*)([?#][^\s"'<>]*)/g,
    (_m, lead: string, path: string, rest: string) => `${lead}${path}${maskQueryAndFragment(rest)}`,
  ],
  // Relative action-link paths: /a/<token>/send → /a/[token]/send.
  [
    /(^|[^\w.-])\/a\/(?!\[token\](?=[/?#\s"'<>]|$))[^/\s?#"'<>]+/g,
    (_m, lead: string) => `${lead}/a/${ACTION_TOKEN_PLACEHOLDER}`,
  ],
];

// Key names that mark their value as a secret (query strings in free text, cookies, JSON).
const SECRET_KEY_PART = /token|secret|passw|pwd|session|auth|signature|cookie|api_?key|credential/i;
const SECRET_KEY_EXACT = /^(?:code|state|th|sig|key)$/i;

function isSecretKeyName(key: string): boolean {
  return SECRET_KEY_EXACT.test(key) || SECRET_KEY_PART.test(key);
}

const TOKEN_RULES: readonly Rule[] = [
  [/\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]*/gi, '[jwt]'],
  // Our own token ciphertexts (D-51).
  [/\bv1\.[0-9a-f]{8}\.[a-z0-9_-]+\.[a-z0-9_-]*\.[a-z0-9_-]+/gi, '[ciphertext]'],
  // Vendor credentials and tokens with documented prefixes.
  [/\bapt_[a-z0-9_-]{6,}/gi, `apt_${REDACTED}`],
  [/\bsb_(secret|publishable)_[a-z0-9_-]+/gi, (_m, kind: string) => `sb_${kind}_${REDACTED}`],
  // Written so the client bundle never contains the literal key prefixes that the CI bundle
  // check (scripts/check-bundle.ts) greps for: the prefix is kept from the match.
  [/\b(sk-an[t]-)[a-z0-9_-]+/gi, (_m, prefix: string) => `${prefix}${REDACTED}`],
  [/\brzp_(test|live)_[a-z0-9]+/gi, (_m, mode: string) => `rzp_${mode}_${REDACTED}`],
  [/\bre_[a-z0-9_]{8,}/gi, `re_${REDACTED}`],
  [/\bsig_[a-z0-9]{8,}/gi, `sig_${REDACTED}`],
  [/\bsntry[su]_[a-z0-9_=]+/gi, REDACTED],
  [/\bhsat_[a-z0-9_]+/gi, REDACTED],
  // HubSpot refresh tokens carry the hublet prefix (na1-…), private-app tokens pat-na1-…; fake tokens.
  [/\b(?:pat-)?(?:na|eu|ap)\d{1,2}-[a-z0-9-]{8,}/gi, REDACTED],
  [/\bfake-hs-(?:access|code)-[a-z0-9-]+/gi, REDACTED],
  [/(?<![a-z0-9._%+-])[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi, '[email]'],
  [/\b(bearer)(\s+)[a-z0-9._~+/=-]+/gi, (_m, scheme: string, space: string) => `${scheme}${space}${REDACTED}`],
  [/\b(Basic)(\s+)[A-Za-z0-9+/]{12,}={0,2}/g, (_m, scheme: string, space: string) => `${scheme}${space}${REDACTED}`],
  [
    /(?<![a-z0-9_.-])([a-z0-9_.-]+)=([^&\s"';,]+)/gi,
    (match, key: string) => (isSecretKeyName(key) ? `${key}=${REDACTED}` : match),
  ],
  [
    /"([^"\\\s]{1,64})"(\s*:\s*)"(?:[^"\\]|\\.)*"/g,
    (match, key: string, colon: string) => (isSecretKeyName(key) ? `"${key}"${colon}"${REDACTED}"` : match),
  ],
  // Long hex (hashes, raw keys) and long mixed-case base64/base64url strings with digits.
  [/\b[0-9a-f]{32,}\b/gi, '[hex]'],
  [
    /(?<![a-z0-9_+/=-])[a-z0-9_+/-]{32,}={0,2}(?![a-z0-9_+/=-])/gi,
    (match) => (/[a-z]/.test(match) && /[A-Z]/.test(match) && /[0-9]/.test(match) ? '[secret]' : match),
  ],
];

function applyRules(value: string, rules: readonly Rule[]): string {
  let out = value;
  for (const [pattern, replacement] of rules) {
    out = typeof replacement === 'string' ? out.replace(pattern, replacement) : out.replace(pattern, replacement);
  }
  return out;
}

function redactTokens(value: string): string {
  return applyRules(value, TOKEN_RULES);
}

/** Longest input redact() looks at; the rest is cut (logs and Sentry never need more). */
export const MAX_REDACT_INPUT = 8192;
export const TRUNCATED = '[truncated]';

function cap(value: string): string {
  if (value.length <= MAX_REDACT_INPUT) return value;
  // Cut at the last whitespace: the final partial word could be the first half of a token.
  const head = value.slice(0, MAX_REDACT_INPUT);
  const cut = Math.max(head.lastIndexOf(' '), head.lastIndexOf('\n'), head.lastIndexOf('\t'));
  return `${cut > 0 ? head.slice(0, cut + 1) : ''}${TRUNCATED}`;
}

/**
 * Masks every recognisable secret or personal-data shape in a string. Idempotent. Inputs longer
 * than MAX_REDACT_INPUT are cut first.
 */
export function redact(value: string): string {
  if (value === '') return value;
  return redactTokens(applyRules(cap(value), URL_RULES));
}
