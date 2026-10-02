import 'server-only';
import postgres from 'postgres';
import { createDb, type Driver, type DriverConnection } from './client';
import { DbError } from './errors';
import { POSTGRES_JS_TYPES } from './normalize';
import type { Db, DbRow } from './types';

// Postgres.js-backed Db for live mode: the Supabase transaction pooler (:6543) with
// {max: 1, prepare: false, ssl: 'require'} (D-28, SB-DB-ACCESS-LAYER). Postgres.js pipelines
// queries by default, which the pooler's transaction mode turns into hung queries or mismatched
// rows; the Db queue (client.ts) is what keeps statements strictly one at a time.

/** The slice of a Postgres.js `Sql` (or a transaction's `sql`) this module uses; tests stub it. */
export interface PostgresQueryable {
  unsafe(query: string, params?: unknown[]): PromiseLike<readonly unknown[]>;
}

export interface PostgresClientLike extends PostgresQueryable {
  begin<T>(fn: (sql: PostgresQueryable) => Promise<T>): PromiseLike<T>;
  end(options?: { timeout?: number }): PromiseLike<void>;
}

interface PostgresErrorShape {
  name?: unknown;
  code?: unknown;
  constraint_name?: unknown;
  table_name?: unknown;
  column_name?: unknown;
}

// Postgres.js connection errors (no SQLSTATE) and Node socket errors: the server was never reached
// or the connection broke, so the statement may be retried.
const CONNECTION_ERROR_CODES = new Set([
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/**
 * Keeps the SQLSTATE and object names only. Postgres.js errors carry `detail` (the failing row),
 * and attach the query text and parameters as properties.
 */
export function postgresToDbError(error: unknown): DbError {
  if (error instanceof DbError) return error;
  if (typeof error !== 'object' || error === null) return new DbError();
  const e = error as PostgresErrorShape;
  const code = asString(e.code);
  if (e.name === 'PostgresError') {
    return new DbError({
      sqlstate: code,
      constraint: asString(e.constraint_name),
      table: asString(e.table_name),
      column: asString(e.column_name),
    });
  }
  return new DbError({ connectionFailure: code !== undefined && CONNECTION_ERROR_CODES.has(code) });
}

function wrap(sql: PostgresQueryable): DriverConnection {
  return {
    async query(query: string, params: unknown[]): Promise<DbRow[]> {
      const rows = await sql.unsafe(query, params);
      // A RowList is an Array subclass with extra fields (count, command, columns): copy the rows out.
      return Array.from(rows as readonly DbRow[]);
    },
    async exec(query: string): Promise<void> {
      // No parameters: Postgres.js uses the simple protocol, which accepts several statements.
      await sql.unsafe(query);
    },
  };
}

class PostgresDriver implements Driver {
  constructor(private readonly sql: PostgresClientLike) {}

  connection(): Promise<DriverConnection> {
    return Promise.resolve(wrap(this.sql));
  }

  async transaction<T>(fn: (connection: DriverConnection) => Promise<T>): Promise<T> {
    return await this.sql.begin((tx) => fn(wrap(tx)));
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  toDbError(error: unknown): DbError {
    return postgresToDbError(error);
  }
}

/** A Db over any Postgres.js-compatible client. Tests pass a stub; live code uses `createPostgresDb`. */
export function createPostgresDbFromClient(sql: PostgresClientLike): Db {
  return createDb(new PostgresDriver(sql));
}

/**
 * The live Db. Postgres.js connects lazily, on the first statement. `databaseUrl` is the Supabase
 * transaction pooler URL (DATABASE_URL, server-only).
 */
export function createPostgresDb(databaseUrl: string): Db {
  const sql = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    ssl: 'require',
    connect_timeout: 10,
    // Notices are not errors and may name objects; never print them.
    onnotice: () => undefined,
    types: POSTGRES_JS_TYPES,
    connection: { application_name: 'autopilot' },
  });
  const client: PostgresClientLike = {
    unsafe: (query, params) => sql.unsafe<DbRow[]>(query, params as postgres.ParameterOrJSON<never>[] | undefined),
    begin: <T>(fn: (tx: PostgresQueryable) => Promise<T>) =>
      sql.begin(
        (tx) =>
          fn({
            unsafe: (query, params) => tx.unsafe<DbRow[]>(query, params as postgres.ParameterOrJSON<never>[] | undefined),
          }) as Promise<T>,
      ) as PromiseLike<T>,
    end: (options) => sql.end(options),
  };
  return createPostgresDbFromClient(client);
}
