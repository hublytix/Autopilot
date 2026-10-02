import 'server-only';
import type { Clock } from '@/server/ports/clock';
import { REDACTED, isSafeCode, redact } from '@/shared/observability/redact';

// JSON-line logger (PLAN §11, §10.10, law 4).
// - `msg` is a static string literal (a `string`-typed message does not compile);
// - fields come from an allow-list (event, ids, codes, counts, durations); anything else is
//   dropped and counted in `droppedFields`;
// - values are primitives (or short arrays of them); strings pass through the shared redact()
//   and are truncated; code-valued fields (event, code, status, …) keep only code-shaped values;
//   objects are never logged wholesale;
// - an error contributes only its name, a code-shaped `code`, a SQLSTATE and an HTTP status,
//   never its message or stack (both can quote input).
// Timestamps come from an injected Clock (D-28); without one the platform's log time is used.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const LOG_FIELDS = [
  // what happened
  'event', 'code', 'codes', 'kind', 'status', 'processingState', 'outcome', 'reason', 'mode', 'runtime', 'purpose',
  'route', 'method', 'provider', 'model', 'kid',
  // ids (never emails, tokens or content)
  'accountId', 'userId', 'authUserId', 'leadId', 'draftId', 'jobId', 'jobKind', 'notificationId',
  'notificationKind', 'subscriptionId', 'portalId', 'formId', 'contactId', 'connectionId', 'requestId',
  'messageId', 'reportId', 'briefJobId', 'webhookEventId', 'reservationId', 'deliveryId',
  // counts
  'count', 'attempt', 'attempts', 'hops', 'retries', 'total', 'skipped', 'limit', 'remaining', 'pages', 'bytes',
  'inputTokens', 'outputTokens',
  // durations
  'durationMs', 'delayMs', 'retryAfterMs', 'elapsedMs', 'timeoutMs',
  // errors
  'httpStatus', 'sqlstate', 'constraint', 'table', 'column', 'errorName', 'errorCode',
] as const;

export type LogField = (typeof LOG_FIELDS)[number];
type LogScalar = string | number | boolean | null;
export type LogValue = LogScalar | readonly LogScalar[];
export type LogFields = Partial<Record<LogField, LogValue | undefined>>;

/** Accepts only string-literal messages: `string` itself (e.g. a template literal) is rejected. */
export type StaticMessage<M extends string> = string extends M ? never : M;

export interface Logger {
  debug<M extends string>(msg: StaticMessage<M>, fields?: LogFields, error?: unknown): void;
  info<M extends string>(msg: StaticMessage<M>, fields?: LogFields, error?: unknown): void;
  warn<M extends string>(msg: StaticMessage<M>, fields?: LogFields, error?: unknown): void;
  error<M extends string>(msg: StaticMessage<M>, fields?: LogFields, error?: unknown): void;
  /** A logger that adds `fields` to every line. */
  child(fields: LogFields): Logger;
}

export type LogSink = (line: string, level: LogLevel) => void;

export interface LoggerOptions {
  sink?: LogSink | undefined;
  clock?: Clock | undefined;
  minLevel?: LogLevel | undefined;
}

const ALLOWED = new Set<string>(LOG_FIELDS);
// Fields whose values are codes chosen by our code: anything else (e.g. free text with spaces)
// is replaced, not just redacted.
const CODE_FIELDS = new Set<string>([
  'event', 'code', 'codes', 'kind', 'status', 'processingState', 'outcome', 'reason', 'mode', 'runtime', 'purpose',
  'method', 'provider', 'model', 'kid', 'jobKind', 'notificationKind', 'errorName', 'errorCode', 'sqlstate',
  'constraint', 'table', 'column',
]);
const CODE_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const MAX_STRING = 256;
const MAX_ARRAY = 20;
const IDENTIFIER = /^[A-Za-z_$][\w$.]{0,63}$/;
const ERROR_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;

function cleanString(value: string): string {
  const redacted = redact(value);
  return redacted.length > MAX_STRING ? `${redacted.slice(0, MAX_STRING)}…` : redacted;
}

function cleanScalar(value: unknown): LogScalar | undefined {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return cleanString(value);
  return undefined;
}

function cleanCode(value: LogScalar | undefined): LogScalar | undefined {
  return typeof value === 'string' && !CODE_VALUE.test(value) ? REDACTED : value;
}

function cleanValue(key: string, value: unknown): LogValue | undefined {
  const clean = CODE_FIELDS.has(key) ? (item: unknown) => cleanCode(cleanScalar(item)) : cleanScalar;
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map(clean);
    return items.every((item) => item !== undefined) ? (items as LogScalar[]) : undefined;
  }
  return clean(value);
}

/** The parts of an error that are safe to log. */
export function errorFields(error: unknown): LogFields {
  if (error === null || typeof error !== 'object') return { errorName: typeof error };
  const record = error as Record<string, unknown>;
  const fields: LogFields = {};
  const name = record.name;
  fields.errorName = typeof name === 'string' && IDENTIFIER.test(name) ? name : 'Error';
  const code = record.code;
  if (typeof code === 'string' && ERROR_CODE.test(code)) fields.errorCode = code;
  const sqlstate = record.sqlstate;
  if (typeof sqlstate === 'string' && SQLSTATE.test(sqlstate)) fields.sqlstate = sqlstate;
  const status = record.httpStatus ?? record.status;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) fields.httpStatus = status;
  return fields;
}

const defaultSink: LogSink = (line, level) => {
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
};

export function createLogger(options: LoggerOptions = {}, bound: LogFields = {}): Logger {
  const sink = options.sink ?? defaultSink;
  const minRank = LEVEL_RANK[options.minLevel ?? 'info'];

  function write(level: LogLevel, msg: string, fields: LogFields | undefined, error: unknown): void {
    if (LEVEL_RANK[level] < minRank) return;
    const line: Record<string, unknown> = { level };
    if (options.clock !== undefined) line.time = options.clock.now().toISOString();
    // Static by type; still redacted in case a cast slipped content in.
    line.msg = isSafeCode(msg) ? msg : cleanString(msg);
    let dropped = 0;
    const merged: Record<string, unknown> = { ...bound, ...fields, ...(error === undefined ? {} : errorFields(error)) };
    for (const [key, value] of Object.entries(merged)) {
      if (value === undefined) continue;
      if (!ALLOWED.has(key)) {
        dropped += 1;
        continue;
      }
      const clean = cleanValue(key, value);
      if (clean === undefined) dropped += 1;
      else line[key] = clean;
    }
    if (dropped > 0) line.droppedFields = dropped;
    sink(JSON.stringify(line), level);
  }

  return {
    debug: (msg, fields, error) => write('debug', msg, fields, error),
    info: (msg, fields, error) => write('info', msg, fields, error),
    warn: (msg, fields, error) => write('warn', msg, fields, error),
    error: (msg, fields, error) => write('error', msg, fields, error),
    child: (fields) => createLogger(options, { ...bound, ...fields }),
  };
}

/** The process logger (stdout/stderr, no timestamps: the platform adds them). */
export const log: Logger = createLogger();
