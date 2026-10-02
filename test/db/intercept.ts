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
