// Sentry event and breadcrumb scrubbers (D-23, PLAN §10.10, §11). Pure functions, client- and
// server-safe, used by the shared Sentry options for beforeSend/beforeBreadcrumb.
//
// Policy (law 4: no tokens, message text, drafts or emails leave the process):
// - request: only the method and a sanitised URL (no query, fragment, credentials or action
//   token); data, cookies, headers, query_string and env are dropped;
// - transaction names and URL-like fields are rewritten (incl. /a/{token});
// - exception and breadcrumb messages are kept only when they are snake_case error codes that
//   redact() leaves alone (isSafeErrorCode); anything else (provider messages, parser errors
//   quoting input, tokens, hashes, domains, names) becomes "[redacted]";
// - server_name (the host name) is dropped;
// - extra, contexts, tags and breadcrumb data are deep-scrubbed: content and credential keys are
//   dropped, URL keys sanitised, every other string goes through redact();
// - stack frames lose local variables and source context; console breadcrumbs are dropped;
// - the envelope's dynamic sampling context keeps only ids (no transaction name).
import type { Breadcrumb, Event, Exception, Mechanism, StackFrame, Stacktrace } from '@sentry/core';
import { REDACTED, isSafeCode, isSafeErrorCode, redact, sanitizeUrl } from './redact';

const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 100;

/** Normalised key: lower-case letters and digits only (`first_name`, `firstName` → `firstname`). */
function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Keys whose values are content, personal data or raw request parts: dropped whatever they hold.
const CONTENT_KEYS = new Set(
  [
    'message', 'messages', 'body', 'text', 'html', 'draft', 'drafts', 'subject', 'prompt', 'prompts',
    'completion', 'completions', 'content', 'input', 'inputs', 'output', 'outputs', 'email', 'emails',
    'firstname', 'lastname', 'fullname', 'company', 'phone', 'cc', 'bcc', 'replyto', 'data', 'headers',
    'cookies', 'querystring', 'query', 'search', 'fragment', 'hash', 'urlquery', 'urlfragment', 'params',
    'formdata', 'payload', 'variables', 'args', 'arguments', 'serialized', 'env', 'vars', 'response', 'request',
  ].map(normaliseKey),
);

// Key prefixes for data Sentry itself attaches from a request: Server Action form fields and
// results (withServerActionInstrumentation's `server_action_form_data.<field>` extras).
const CONTENT_KEY_PREFIXES = ['serveractionformdata', 'serveractionresult'];

// Credential-like keys (substring match, as Sentry's own denylist) and short exact names.
const SECRET_KEY_SNIPPETS = [
  'token', 'secret', 'password', 'passwd', 'pwd', 'auth', 'session', 'cookie', 'csrf', 'xsrf', 'jwt',
  'bearer', 'apikey', 'credential', 'signature', 'privatekey',
];
const SECRET_KEY_EXACT = new Set(['key', 'sid', 'code', 'state', 'th', 'sig', 'kid', 'iv', 'tag', 'ct']);

// Keys whose string values are URLs or paths: sanitised, not dropped.
const URL_KEYS = new Set(
  ['url', 'href', 'uri', 'to', 'from', 'path', 'requestpath', 'routerpath', 'route', 'referer', 'referrer', 'location', 'link', 'target', 'transaction'].map(
    normaliseKey,
  ),
);

function isSecretKey(normalised: string): boolean {
  return SECRET_KEY_EXACT.has(normalised) || SECRET_KEY_SNIPPETS.some((snippet) => normalised.includes(snippet));
}

function isDroppedKey(normalised: string): boolean {
  return CONTENT_KEYS.has(normalised) || CONTENT_KEY_PREFIXES.some((prefix) => normalised.startsWith(prefix)) || isSecretKey(normalised);
}

function scrubUrlValue(value: string): string {
  return redact(sanitizeUrl(value));
}

