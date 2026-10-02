import 'server-only';
import { z } from 'zod';
import { tryDecodeKey } from '@/server/security/crypto';

// Environment (PLAN §14, D-29, D-51). Parsed lazily by getEnv(), never at import time, so
// `next build` needs no environment.
//
// - APP_MODE (fake | live) is required.
// - Documented defaults apply in both modes (ENV_DEFAULTS).
// - live: every variable without a documented default is required and well-formed (key
//   prefixes, rzp_live_ on Vercel production, 32-byte keys, current ≠ previous); documented fake
//   values and anything marked "fake-only" are refused; QSTASH_DEV, QSTASH_REGION (and any
//   region-prefixed QStash variable), SENTRY_TRACES_SAMPLE_RATE, SENTRY_SPOTLIGHT and SENTRY_DEBUG
//   must be unset, and QSTASH_TOKEN may not be the public dev-server token.
// - fake: missing values are filled with the documented fake values (FAKE_ENV), which live mode
//   refuses. Fake mode is refused on Vercel production/preview unless ALLOW_FAKE_ON_VERCEL=1.
//   Wherever fake mode can be reached by others (a Vercel production/preview deployment, or an
//   APP_URL that is not a loopback origin), APP_SECRET and TOKEN_ENCRYPTION_KEY must be set to
//   real, non-fake values: the fake ones are public, and the fake session cookie is signed with a
//   key derived from APP_SECRET. The /dev routes must then also sit behind Vercel deployment
//   protection (D-29).
// Errors name the variable and the problem, never the value.

export type AppMode = 'fake' | 'live';

/** Documented defaults (PLAN §14). */
export const ENV_DEFAULTS = {
  PRODUCT_NAME: 'Hublytix Autopilot',
  ANTHROPIC_MODEL_DRAFT: 'claude-sonnet-5-5',
  ANTHROPIC_MODEL_FAST: 'claude-haiku-4-5-20251001',
  ANTHROPIC_DRAFT_THINKING: 'between_tools',
  ANTHROPIC_DRAFT_EFFORT: 'medium',
  ANTHROPIC_DRAFT_MAX_TOKENS: '1024',
  ANTHROPIC_BRIEF_EFFORT: 'high',
  HUBSPOT_API_VERSION: '2026-09',
  HUBSPOT_JOURNAL_ENABLED: 'false',
  QSTASH_MAX_DELAY_SECONDS: '601200',
  COMPOSE_URL_LIMIT: '1800',
  COMPOSE_GMAIL_FORM: 'u',
  COMPOSE_OUTLOOK_MODE: 'mailtouri',
  COMPOSE_OUTLOOK_WORK_BASE: 'https://outlook.cloud.microsoft/mail/deeplink/compose',
  COMPOSE_OUTLOOK_PERSONAL_BASE: 'https://outlook.live.com/mail/deeplink/compose',
  MAX_DRAFTED_LEADS_PER_DAY: '50',
  AI_DAILY_BUDGET_USD: '25',
  FAKE_DB_DIR: '.data/pglite',
} as const satisfies Partial<Record<EnvName, string>>;

/** A 32-byte key whose bytes spell out that it is fake (base64). */
function fakeKey(label: string): string {
  return Buffer.from(label.padEnd(32, '-').slice(0, 32), 'utf8').toString('base64');
}

const FAKE_APP_URL = 'http://localhost:3000';

/**
 * Documented fake values: used in fake mode when a variable is unset, refused in live mode. The
 * HubSpot client id/secret and app id match the fake HubSpot adapter and its fixture portal.
 */
