import 'server-only';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { createDb, type DbClient, type Driver, type DriverConnection } from './client';
import { DbError } from './errors';
import { PGLITE_PARSERS } from './normalize';
import type { Db, DbRow } from './types';

// PGlite-backed Db for tests and fake mode (D-28, D-29). The instance opens lazily on the first
// statement, never at import time, so modules that import the container stay cheap. PGlite is
// Postgres 18 in WASM with one exclusive connection; hosted Supabase is 15/17, so the SQL stays
// conservative.

export interface PgliteDbOptions {
  /** A directory to persist to (fake mode: FAKE_DB_DIR). Omitted or `memory://`: in memory. */
  dataDir?: string | undefined;
  /** Start from a `dumpDataDir()` tarball (the test harness loads one migrated dump per file). */
  loadDataDir?: Blob | undefined;
}

export interface PgliteDb extends Db {
  /** A tarball of the whole data directory, loadable through `loadDataDir`. */
  dumpDataDir(): Promise<Blob>;
}

interface PgliteErrorShape {
  code?: unknown;
  constraint?: unknown;
  table?: unknown;
  column?: unknown;
}

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** Keeps the SQLSTATE and object names only; PGlite's errors also carry the query and its params. */
export function pgliteToDbError(error: unknown): DbError {
  if (error instanceof DbError) return error;
  if (typeof error === 'object' && error !== null) {
    const e = error as PgliteErrorShape;
    return new DbError({
      sqlstate: asString(e.code),
      constraint: asString(e.constraint),
      table: asString(e.table),
      column: asString(e.column),
    });
  }
  return new DbError();
}

function wrap(target: PGlite | Transaction): DriverConnection {
  return {
    async query(sql: string, params: unknown[]): Promise<DbRow[]> {
      return (await target.query<DbRow>(sql, params)).rows;
    },
    async exec(sql: string): Promise<void> {
      await target.exec(sql);
    },
  };
}

class PgliteDriver implements Driver {
  private instance: Promise<PGlite> | undefined;

  constructor(private readonly options: PgliteDbOptions) {}

  pglite(): Promise<PGlite> {
    this.instance ??= PGlite.create({
      ...(this.options.dataDir !== undefined ? { dataDir: this.options.dataDir } : {}),
      ...(this.options.loadDataDir !== undefined ? { loadDataDir: this.options.loadDataDir } : {}),
      parsers: { ...PGLITE_PARSERS },
    }).catch((error: unknown) => {
      // Let the next statement try again instead of caching the failure.
      this.instance = undefined;
      throw error;
    });
    return this.instance;
  }

  async connection(): Promise<DriverConnection> {
    return wrap(await this.pglite());
  }

  async transaction<T>(fn: (connection: DriverConnection) => Promise<T>): Promise<T> {
    const pglite = await this.pglite();
    return pglite.transaction((tx) => fn(wrap(tx)));
  }

  async close(): Promise<void> {
    const opening = this.instance;
    if (opening === undefined) return;
    const pglite = await opening.catch(() => undefined);
    if (pglite !== undefined && !pglite.closed) await pglite.close();
  }

  toDbError(error: unknown): DbError {
    return pgliteToDbError(error);
  }
}

class PgliteDbImpl implements PgliteDb {
  private readonly client: DbClient;

  constructor(private readonly driver: PgliteDriver) {
    this.client = createDb(driver);
  }

  query<Row extends object = DbRow>(sql: string, params?: readonly unknown[]): Promise<Row[]> {
    return this.client.query<Row>(sql, params);
  }

  one<Row extends object = DbRow>(sql: string, params?: readonly unknown[]): Promise<Row> {
    return this.client.one<Row>(sql, params);
  }

  maybeOne<Row extends object = DbRow>(sql: string, params?: readonly unknown[]): Promise<Row | null> {
    return this.client.maybeOne<Row>(sql, params);
  }

  exec(sql: string): Promise<void> {
    return this.client.exec(sql);
  }

  tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.client.tx(fn);
  }

  close(): Promise<void> {
    return this.client.close();
  }

  dumpDataDir(): Promise<Blob> {
    return this.client.exclusive(async () => {
      try {
        return await (await this.driver.pglite()).dumpDataDir('none');
      } catch (error) {
        throw pgliteToDbError(error);
      }
    });
  }
}

/** A PGlite-backed Db. Nothing opens until the first statement. */
export function createPgliteDb(options: PgliteDbOptions = {}): PgliteDb {
  return new PgliteDbImpl(new PgliteDriver(options));
}