/** Deep-scrubs arbitrary data: drops content and credential keys, sanitises URLs, redacts strings. */
export function scrubData(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redact(value);
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return undefined;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map((item) => scrubData(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const normalised = normaliseKey(key);
    if (URL_KEYS.has(normalised) && typeof item === 'string') {
      out[key] = scrubUrlValue(item);
    } else if (isDroppedKey(normalised)) {
      if (item !== undefined) out[key] = REDACTED;
    } else {
      const scrubbed = scrubData(item, depth + 1);
      if (scrubbed !== undefined) out[key] = scrubbed;
    }
  }
  return out;
}

function scrubRecord(value: unknown): Record<string, unknown> {
  const scrubbed = scrubData(value);
  return scrubbed !== null && typeof scrubbed === 'object' && !Array.isArray(scrubbed) ? (scrubbed as Record<string, unknown>) : {};
}

/** A message is kept only when it is an error code; anything else is replaced. */
function scrubMessage(message: string): string {
  return isSafeErrorCode(message) ? message : REDACTED;
}

// ---------------------------------------------------------------------------------------------
// Exceptions and frames
// ---------------------------------------------------------------------------------------------

const IDENTIFIER = /^[A-Za-z_$][\w$.]{0,63}$/;
const HTTP_URL = /^https?:\/\//i;

/** Frame paths stay as they are (source maps need them) except browser URLs, which lose query and fragment. */
function scrubFramePath(path: string): string {
  if (!HTTP_URL.test(path)) return path;
  const cut = path.search(/[?#]/);
  const bare = cut === -1 ? path : path.slice(0, cut);
  return sanitizeUrl(bare);
}

function scrubFrame(frame: StackFrame): StackFrame {
  const out: StackFrame = {};
  if (frame.filename !== undefined) out.filename = scrubFramePath(frame.filename);
  if (frame.abs_path !== undefined) out.abs_path = scrubFramePath(frame.abs_path);
  if (frame.function !== undefined) out.function = frame.function;
  if (frame.module !== undefined) out.module = frame.module;
  if (frame.platform !== undefined) out.platform = frame.platform;
  if (frame.lineno !== undefined) out.lineno = frame.lineno;
  if (frame.colno !== undefined) out.colno = frame.colno;
  if (frame.in_app !== undefined) out.in_app = frame.in_app;
  if (frame.instruction_addr !== undefined) out.instruction_addr = frame.instruction_addr;
  if (frame.addr_mode !== undefined) out.addr_mode = frame.addr_mode;
  if (frame.debug_id !== undefined) out.debug_id = frame.debug_id;
  // vars, context_line, pre_context, post_context and module_metadata are dropped.
  return out;
}

function scrubStacktrace(stacktrace: Stacktrace): Stacktrace {
  const out: Stacktrace = {};
  if (stacktrace.frames !== undefined) out.frames = stacktrace.frames.map(scrubFrame);
  if (stacktrace.frames_omitted !== undefined) out.frames_omitted = stacktrace.frames_omitted;
  return out;
}

function scrubMechanism(mechanism: Mechanism): Mechanism {
  // `data` is dropped: it can carry handler arguments.
  const { data: _data, ...rest } = mechanism;
  return rest;
}

function scrubException(exception: Exception): Exception {
  const out: Exception = {};
  if (exception.type !== undefined) out.type = IDENTIFIER.test(exception.type) ? exception.type : 'Error';
  if (exception.value !== undefined) out.value = scrubMessage(exception.value);
  if (exception.module !== undefined) out.module = exception.module;
  if (exception.thread_id !== undefined) out.thread_id = exception.thread_id;
  if (exception.mechanism !== undefined) out.mechanism = scrubMechanism(exception.mechanism);
  if (exception.stacktrace !== undefined) out.stacktrace = scrubStacktrace(exception.stacktrace);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Breadcrumbs
// ---------------------------------------------------------------------------------------------

/** beforeBreadcrumb: drops console breadcrumbs; keeps code-like messages; deep-scrubs data. */
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.category === 'console') return null;
  const out: Breadcrumb = {};
  if (breadcrumb.type !== undefined) out.type = breadcrumb.type;
  if (breadcrumb.level !== undefined) out.level = breadcrumb.level;
  if (breadcrumb.event_id !== undefined) out.event_id = breadcrumb.event_id;
  if (breadcrumb.category !== undefined) out.category = isSafeCode(breadcrumb.category) ? breadcrumb.category : REDACTED;
  if (breadcrumb.timestamp !== undefined) out.timestamp = breadcrumb.timestamp;
  if (breadcrumb.message !== undefined) out.message = scrubMessage(breadcrumb.message);
  if (breadcrumb.data !== undefined) out.data = scrubRecord(breadcrumb.data);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

const HTTP_METHOD = /^[A-Z]{3,7}$/;
const USER_ID = /^[\w-]{1,64}$/;
const TRACE_CONTEXT_KEYS = ['trace_id', 'span_id', 'parent_span_id', 'op', 'origin', 'status'] as const;
const DSC_KEYS = ['trace_id', 'public_key', 'sample_rate', 'sample_rand', 'sampled', 'release', 'environment', 'org_id'] as const;

function pick(source: unknown, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (source === null || typeof source !== 'object') return out;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return out;
}

function scrubRequest(request: NonNullable<Event['request']>): NonNullable<Event['request']> {
  const out: NonNullable<Event['request']> = {};
  if (request.method !== undefined && HTTP_METHOD.test(request.method)) out.method = request.method;
  if (request.url !== undefined) out.url = scrubUrlValue(request.url);
  // data, query_string, cookies, headers and env are dropped.
  return out;
}

function scrubContexts(contexts: NonNullable<Event['contexts']>): NonNullable<Event['contexts']> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, context] of Object.entries(contexts)) {
    if (context === undefined || context === null) continue;
    out[name] = name === 'trace' ? pick(context, TRACE_CONTEXT_KEYS) : scrubRecord(context);
  }
  return out as NonNullable<Event['contexts']>;
}