export const FAKE_ENV = {
  APP_URL: FAKE_APP_URL,
  APP_SECRET: fakeKey('fake-only-app-secret'),
  TOKEN_ENCRYPTION_KEY: fakeKey('fake-only-token-encryption-key'),
  ADMIN_EMAILS: 'fake-only-admin@example.com',
  ENV_NAMESPACE: 'fake-local',
  DATABASE_URL: 'postgresql://fake-only:fake-only@127.0.0.1:6543/postgres',
  SUPABASE_URL: 'https://fake-only.supabase.invalid',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake-only',
  SUPABASE_SECRET_KEY: 'sb_secret_fake-only',
  HUBSPOT_CLIENT_ID: 'fake-hubspot-client-id',
  HUBSPOT_CLIENT_SECRET: 'fake-hubspot-client-secret',
  HUBSPOT_APP_ID: '7100001',
  HUBSPOT_REDIRECT_URI: `${FAKE_APP_URL}/api/hubspot/oauth/callback`,
  HUBSPOT_WEBHOOK_TARGET_URL: `${FAKE_APP_URL}/api/hubspot/webhooks`,
  QSTASH_URL: 'https://fake-only.qstash.invalid',
  QSTASH_TOKEN: 'fake-only-qstash-token',
  QSTASH_CURRENT_SIGNING_KEY: 'sig_fakeonlycurrentsigningkey',
  QSTASH_NEXT_SIGNING_KEY: 'sig_fakeonlynextsigningkey',
  CRON_SECRET: 'fake-only-cron-secret-0000000000000000',
  RESEND_API_KEY: 're_fake_only_resend_key',
  EMAIL_FROM: 'Hublytix Autopilot <fake-only-noreply@example.com>',
  EMAIL_REPLY_TO: 'fake-only-support@example.com',
  ANTHROPIC_API_KEY: 'sk-ant-fake-only',
  RAZORPAY_KEY_ID: 'rzp_test_fakeonly',
  RAZORPAY_KEY_SECRET: 'fake-only-razorpay-key-secret',
  RAZORPAY_WEBHOOK_SECRET: 'fake-only-razorpay-webhook-secret',
  RAZORPAY_PLAN_ID: 'plan_fakeonly',
} as const satisfies Partial<Record<EnvName, string>>;

/** QStash's public dev-server signing keys (QS-DEVMODE-KEY-OVERRIDE): never valid in live mode. */
const QSTASH_DEV_SIGNING_KEYS = new Set(['sig_7kYjw48mhY7kAjqNGcy6cr29RJ6r', 'sig_5ZB6DVzB1wjE8S6rZ7eenA8Pdnhs']);
/** The public dev-server token of @upstash/qstash (DEV_CREDENTIALS.token): never valid in live mode. */
/** QStash's public local-development token (base64 of its documented default credentials). */
const QSTASH_DEV_TOKEN = Buffer.from(JSON.stringify({ UserID: 'defaultUser', Password: 'defaultPassword' })).toString('base64');
/**
 * Region-prefixed QStash credentials (`US_EAST_1_QSTASH_TOKEN`, `EU_CENTRAL_1_QSTASH_CURRENT_SIGNING_KEY`, …).
 * With QSTASH_REGION set, @upstash/qstash picks these per request instead of the validated ones.
 */
const QSTASH_REGION_VARIABLE = /^[A-Z][A-Z0-9_]*_QSTASH_(?:URL|TOKEN|CURRENT_SIGNING_KEY|NEXT_SIGNING_KEY)$/;

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

const REQUIRED = 'is required in live mode';

function text() {
  return z.string({ error: (issue) => (issue.input === undefined ? REQUIRED : 'must be a string') });
}

function matching(pattern: RegExp, problem: string) {
  return text().regex(pattern, { error: problem });
}

function integer(min: number, max: number) {
  return matching(/^\d{1,9}$/, 'must be a whole number')
    .transform(Number)
    .pipe(z.number().min(min, { error: `must be at least ${min}` }).max(max, { error: `must be at most ${max}` }));
}

