import type { Db, DbRow } from '@/server/db';

// Sequential replays of races (PLAN §12 "Locking and race semantics"): PGlite has one connection, so
// a concurrent writer is simulated by running its statement on the same handle just before the
// statement under test. `interceptBefore` returns a Db whose first statement matching `match` (on
// the handle itself or inside any transaction opened through it) first runs `before` on the handle
// in use, then runs as usual.

export interface Interception {
  readonly db: Db;
  /** How many times `before` ran (0 or 1). */
  readonly fired: () => number;
}

export function interceptBefore(db: Db, match: RegExp, before: (handle: Db) => Promise<void>, options: { times?: number } = {}): Interception {
  const limit = options.times ?? 1;
  let fired = 0;

  const wrap = (handle: Db): Db => {
    const maybeFire = async (sql: string): Promise<void> => {
      if (fired >= limit || !match.test(sql)) return;
      fired += 1;
      await before(handle);
    };
    return {
      async query<Row extends object = DbRow>(sql: string, params?: readonly unknown[]): Promise<Row[]> {
        await maybeFire(sql);
        return handle.query<Row>(sql, params);
      },
      async one<Row extends object = DbRow>(sql: string, params?: readonly unknown[]): Promise<Row> {
        await maybeFire(sql);
        return handle.one<Row>(sql, params);
      },
      async maybeOne<Row extends object = DbRow>(sql: string, params?: readonly unknown[]): Promise<Row | null> {
        await maybeFire(sql);
        return handle.maybeOne<Row>(sql, params);
      },
      exec: (sql: string) => handle.exec(sql),
      tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
        return handle.tx((inner) => fn(wrap(inner)));
      },
      close: () => handle.close(),
    };
  };

  return { db: wrap(db), fired: () => fired };
}

/** A Db that records every statement run through it (and its transactions), in order. */
export function recordStatements(db: Db): { db: Db; statements: string[] } {
  const statements: string[] = [];
  const wrap = (handle: Db): Db => ({
    async query<Row extends object = DbRow>(sql: string, params?: readonly unknown[]): Promise<Row[]> {
      statements.push(sql);
      return handle.query<Row>(sql, params);
    },
    async one<Row extends object = DbRow>(sql: string, params?: readonly unknown[]): Promise<Row> {
      statements.push(sql);
      return handle.one<Row>(sql, params);
    },
    async maybeOne<Row extends object = DbRow>(sql: string, params?: readonly unknown[]): Promise<Row | null> {
      statements.push(sql);
      return handle.maybeOne<Row>(sql, params);
    },
    exec: (sql: string) => handle.exec(sql),
    tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      return handle.tx((inner) => fn(wrap(inner)));
    },
    close: () => handle.close(),
  });
  return { db: wrap(db), statements };
}

/** A Db that knows whether a statement is running inside one of its transactions. */
export function trackTransactions(db: Db): { db: Db; depth: () => number } {
  let depth = 0;
  const wrap = (handle: Db): Db => ({
    query: (sql, params) => handle.query(sql, params),
    one: (sql, params) => handle.one(sql, params),
    maybeOne: (sql, params) => handle.maybeOne(sql, params),
    exec: (sql: string) => handle.exec(sql),
    tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      return handle.tx(async (inner) => {
        depth += 1;
        try {
          return await fn(wrap(inner));
        } finally {
          depth -= 1;
        }
      });
    },
    close: () => handle.close(),
  });
  return { db: wrap(db), depth: () => depth };
}

/** The ports that reach the network (CLAUDE.md: no transaction is held across network I/O). */
const NETWORK_PORTS = ['hubspot', 'llm', 'mailer', 'scheduler', 'billing', 'webFetcher', 'auth'] as const;

/**
 * `deps` whose network ports throw when called while one of its database transactions is open, so a
 * QStash cancel, an email or a HubSpot read moved inside a transaction fails the test. `calls` lists
 * the port calls made outside transactions (`scheduler.cancel`, …).
 */
export function forbidNetworkInTransactions<D extends { db: Db } & Record<(typeof NETWORK_PORTS)[number], object>>(deps: D): { deps: D; calls: string[] } {
  const tracked = trackTransactions(deps.db);
  const calls: string[] = [];
  const guarded = { ...deps, db: tracked.db } as D;
  for (const port of NETWORK_PORTS) {
    const target = deps[port];
    (guarded as Record<string, unknown>)[port] = new Proxy(target, {
      get(object, property, receiver) {
        const value: unknown = Reflect.get(object, property, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const name = `${port}.${String(property)}`;
          if (tracked.depth() > 0) throw new Error(`network call inside a database transaction: ${name}`);
          calls.push(name);
          return (value as (...a: unknown[]) => unknown).apply(object, args);
        };
      },
    });
  }
  return { deps: guarded, calls };
}
