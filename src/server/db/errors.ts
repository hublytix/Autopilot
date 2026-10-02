import 'server-only';
import { AppError, PermanentError } from '@/server/domain/errors';

// Database errors (D-28 rule 7, PLAN §10.10). A DbError carries only the SQLSTATE and the names of
// the schema objects involved. It never carries the driver's message, `detail` (which quotes the
// failing row), `hint`, `where`, the query text or the parameters, and it has no `cause`: drivers
// attach the query and its parameters to their errors, so the original error must not travel.

/** Postgres error fields the mapping may keep. All optional; anything malformed is dropped. */
export interface DbErrorFields {
  sqlstate?: string | undefined;
  constraint?: string | undefined;
  table?: string | undefined;
  column?: string | undefined;
  /** Set by the driver for connection-level failures that have no SQLSTATE. */
  connectionFailure?: boolean | undefined;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;
// Identifiers as Postgres reports them for our own schema objects: never data, but still bounded.
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

function safeSqlstate(value: unknown): string | undefined {
  return typeof value === 'string' && SQLSTATE.test(value) ? value : undefined;
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && IDENTIFIER.test(value) ? value : undefined;
}

/**
 * Worth retrying: connection exceptions (08), serialization failure, deadlock, insufficient
 * resources (53), statement timeout and server shutdown or start-up (57P01-57P03).
 */
export function isTransientSqlstate(sqlstate: string | undefined): boolean {
  if (sqlstate === undefined) return false;
  return (
    sqlstate.startsWith('08') ||
    sqlstate.startsWith('53') ||
    sqlstate === '40001' ||
    sqlstate === '40P01' ||
    sqlstate === '57014' ||
    sqlstate === '57P01' ||
    sqlstate === '57P02' ||
    sqlstate === '57P03'
  );
}

/** Every driver error is rethrown as this. `message` and `code` are both `db_error`. */
export class DbError extends AppError {
  override readonly name: string = 'DbError';
  declare readonly code: 'db_error';
  readonly kind: 'transient' | 'permanent';
  /** The Postgres SQLSTATE, e.g. `23505`; undefined for connection-level failures. */
  readonly sqlstate: string | undefined;
  readonly constraint: string | undefined;
  readonly table: string | undefined;
  readonly column: string | undefined;

  constructor(fields: DbErrorFields = {}) {
    super('db_error', undefined);
    this.sqlstate = safeSqlstate(fields.sqlstate);
    this.constraint = safeIdentifier(fields.constraint);
    this.table = safeIdentifier(fields.table);
    this.column = safeIdentifier(fields.column);
    this.kind = fields.connectionFailure === true || isTransientSqlstate(this.sqlstate) ? 'transient' : 'permanent';
  }

  /** A unique violation (23505), optionally on the named constraint or unique index. */
  isUniqueViolation(constraint?: string): boolean {
    return this.sqlstate === '23505' && (constraint === undefined || this.constraint === constraint);
  }
}

export function isDbError(e: unknown): e is DbError {
  return e instanceof DbError;
}

/** Programming errors in how the Db is used. Never retried. */
export type DbUsageErrorCode =
  /** A handle was used inside a transaction it opened, in the same async context (D-28 rule 2). */
  | 'db_handle_used_inside_tx'
  /** A transaction handle was used after its transaction ended. */
  | 'db_tx_finished'
  /** The Db was used after close(). */
  | 'db_closed'
  /** close() was called on a transaction handle. */
  | 'db_close_in_tx'
  /** `one()` got zero or several rows, or `maybeOne()` got several. */
  | 'db_unexpected_row_count'
  /** A parameter was `undefined`; pass `null` explicitly. */
  | 'db_undefined_param'
  /** A parameter of an unsupported type (bytea, NaN, Infinity, an invalid Date, a class instance…). */
  | 'db_unsupported_param';

export class DbUsageError extends PermanentError<DbUsageErrorCode> {
  override readonly name: string = 'DbUsageError';
  declare readonly code: DbUsageErrorCode;
  /** For `db_unexpected_row_count`: how many rows came back. */
  readonly rowCount: number | undefined;

  constructor(code: DbUsageErrorCode, rowCount?: number) {
    super(code);
    this.rowCount = rowCount;
  }
}

export function isDbUsageError(e: unknown): e is DbUsageError {
  return e instanceof DbUsageError;
}