function oneOf<const T extends readonly [string, ...string[]]>(values: T) {
  return z.enum(values, { error: (issue) => (issue.input === undefined ? REQUIRED : `must be one of: ${values.join(', ')}`) });
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isHttpUrl(value: string): boolean {
  const url = parseUrl(value);
  return url !== null && (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === '';
}

const httpUrl = () => text().refine(isHttpUrl, { error: 'must be an http(s) URL without credentials' });

/** A Sentry DSN: http(s)://<public key>@<host>/<project id> (the public key is not a secret). */
function isDsn(value: string): boolean {
  const url = parseUrl(value);
  return url !== null && (url.protocol === 'https:' || url.protocol === 'http:') && url.username !== '' && url.password === '' && /^\/\d+$/.test(url.pathname);
}
const dsn = () => text().refine(isDsn, { error: 'must be a Sentry DSN (https://<key>@<host>/<project id>)' });

const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const key32 = () => text().refine((value) => tryDecodeKey(value) !== null, { error: 'must be base64 for exactly 32 bytes' });
const noSpaces = (problem: string) => matching(/^\S+$/, problem);

const envSchema = z.object({
  APP_MODE: z.enum(['fake', 'live'], { error: 'must be "fake" or "live" (required)' }),
  ALLOW_FAKE_ON_VERCEL: z.enum(['0', '1'], { error: 'must be "1" (or "0") when set' }).transform((v) => v === '1').optional(),
  APP_URL: httpUrl()
    .refine((value) => {
      const url = parseUrl(value);
      return url !== null && url.pathname === '/' && url.search === '' && url.hash === '';
    }, { error: 'must be an origin (scheme and host only, no path)' })
    .transform((value) => new URL(value).origin),
  PRODUCT_NAME: text().trim().min(1, { error: 'must not be empty' }).max(60, { error: 'must be at most 60 characters' }),
  APP_SECRET: key32(),
  TOKEN_ENCRYPTION_KEY: key32(),
  TOKEN_ENCRYPTION_KEY_PREVIOUS: key32().optional(),
  ADMIN_EMAILS: text()
    .transform((value) => value.split(',').map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== ''))
    .pipe(z.array(z.string().regex(EMAIL, { error: 'must be a comma-separated list of email addresses' })).min(1, { error: 'must list at least one email address' })),
  ENV_NAMESPACE: matching(/^[a-z0-9][a-z0-9-]{0,31}$/, 'must be 1-32 lower-case letters, digits or dashes'),
  COMPOSE_URL_LIMIT: integer(256, 32768),
  COMPOSE_GMAIL_FORM: oneOf(['u', 'view']),
  COMPOSE_OUTLOOK_MODE: oneOf(['mailtouri', 'params']),
  COMPOSE_OUTLOOK_WORK_BASE: httpUrl(),
  COMPOSE_OUTLOOK_PERSONAL_BASE: httpUrl(),
  MAX_DRAFTED_LEADS_PER_DAY: integer(1, 10000),
  AI_DAILY_BUDGET_USD: matching(/^\d{1,6}(?:\.\d{1,2})?$/, 'must be an amount in USD, e.g. 25 or 12.50')
    .transform(Number)
    .pipe(z.number().positive({ error: 'must be more than 0' })),
  FAKE_DB_DIR: text().min(1, { error: 'must not be empty' }),

  DATABASE_URL: text().refine((value) => {
    const url = parseUrl(value);
    return url !== null && (url.protocol === 'postgres:' || url.protocol === 'postgresql:') && url.hostname !== '';
  }, { error: 'must be a postgres:// or postgresql:// URL' }),
  SUPABASE_URL: httpUrl(),
  SUPABASE_PUBLISHABLE_KEY: matching(/^sb_publishable_\S+$/, 'must start with sb_publishable_'),
  SUPABASE_SECRET_KEY: matching(/^sb_secret_\S+$/, 'must start with sb_secret_'),

  HUBSPOT_CLIENT_ID: noSpaces('must be the app client id'),
  HUBSPOT_CLIENT_SECRET: noSpaces('must be the app client secret'),
  HUBSPOT_CLIENT_SECRET_PREVIOUS: noSpaces('must be the previous app client secret').optional(),
  HUBSPOT_APP_ID: matching(/^\d{1,12}$/, 'must be the numeric app id'),
  HUBSPOT_REDIRECT_URI: httpUrl(),
  HUBSPOT_WEBHOOK_TARGET_URL: httpUrl(),
  HUBSPOT_API_VERSION: matching(/^\d{4}-\d{2}$/, 'must be a date version like 2026-09'),
  HUBSPOT_JOURNAL_ENABLED: oneOf(['true', 'false']).transform((v) => v === 'true'),

  QSTASH_URL: httpUrl(),
  QSTASH_TOKEN: noSpaces('must be the QStash token'),
  QSTASH_CURRENT_SIGNING_KEY: matching(/^sig_[A-Za-z0-9]+$/, 'must start with sig_'),
  QSTASH_NEXT_SIGNING_KEY: matching(/^sig_[A-Za-z0-9]+$/, 'must start with sig_'),
  QSTASH_MAX_DELAY_SECONDS: integer(60, 604800),
  CRON_SECRET: matching(/^[\x21-\x7e]{32,}$/, 'must be at least 32 visible ASCII characters without spaces'),

  RESEND_API_KEY: matching(/^re_[A-Za-z0-9_]+$/, 'must start with re_'),
  EMAIL_FROM: matching(
    /^(?:[^<>\r\n]{1,100} <[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}>|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})$/,
    'must be an address or "Name <address>"',
  ),
  EMAIL_REPLY_TO: matching(EMAIL, 'must be an email address'),

  ANTHROPIC_API_KEY: matching(/^sk-ant-[A-Za-z0-9_-]+$/, 'must start with sk-ant-'),
  ANTHROPIC_MODEL_DRAFT: matching(/^[a-z0-9][a-z0-9.-]{2,63}$/, 'must be a model id'),
  ANTHROPIC_MODEL_FAST: matching(/^[a-z0-9][a-z0-9.-]{2,63}$/, 'must be a model id'),
  ANTHROPIC_DRAFT_THINKING: oneOf(['between_tools', 'adaptive']),
  ANTHROPIC_DRAFT_EFFORT: oneOf(['low', 'medium', 'high', 'xhigh', 'max']),
  ANTHROPIC_DRAFT_MAX_TOKENS: integer(64, 64000),
  ANTHROPIC_BRIEF_EFFORT: oneOf(['low', 'medium', 'high', 'xhigh', 'max']),

  RAZORPAY_KEY_ID: matching(/^rzp_(?:test|live)_[A-Za-z0-9]+$/, 'must start with rzp_test_ or rzp_live_'),
  RAZORPAY_KEY_SECRET: noSpaces('must be the key secret'),
  RAZORPAY_WEBHOOK_SECRET: noSpaces('must be the webhook secret'),
  RAZORPAY_WEBHOOK_SECRET_PREVIOUS: noSpaces('must be the previous webhook secret').optional(),
  RAZORPAY_PLAN_ID: matching(/^plan_[A-Za-z0-9]+$/, 'must start with plan_'),

  SENTRY_DSN: dsn().optional(),
  NEXT_PUBLIC_SENTRY_DSN: dsn().optional(),
  SENTRY_ORG: matching(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'must be the organisation slug').optional(),
  SENTRY_PROJECT: matching(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'must be the project slug').optional(),
  SENTRY_AUTH_TOKEN: noSpaces('must be a token without spaces').optional(),

  // Read, never set by us: Vercel's environment, and SDK switches that live mode refuses (QStash's
  // dev mode and region routing; Sentry's tracing, Spotlight sidecar and debug logging).
  VERCEL_ENV: z.string().optional(),
  QSTASH_DEV: z.string().optional(),
  QSTASH_REGION: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.string().optional(),
  SENTRY_SPOTLIGHT: z.string().optional(),
  SENTRY_DEBUG: z.string().optional(),
});