function scrubTags(tags: NonNullable<Event['tags']>): NonNullable<Event['tags']> {
  const out: NonNullable<Event['tags']> = {};
  for (const [key, value] of Object.entries(tags)) {
    const normalised = normaliseKey(key);
    if (isDroppedKey(normalised)) continue;
    out[key] = typeof value === 'string' ? redact(value) : value;
  }
  return out;
}

/**
 * beforeSend: returns a new event that keeps only what is safe to send (see the policy at the
 * top of this file). Fields this function does not know are dropped.
 */
export function scrubEvent<T extends Event>(event: T): T {
  const out: Event = { type: event.type };
  if (event.event_id !== undefined) out.event_id = event.event_id;
  if (event.timestamp !== undefined) out.timestamp = event.timestamp;
  if (event.start_timestamp !== undefined) out.start_timestamp = event.start_timestamp;
  if (event.level !== undefined) out.level = event.level;
  if (event.platform !== undefined) out.platform = event.platform;
  if (event.logger !== undefined) out.logger = event.logger;
  if (event.release !== undefined) out.release = event.release;
  if (event.dist !== undefined) out.dist = event.dist;
  if (event.environment !== undefined) out.environment = event.environment;
  if (event.sdk !== undefined) out.sdk = event.sdk;
  if (event.modules !== undefined) out.modules = event.modules;
  if (event.debug_meta !== undefined) out.debug_meta = event.debug_meta;
  if (event.transaction_info !== undefined) out.transaction_info = event.transaction_info;

  // Our own captureMessage() calls are static strings, so the message is redacted, not dropped.
  if (event.message !== undefined) out.message = redact(event.message);
  if (event.logentry?.message !== undefined) out.logentry = { message: redact(event.logentry.message) };
  if (event.transaction !== undefined) out.transaction = redact(event.transaction);
  if (event.request !== undefined) out.request = scrubRequest(event.request);
  if (event.fingerprint !== undefined) out.fingerprint = event.fingerprint.map(redact);
  if (event.exception?.values !== undefined) out.exception = { values: event.exception.values.map(scrubException) };
  if (event.threads?.values !== undefined) {
    out.threads = {
      values: event.threads.values.map((thread) => {
        const { stacktrace, ...rest } = thread;
        return stacktrace === undefined ? rest : { ...rest, stacktrace: scrubStacktrace(stacktrace) };
      }),
    };
  }
  if (event.breadcrumbs !== undefined) {
    out.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb).filter((crumb): crumb is Breadcrumb => crumb !== null);
  }
  if (event.contexts !== undefined) out.contexts = scrubContexts(event.contexts);
  if (event.tags !== undefined) out.tags = scrubTags(event.tags);
  if (event.extra !== undefined) out.extra = scrubRecord(event.extra);
  if (event.user?.id !== undefined && USER_ID.test(String(event.user.id))) out.user = { id: event.user.id };
  // The envelope header's trace context is built from this after beforeSend: keep ids only.
  const dsc = event.sdkProcessingMetadata?.dynamicSamplingContext;
  if (dsc !== undefined) out.sdkProcessingMetadata = { dynamicSamplingContext: pick(dsc, DSC_KEYS) };
  return out as T;
}
