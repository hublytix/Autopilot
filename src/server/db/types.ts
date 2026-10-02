import 'server-only';

/** A result row as the drivers return it after normalisation (see `Db`). */
export type DbRow = Record<string, unknown>;

/**
 * The thin data-access interface every repository uses (D-28). Live: Postgres.js on the Supabase
 * transaction pooler (`postgres.ts`); tests and fake mode: PGlite running the same SQL (`pglite.ts`).
 *
 * Rules:
 * 1. Queries on one client run one at a time, never concurrently: each handle has an internal queue,
 *    so `Promise.all` over one handle is safe (it is serialised), and pipelining never reaches the
 *    pooler.
 * 2. `tx(fn)` passes `fn` a transaction handle. Inside `fn`, in the same async context, the handle
 *    that opened the transaction throws `DbUsageError('db_handle_used_inside_tx')` instead of
 *    deadlocking or silently running outside the transaction (AsyncLocalStorage). Other callers just
 *    wait their turn. `tx()` on a transaction handle opens a savepoint (a nested transaction).
 * 3. Never hold a transaction across network I/O: no HubSpot, Resend, QStash, Razorpay, Anthropic or
 *    fetch call inside `fn`. Reserve inside the transaction, commit, then call out, then record the
 *    outcome in a second transaction (PLAN §8.3, §8.4).
 * 4. Concurrency control is single-statement compare-and-set or lease updates only.
 * 5. Every logical timestamp is bound from the Clock as a parameter (`$n` = `deps.clock.now()`);
 *    SQL never calls now()/current_timestamp (the audit-only defaults are the only exception).
 * 6. Results are normalised identically on both drivers: int8 and numeric → string; timestamptz →
 *    Date; date → 'YYYY-MM-DD' string; json/jsonb → parsed value; int2/int4/float → number; arrays →
 *    arrays. bytea is never used (hashes are hex text).
 *    Parameters: `null` for NULL (`undefined` throws); Date, string, number, boolean, bigint (sent as
 *    a string); arrays of those for Postgres arrays; a plain object is sent as JSON text (for jsonb).
 *    To store a JSON array or a JSON string in a jsonb column, pass `JSON.stringify(value)`.
 * 7. Every driver error is rethrown as `DbError` {code 'db_error', sqlstate, constraint, table,
 *    column}: never the driver's message, detail, query text or parameters.
 *
 * If a statement fails inside a transaction and `fn` swallows the error, the transaction cannot
 * commit: `tx()` rolls back and rejects with `DbError` sqlstate 25P02. To survive a failure, run the
 * risky statement in a nested `tx()` (a savepoint) and catch its rejection.
 */
export interface Db {
  /** Runs one parameterised statement and returns its rows (an unchecked cast to `Row`). */
  query<Row extends object = DbRow>(sql: string, params?: readonly unknown[]): Promise<Row[]>;
  /** Like `query`, but throws `DbUsageError('db_unexpected_row_count')` unless exactly one row came back. */
  one<Row extends object = DbRow>(sql: string, params?: readonly unknown[]): Promise<Row>;
  /** Like `query`: null for no row, the row for one, and throws for more than one. */
  maybeOne<Row extends object = DbRow>(sql: string, params?: readonly unknown[]): Promise<Row | null>;
  /** Runs several statements without parameters. For migrations and test setup only. */
  exec(sql: string): Promise<void>;
  /** Runs `fn` in a transaction (a savepoint when called on a transaction handle). Commits when `fn` resolves. */
  tx<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  /** Waits for queued work, then closes the client. Idempotent; throws on a transaction handle. */
  close(): Promise<void>;
}