export type Env = Readonly<z.output<typeof envSchema>>;
export type EnvName = keyof z.input<typeof envSchema>;

/** Every variable env.ts reads. */
export const ENV_NAMES = Object.keys(envSchema.shape) as EnvName[];

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

export class EnvError extends Error {
  override readonly name: string = 'EnvError';
  readonly code = 'env_invalid';
  /** `VARIABLE: problem` lines. They never contain a value. */
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid environment (${issues.length} problem${issues.length === 1 ? '' : 's'}): ${issues.join('; ')}`);
    this.issues = issues;
  }
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

function present(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

const FAKE_MARKER = 'fakeonly';

// Not secrets, and a real value could coincide with the fake one.
const NOT_COMPARED_TO_FAKE = new Set<EnvName>(['HUBSPOT_APP_ID']);

function looksFake(name: EnvName, value: string): boolean {
  const fake: string | undefined = (FAKE_ENV as Partial<Record<EnvName, string>>)[name];
  if (fake !== undefined && value === fake && !NOT_COMPARED_TO_FAKE.has(name)) return true;
  const normalise = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalise(value).includes(FAKE_MARKER)) return true;
  const decoded = tryDecodeKey(value);
  return decoded !== null && normalise(decoded.toString('latin1')).includes(FAKE_MARKER);
}

/** Raw values after defaults (both modes) and fake fills (fake mode). */
function fill(source: EnvSource, mode: AppMode | undefined): Record<string, string | undefined> {
  const filled: Record<string, string | undefined> = {};
  for (const name of ENV_NAMES) filled[name] = present(source[name]);
  for (const [name, value] of Object.entries(ENV_DEFAULTS)) filled[name] ??= value;
  if (mode === 'fake') {
    for (const [name, value] of Object.entries(FAKE_ENV)) filled[name] ??= value;
    // The fake HubSpot URLs follow a custom APP_URL (e.g. another local port).
    const appUrl = parseUrl(filled.APP_URL ?? '')?.origin;
    if (appUrl !== undefined && present(source.HUBSPOT_REDIRECT_URI) === undefined) {
      filled.HUBSPOT_REDIRECT_URI = `${appUrl}/api/hubspot/oauth/callback`;
    }
    if (appUrl !== undefined && present(source.HUBSPOT_WEBHOOK_TARGET_URL) === undefined) {
      filled.HUBSPOT_WEBHOOK_TARGET_URL = `${appUrl}/api/hubspot/webhooks`;
    }
  }
  return filled;
}

/** True for http(s)://localhost, *.localhost, 127.0.0.0/8 and [::1]: only this machine can reach it. */
function isLoopbackOrigin(value: string | undefined): boolean {
  const url = parseUrl(value ?? '');
  if (url === null) return false;
  const host = url.hostname.toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || /^127(?:\.\d{1,3}){3}$/.test(host) || host === '[::1]';
}

/** Names of region-prefixed QStash variables in the source (values never read). */
function qstashRegionVariables(source: EnvSource): string[] {
  return Object.keys(source)
    .filter((name) => QSTASH_REGION_VARIABLE.test(name) && present(source[name]) !== undefined)
    .sort();
}

/** Checks that need only the raw values and the mode. */
function modeIssues(mode: AppMode, raw: Record<string, string | undefined>, source: EnvSource): string[] {
  const issues: string[] = [];
  const vercelEnv = raw.VERCEL_ENV;
  if (mode === 'fake') {
    const onVercel = vercelEnv === 'production' || vercelEnv === 'preview';
    if (onVercel && raw.ALLOW_FAKE_ON_VERCEL !== '1') {
      issues.push(`APP_MODE: fake mode is refused on Vercel ${vercelEnv} unless ALLOW_FAKE_ON_VERCEL=1`);
    }
    // Reachable by others: the public fake keys would let anyone forge a session (or read tokens).
    if (onVercel || !isLoopbackOrigin(raw.APP_URL)) {
      for (const name of ['APP_SECRET', 'TOKEN_ENCRYPTION_KEY'] as const) {
        const value = present(source[name]);
        if (value === undefined || looksFake(name, value)) {
          issues.push(`${name}: fake mode on a Vercel deployment or a non-loopback APP_URL needs a real, non-fake value`);
        }
      }
    }
    return issues;
  }
  for (const name of ENV_NAMES) {
    const value = raw[name];
    if (value !== undefined && name !== 'APP_MODE' && looksFake(name, value)) {
      issues.push(`${name}: a documented fake value is not allowed in live mode`);
    }
  }
  if (raw.QSTASH_DEV !== undefined) issues.push('QSTASH_DEV: must be unset in live mode');
  if (raw.QSTASH_TOKEN === QSTASH_DEV_TOKEN) issues.push('QSTASH_TOKEN: the public QStash dev-server token is not allowed in live mode');
  if (raw.QSTASH_REGION !== undefined) {
    issues.push('QSTASH_REGION: must be unset in live mode (it routes to region-prefixed credentials that are not validated)');
  }
  for (const name of qstashRegionVariables(source)) {
    issues.push(`${name}: region-prefixed QStash variables are not allowed in live mode; use the QSTASH_* variables`);
  }
  if (raw.SENTRY_TRACES_SAMPLE_RATE !== undefined) {
    issues.push('SENTRY_TRACES_SAMPLE_RATE: must be unset (Sentry runs errors-only, D-23)');
  }
  if (raw.SENTRY_SPOTLIGHT !== undefined) issues.push('SENTRY_SPOTLIGHT: must be unset in live mode (it forwards every event to a sidecar)');
  if (raw.SENTRY_DEBUG !== undefined) issues.push('SENTRY_DEBUG: must be unset in live mode');
  for (const name of ['QSTASH_CURRENT_SIGNING_KEY', 'QSTASH_NEXT_SIGNING_KEY'] as const) {
    const value = raw[name];
    if (value !== undefined && QSTASH_DEV_SIGNING_KEYS.has(value)) issues.push(`${name}: the public QStash dev-server key is not allowed in live mode`);
  }
  return issues;
}

function sameBytes(a: string, b: string): boolean {
  const left = tryDecodeKey(a);
  const right = tryDecodeKey(b);
  return left !== null && right !== null && left.equals(right);
}

/** Checks across parsed variables. */
function crossIssues(env: z.output<typeof envSchema>): string[] {
  const issues: string[] = [];
  if (env.TOKEN_ENCRYPTION_KEY_PREVIOUS !== undefined && sameBytes(env.TOKEN_ENCRYPTION_KEY, env.TOKEN_ENCRYPTION_KEY_PREVIOUS)) {
    issues.push('TOKEN_ENCRYPTION_KEY_PREVIOUS: must differ from TOKEN_ENCRYPTION_KEY');
  }
  if (sameBytes(env.APP_SECRET, env.TOKEN_ENCRYPTION_KEY) || (env.TOKEN_ENCRYPTION_KEY_PREVIOUS !== undefined && sameBytes(env.APP_SECRET, env.TOKEN_ENCRYPTION_KEY_PREVIOUS))) {
    issues.push('APP_SECRET: must differ from the token encryption keys');
  }
  if (env.HUBSPOT_CLIENT_SECRET_PREVIOUS !== undefined && env.HUBSPOT_CLIENT_SECRET_PREVIOUS === env.HUBSPOT_CLIENT_SECRET) {
    issues.push('HUBSPOT_CLIENT_SECRET_PREVIOUS: must differ from HUBSPOT_CLIENT_SECRET');
  }
  if (env.RAZORPAY_WEBHOOK_SECRET_PREVIOUS !== undefined && env.RAZORPAY_WEBHOOK_SECRET_PREVIOUS === env.RAZORPAY_WEBHOOK_SECRET) {
    issues.push('RAZORPAY_WEBHOOK_SECRET_PREVIOUS: must differ from RAZORPAY_WEBHOOK_SECRET');
  }
  if (env.APP_MODE !== 'live') return issues;

  const httpsOnly = [
    'APP_URL',
    'SUPABASE_URL',
    'HUBSPOT_REDIRECT_URI',
    'HUBSPOT_WEBHOOK_TARGET_URL',
    'QSTASH_URL',
    'COMPOSE_OUTLOOK_WORK_BASE',
    'COMPOSE_OUTLOOK_PERSONAL_BASE',
    'SENTRY_DSN',
    'NEXT_PUBLIC_SENTRY_DSN',
  ] as const;
  for (const name of httpsOnly) {
    const value = env[name];
    if (value !== undefined && parseUrl(value)?.protocol !== 'https:') issues.push(`${name}: must use https in live mode`);
  }
  if (parseUrl(env.HUBSPOT_REDIRECT_URI)?.origin !== env.APP_URL) {
    issues.push('HUBSPOT_REDIRECT_URI: must be on the APP_URL origin');
  }
  if (parseUrl(env.DATABASE_URL)?.port !== '6543') {
    issues.push('DATABASE_URL: must be the Supabase transaction pooler (port 6543, D-28)');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(env.HUBSPOT_CLIENT_ID)) {
    issues.push('HUBSPOT_CLIENT_ID: must be the app client id (a UUID)');
  }
  if (env.VERCEL_ENV === 'production' && !env.RAZORPAY_KEY_ID.startsWith('rzp_live_')) {
    issues.push('RAZORPAY_KEY_ID: must start with rzp_live_ on Vercel production');
  }
  return issues;
}

/** Parses an environment. Pure: tests pass a plain object. Throws EnvError listing every problem. */
export function parseEnv(source: EnvSource): Env {
  const rawMode = present(source.APP_MODE);
  const mode: AppMode | undefined = rawMode === 'fake' || rawMode === 'live' ? rawMode : undefined;
  const raw = fill(source, mode);

  const issues: string[] = mode === undefined ? [] : modeIssues(mode, raw, source);
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const name = String(issue.path[0] ?? 'env');
      issues.push(`${name}: ${issue.message}`);
    }
  } else {
    issues.push(...crossIssues(parsed.data));
  }
  if (issues.length > 0 || !parsed.success) throw new EnvError([...new Set(issues)]);
  const env = parsed.data;
  Object.freeze(env.ADMIN_EMAILS);
  return Object.freeze(env);
}

let cached: { fingerprint: string; env: Env } | undefined;

/**
 * The environment of this process, parsed on first use and re-parsed only when a variable it
 * reads changes (tests stub process.env). Throws EnvError when invalid.
 */
export function getEnv(): Env {
  const fingerprint = JSON.stringify([ENV_NAMES.map((name) => process.env[name] ?? null), qstashRegionVariables(process.env)]);
  if (cached?.fingerprint === fingerprint) return cached.env;
  const env = parseEnv(process.env);
  cached = { fingerprint, env };
  return env;
}
