// Client-bundle secret check (PLAN §10 item 13, §15 CI gate). Scans everything `next build`
// produced that a browser receives:
//   - .next/static: the JS and CSS assets (source maps are skipped);
//   - .next/server/app and .next/server/pages: the prerendered HTML and RSC payloads (*.html,
//     *.rsc, *.body, *.meta, *.segments/**), which is where a Server Component that passes env or
//     config into a client prop or its markup would leak. The server-only *.js bundles there may
//     legitimately name env variables and are not scanned.
// It looks for:
//   - secret-shaped values (vendor key prefixes followed by a key-length body, HubSpot tokens,
//     PEM blocks, JWTs, base64-encoded JSON such as the QStash token);
//   - the documented fake secrets (the "fake-only" marker and the exact FAKE_ENV values);
//   - the values of secret variables from the current environment and the .env files `next build`
//     reads (.env.production.local, .env.local, .env.production, .env), so a local live build is checked;
//   - the NAMES of server-only environment variables (PLAN §14: everything except NEXT_PUBLIC_*).
// Prints the file and the pattern for each hit, never the matched text (law 4), and exits 1 on any
// hit, when a directory is missing, or when a directory holds no file to scan.
//
// The vendor patterns require a key-length body on purpose: the shared redact() rules ship to the
// browser with Sentry and contain the bare prefixes (`sk-ant-`, `rzp_live_`, …) as regex source.
//
// Usage: npm run check:bundle [-- <dir> …]   (default: .next/static, .next/server/app and, when
// present, .next/server/pages; run `APP_MODE=fake npm run build` first). A directory with a
// `server` path segment is scanned for prerendered payloads only; any other for assets as well.
import { readFileSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { ENV_NAMES, FAKE_ENV, type EnvName } from '@/server/env';

/** Browser assets (.next/static). */
const ASSET_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.css']);
/** Prerendered responses: HTML, RSC payloads, route-handler bodies and their stored headers. */
const PRERENDER_EXTENSIONS = new Set(['.html', '.rsc', '.body', '.meta']);

/** PLAN §14, every variable except NEXT_PUBLIC_*. Kept here as a floor in case env.ts drifts. */
const PLAN_SERVER_ONLY_ENV_VARS = [
  'APP_MODE', 'ALLOW_FAKE_ON_VERCEL', 'APP_URL', 'PRODUCT_NAME', 'APP_SECRET', 'TOKEN_ENCRYPTION_KEY',
  'TOKEN_ENCRYPTION_KEY_PREVIOUS', 'ADMIN_EMAILS', 'ENV_NAMESPACE', 'COMPOSE_URL_LIMIT', 'COMPOSE_GMAIL_FORM',
  'COMPOSE_OUTLOOK_MODE', 'COMPOSE_OUTLOOK_WORK_BASE', 'COMPOSE_OUTLOOK_PERSONAL_BASE', 'MAX_DRAFTED_LEADS_PER_DAY',
  'AI_DAILY_BUDGET_USD', 'FAKE_DB_DIR',
  'DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY',
  'HUBSPOT_CLIENT_ID', 'HUBSPOT_CLIENT_SECRET', 'HUBSPOT_CLIENT_SECRET_PREVIOUS', 'HUBSPOT_APP_ID',
  'HUBSPOT_REDIRECT_URI', 'HUBSPOT_WEBHOOK_TARGET_URL', 'HUBSPOT_API_VERSION', 'HUBSPOT_JOURNAL_ENABLED',
  'QSTASH_URL', 'QSTASH_TOKEN', 'QSTASH_CURRENT_SIGNING_KEY', 'QSTASH_NEXT_SIGNING_KEY', 'QSTASH_MAX_DELAY_SECONDS',
  'CRON_SECRET',
  'RESEND_API_KEY', 'EMAIL_FROM', 'EMAIL_REPLY_TO',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL_DRAFT', 'ANTHROPIC_MODEL_FAST', 'ANTHROPIC_DRAFT_THINKING',
  'ANTHROPIC_DRAFT_EFFORT', 'ANTHROPIC_DRAFT_MAX_TOKENS', 'ANTHROPIC_BRIEF_EFFORT',
  'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'RAZORPAY_WEBHOOK_SECRET_PREVIOUS',
  'RAZORPAY_PLAN_ID',
  'SENTRY_DSN', 'SENTRY_ORG', 'SENTRY_PROJECT', 'SENTRY_AUTH_TOKEN',
] as const;

/**
 * Read by env.ts but set by the platform or an SDK, which may name them in its own browser code
 * (for example @sentry/core reads process.env.VERCEL_ENV). Not ours to leak.
 */
const THIRD_PARTY_SWITCHES = new Set<string>([
  'VERCEL_ENV',
  'QSTASH_DEV',
  'QSTASH_REGION',
  'SENTRY_TRACES_SAMPLE_RATE',
  'SENTRY_SPOTLIGHT',
  'SENTRY_DEBUG',
]);

/** Variables whose values are secrets: their fake values, and any real values set here, must not ship. */
const SECRET_ENV_VARS = [
  'APP_SECRET', 'TOKEN_ENCRYPTION_KEY', 'TOKEN_ENCRYPTION_KEY_PREVIOUS', 'DATABASE_URL', 'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SECRET_KEY', 'HUBSPOT_CLIENT_SECRET', 'HUBSPOT_CLIENT_SECRET_PREVIOUS', 'QSTASH_TOKEN',
  'QSTASH_CURRENT_SIGNING_KEY', 'QSTASH_NEXT_SIGNING_KEY', 'CRON_SECRET', 'RESEND_API_KEY', 'ANTHROPIC_API_KEY',
  'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'RAZORPAY_WEBHOOK_SECRET_PREVIOUS',
  'SENTRY_AUTH_TOKEN',
] as const satisfies readonly EnvName[];

/** The files `next build` (always NODE_ENV=production) reads, highest priority first. */
export const BUILD_ENV_FILES = ['.env.production.local', '.env.local', '.env.production', '.env'] as const;

/**
 * Secret values from the current environment and from the build's .env files. Read, never loaded
 * into process.env. Each value is labelled with where it came from (never with the value).
 */
function secretValues(cwd: string): { name: string; source: string; value: string }[] {
  const out: { name: string; source: string; value: string }[] = [];
  for (const name of SECRET_ENV_VARS) {
    const actual = process.env[name]?.trim();
    if (actual !== undefined) out.push({ name, source: 'the current environment', value: actual });
  }
  for (const file of BUILD_ENV_FILES) {
    let parsed: Record<string, string>;
    try {
      parsed = parseEnv(readFileSync(join(cwd, file), 'utf8')) as Record<string, string>;
    } catch {
      continue;
    }
    for (const name of SECRET_ENV_VARS) {
      const value = parsed[name]?.trim();
      if (value !== undefined) out.push({ name, source: file, value });
    }
  }
  return out;
}

/** Shorter environment values are too likely to occur by chance in minified code. */
const MIN_ENV_VALUE_LENGTH = 8;

interface Pattern {
  /** What was found; printed instead of the matched text. */
  readonly label: string;
  /** Global regex. A capture group 1, when present, is appended to the label. */
  readonly regex: RegExp;
}

export interface Hit {
  readonly file: string;
  readonly label: string;
  readonly count: number;
  readonly firstOffset: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function literal(label: string, value: string): Pattern {
  return { label, regex: new RegExp(escapeRegExp(value), 'g') };
}

function serverOnlyEnvNames(): string[] {
  const names = new Set<string>(PLAN_SERVER_ONLY_ENV_VARS);
  for (const name of ENV_NAMES) {
    if (!name.startsWith('NEXT_PUBLIC_') && !THIRD_PARTY_SWITCHES.has(name)) names.add(name);
  }
  return [...names].sort();
}

function buildPatterns(cwd: string): Pattern[] {
  const fakeEnv: Partial<Record<string, string>> = FAKE_ENV;
  const patterns: Pattern[] = [
    { label: 'Anthropic API key (sk-ant-…)', regex: /sk-ant-[A-Za-z0-9_-]{16,}/g },
    { label: 'Supabase secret key (sb_secret_…)', regex: /sb_secret_[A-Za-z0-9_-]{16,}/g },
    { label: 'Razorpay key id (rzp_live_… / rzp_test_…)', regex: /rzp_(?:live|test)_[A-Za-z0-9]{8,}/g },
    { label: 'PEM block (-----BEGIN …-----)', regex: /-----BEGIN [A-Z0-9 ]{3,40}-----/g },
    { label: 'Resend API key (re_…)', regex: /(?<![\w$])re_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}/g },
    { label: 'QStash signing key (sig_…)', regex: /(?<![\w$])sig_[A-Za-z0-9]{20,}/g },
    { label: 'Sentry auth token (sntrys_… / sntryu_…)', regex: /sntry[su]_[A-Za-z0-9_=+/-]{20,}/g },
    { label: 'JWT (eyJ….eyJ….…)', regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
    // Base64-encoded JSON objects without dots, such as a QStash token (eyJVc2VySUQi…).
    { label: 'base64 JSON token (eyJ…)', regex: /eyJ[A-Za-z0-9+/]{30,}={0,2}/g },
    // HubSpot refresh tokens (na1-…) and private-app tokens (pat-na1-…).
    { label: 'HubSpot token (na1-… / pat-na1-…)', regex: /(?<![\w$])(?:pat-)?(?:na|eu|ap)\d{1,2}-[0-9a-f]{4,}-/g },
    // Fake mode's documented secrets (env.ts FAKE_ENV): the marker, and its base64 form, which is how
    // the fake 32-byte keys start.
    { label: 'fake secret marker (fake-only)', regex: /fake[-_]?only/g },
    literal('base64 fake key (fake-only…)', Buffer.from('fake-only', 'utf8').toString('base64')),
  ];
  for (const name of SECRET_ENV_VARS) {
    const fake = fakeEnv[name];
    if (fake !== undefined && fake.length >= MIN_ENV_VALUE_LENGTH) patterns.push(literal(`fake value of ${name}`, fake));
  }
  const seen = new Set<string>();
  for (const { name, source, value } of secretValues(cwd)) {
    if (value.length < MIN_ENV_VALUE_LENGTH || value === fakeEnv[name] || seen.has(value)) continue;
    seen.add(value);
    patterns.push(literal(`value of ${name} from ${source}`, value));
  }
  // Whole-identifier match, so NEXT_PUBLIC_SENTRY_DSN does not count as SENTRY_DSN.
  const names = serverOnlyEnvNames().map(escapeRegExp).join('|');
  patterns.push({ label: 'server-only env var name', regex: new RegExp(`(?<![\\w$])(${names})(?![\\w$])`, 'g') });
  return patterns;
}

export interface ScanTarget {
  dir: string;
  /** Whether the directory must exist (the defaults .next/static and .next/server/app do). */
  required: boolean;
}

/** Prerender-only for build-server directories (their *.js is server code), assets too elsewhere. */
function isServerOutput(dir: string): boolean {
  return resolve(dir).split(sep).includes('server');
}

/** A file under a `*.segments` directory is a per-segment RSC payload, whatever its name. */
function inSegmentsDir(file: string, root: string): boolean {
  return relative(root, file).split(sep).slice(0, -1).some((part) => part.endsWith('.segments'));
}

async function listClientFiles(dir: string): Promise<string[]> {
  const serverOutput = isServerOutput(dir);
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => {
      const extension = extname(file);
      if (PRERENDER_EXTENSIONS.has(extension) || inSegmentsDir(file, dir)) return true;
      return !serverOutput && ASSET_EXTENSIONS.has(extension);
    })
    .sort();
}

function scan(file: string, text: string, patterns: readonly Pattern[]): Hit[] {
  const byLabel = new Map<string, { count: number; firstOffset: number }>();
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    for (const match of text.matchAll(pattern.regex)) {
      const detail = match[1];
      const label = detail === undefined ? pattern.label : `${pattern.label} ${detail}`;
      const seen = byLabel.get(label);
      if (seen === undefined) byLabel.set(label, { count: 1, firstOffset: match.index });
      else seen.count += 1;
    }
  }
  return [...byLabel].map(([label, { count, firstOffset }]) => ({ file, label, count, firstOffset }));
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export const DEFAULT_TARGETS: readonly ScanTarget[] = [
  { dir: join('.next', 'static'), required: true },
  { dir: join('.next', 'server', 'app'), required: true },
  { dir: join('.next', 'server', 'pages'), required: false },
];

export interface CheckResult {
  /** Problems with the targets themselves (missing or empty directories). */
  problems: string[];
  hits: Hit[];
  files: number;
  patterns: number;
}

/** Scans the targets, also for the secret values in the .env files `next build` reads. */
export async function checkBundle(targets: readonly ScanTarget[], cwd: string = process.cwd()): Promise<CheckResult> {
  const patterns = buildPatterns(cwd);
  const problems: string[] = [];
  const hits: Hit[] = [];
  let files = 0;
  for (const target of targets) {
    const dir = resolve(cwd, target.dir);
    const shown = relative(cwd, dir) || '.';
    if (!isDirectory(dir)) {
      if (target.required) problems.push(`${shown} not found. Build first: APP_MODE=fake npm run build`);
      continue;
    }
    const list = await listClientFiles(dir);
    if (list.length === 0) {
      problems.push(`no client-delivered files under ${shown}; the build output looks incomplete.`);
      continue;
    }
    files += list.length;
    for (const file of list) hits.push(...scan(relative(cwd, file), await readFile(file, 'utf8'), patterns));
  }
  return { problems, hits, files, patterns: patterns.length };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const targets = args.length > 0 ? args.map((dir) => ({ dir, required: true })) : DEFAULT_TARGETS;
  const result = await checkBundle(targets);
  for (const problem of result.problems) console.error(`check:bundle: FAIL ${problem}`);
  for (const hit of result.hits) {
    console.error(`check:bundle: FAIL ${hit.file}: ${hit.label} (${hit.count}×, first at offset ${hit.firstOffset})`);
  }
  const shown = targets.map((target) => target.dir).join(', ');
  if (result.hits.length > 0) {
    const fileCount = new Set(result.hits.map((hit) => hit.file)).size;
    console.error(`check:bundle: ${result.hits.length} finding(s) in ${fileCount} of ${result.files} client file(s) under ${shown}.`);
  }
  if (result.problems.length > 0 || result.hits.length > 0) return 1;
  console.log(
    `check:bundle: OK, scanned ${result.files} client file(s) under ${shown} with ${result.patterns} patterns; no secrets or server-only env names.`,
  );
  return 0;
}

// Run only as a script (tests import checkBundle).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error('check:bundle: FAIL could not complete the scan:', err instanceof Error ? err.message : 'unknown error');
      process.exitCode = 1;
    },
  );
}
