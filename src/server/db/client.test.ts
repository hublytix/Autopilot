import { describe, expect, it } from 'vitest';
import { createDb, type Driver, type DriverConnection } from './client';
import { DbError, DbUsageError } from './errors';
import type { DbRow } from './types';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Records every statement and how many ran at once; `gate:<name>` statements wait for `open(name)`. */
class StubDriver implements Driver {
  readonly log: string[] = [];
  inFlight = 0;
  maxInFlight = 0;
  failCommit = false;
  private readonly gates = new Map<string, Deferred>();

  gate(name: string): Deferred {
    let gate = this.gates.get(name);
    if (gate === undefined) {
      gate = deferred();
      this.gates.set(name, gate);
    }
    return gate;
  }

  private conn(label: string): DriverConnection {
    const run = async (sql: string): Promise<DbRow[]> => {
      this.inFlight += 1;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      this.log.push(`${label}: ${sql}`);
      try {
        if (sql.startsWith('gate:')) await this.gate(sql.slice(5)).promise;
        await tick();
        if (sql.startsWith('fail')) {
          throw Object.assign(new Error(`boom ${sql} secret-value`), {
            code: '23505',
            constraint: 'stub_key',
            detail: 'Key (email)=(secret@example.com) already exists.',
          });
        }
        return [{ sql }];
      } finally {
        this.inFlight -= 1;
      }
    };
    return {
      query: (sql) => run(sql),
      exec: async (sql) => {
        await run(sql);
      },
    };
  }

  connection(): Promise<DriverConnection> {
    return Promise.resolve(this.conn('root'));
  }

  async transaction<T>(fn: (connection: DriverConnection) => Promise<T>): Promise<T> {
    this.log.push('BEGIN');
    let result: T;
    try {
      result = await fn(this.conn('tx'));
    } catch (error) {
      this.log.push('ROLLBACK');
      throw error;
    }
    if (this.failCommit) {
      this.log.push('COMMIT failed');
      throw Object.assign(new Error('could not commit: secret-value'), { code: '40001' });
    }
    this.log.push('COMMIT');
    return result;
  }

  close(): Promise<void> {
    this.log.push('CLOSE');
    return Promise.resolve();
  }

  toDbError(error: unknown): DbError {
    const e = error as { code?: string; constraint?: string };
    return new DbError({ sqlstate: e.code, constraint: e.constraint });
  }
}

describe('Db core: one statement at a time (D-28 rule 1)', () => {
  it('serialises concurrent queries on the root handle, in call order', async () => {
    const driver = new StubDriver();
    const db = createDb(driver);
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => db.query<{ sql: string }>(`select ${n}`)));
    expect(driver.maxInFlight).toBe(1);
    expect(results.map((rows) => rows[0]?.sql)).toEqual(['select 1', 'select 2', 'select 3', 'select 4', 'select 5']);
    expect(driver.log).toEqual(['root: select 1', 'root: select 2', 'root: select 3', 'root: select 4', 'root: select 5']);
  });

  it('serialises concurrent queries on a transaction handle', async () => {
    const driver = new StubDriver();
    const db = createDb(driver);
    await db.tx((tx) => Promise.all([tx.query('select 1'), tx.query('select 2'), tx.exec('select 3')]));
    expect(driver.maxInFlight).toBe(1);
    expect(driver.log).toEqual(['BEGIN', 'tx: select 1', 'tx: select 2', 'tx: select 3', 'COMMIT']);
  });

  it('makes another caller wait for an open transaction instead of running inside it', async () => {
    const driver = new StubDriver();
    const db = createDb(driver);
    const txDone = db.tx(async (tx) => {
      await tx.query('gate:hold');
      await tx.query('insert in tx');
    });
    await tick();
    const outside = db.query('select outside');
    await tick();
    expect(driver.log).toEqual(['BEGIN', 'tx: gate:hold']);
    driver.gate('hold').resolve();
    await Promise.all([txDone, outside]);
    expect(driver.log).toEqual(['BEGIN', 'tx: gate:hold', 'tx: insert in tx', 'COMMIT', 'root: select outside']);
  });

  it('lets statements queued inside a transaction finish before COMMIT', async () => {
    const driver = new StubDriver();
    const db = createDb(driver);
    await db.tx(async (tx) => {
      void tx.query('select not awaited');
    });
    expect(driver.log).toEqual(['BEGIN', 'tx: select not awaited', 'COMMIT']);
  });
});

describe('Db core: the handle that opened a transaction is barred inside it (D-28 rule 2)', () => {
  it('throws when the root handle is used inside its own transaction', async () => {
    const driver = new StubDriver();
    const db = createDb(driver);
    let inner: unknown;
    await db.tx(async (tx) => {
      inner = await db.query('select via root').catch((error: unknown) => error);
      await tx.query('select via tx');
    });
    expect(inner).toBeInstanceOf(DbUsageError);
    expect((inner as DbUsageError).code).toBe('db_handle_used_inside_tx');
    expect(driver.log).toEqual(['BEGIN', 'tx: select via tx', 'COMMIT']);
  });

  it('bars root.tx(), root.exec() and root.close() inside the transaction too', async () => {
    const db = createDb(new StubDriver());
    const codes = await db.tx(async () => {
      const attempts = [db.tx(() => Promise.resolve()), db.exec('select 1'), db.close(), db.one('select 1')];
      return Promise.all(attempts.map((p) => p.then(() => 'ok', (error: unknown) => (error as DbUsageError).code)));
    });
    expect(codes).toEqual(Array(4).fill('db_handle_used_inside_tx'));
  });

  it('bars the parent transaction handle inside a nested transaction', async () => {
    const db = createDb(new StubDriver());
    const code = await db.tx(async (tx) =>
      tx.tx(async () => tx.query('select 1').then(() => 'ok', (error: unknown) => (error as DbUsageError).code)),
    );
    expect(code).toBe('db_handle_used_inside_tx');
  });

  it('allows the root handle again once the transaction has ended, even from its old async context', async () => {
    const driver = new StubDriver();
    const db = createDb(driver);
    let later: Promise<unknown> | undefined;
    await db.tx(async () => {
      later = tick().then(() => tick()).then(() => db.query('select after'));
    });
    await later;
    expect(driver.log).toEqual(['BEGIN', 'COMMIT', 'root: select after']);
  });

  it('refuses a transaction handle after its transaction ended', async () => {
    const db = createDb(new StubDriver());
    let escaped: { query: (sql: string) => Promise<unknown> } | undefined;
    await db.tx(async (tx) => {
      escaped = tx;
    });
    await expect(escaped?.query('select 1')).rejects.toMatchObject({ code: 'db_tx_finished' });
  });
});

describe('Db core: transactions', () => {
  it('rethrows the callback error itself and rolls back', async () => {
    const driver = new StubDriver();
    const db = createDb(driver);
    const boom = new Error('callback failed');
    await expect(
      db.tx(async (tx) => {
        await tx.query('insert 1');
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(driver.log).toEqual(['BEGIN', 'tx: insert 1', 'ROLLBACK']);
  });

  it('maps a failed COMMIT to a DbError without the driver message', async () => {
    const driver = new StubDriver();
    driver.failCommit = true;
    const db = createDb(driver);
    const error: unknown = await db.tx((tx) => tx.query('insert 1')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DbError);
    expect(error).toMatchObject({ code: 'db_error', sqlstate: '40001', kind: 'transient', message: 'db_error' });
    expect(JSON.stringify(error)).not.toContain('secret-value');
  });

  it('refuses to commit after a failed statement was swallowed (25P02) and rolls back', async () => {
    const driver = new StubDriver();
    const db = createDb(driver);
    const error: unknown = await db
      .tx(async (tx) => {
        await tx.query('fail insert').catch(() => undefined);
        return 'pretend all is well';
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).sqlstate).toBe('25P02');
    expect(driver.log).toEqual(['BEGIN', 'tx: fail insert', 'ROLLBACK']);
  });

  it('runs a nested transaction as a savepoint and releases it on success', async () => {
    const driver = new StubDriver();
    const db = createDb(driver);
    const result = await db.tx(async (tx) => tx.tx(async (inner) => (await inner.one<{ sql: string }>('select 1')).sql));
    expect(result).toBe('select 1');
    expect(driver.log).toEqual([
      'BEGIN',
      'tx: savepoint autopilot_sp_1',
      'tx: select 1',
      'tx: release savepoint autopilot_sp_1',
      'COMMIT',
    ]);
  });

  it('rolls a failed nested transaction back to its savepoint and lets the outer one commit', async () => {
    const driver = new StubDriver();
    const db = createDb(driver);
    await db.tx(async (tx) => {
      const inner = await tx.tx((nested) => nested.query('fail dup')).catch((error: unknown) => error);
      expect(inner).toMatchObject({ sqlstate: '23505', constraint: 'stub_key' });
      await tx.query('insert after');
    });
    expect(driver.log).toEqual([
      'BEGIN',
      'tx: savepoint autopilot_sp_1',
      'tx: fail dup',
      'tx: rollback to savepoint autopilot_sp_1',
      'tx: release savepoint autopilot_sp_1',
      'tx: insert after',
      'COMMIT',
    ]);
  });
});

describe('Db core: helpers and lifecycle', () => {
  it('one() needs exactly one row and maybeOne() at most one', async () => {
    const returning = (rows: DbRow[]): Driver => ({
      connection: () => Promise.resolve({ query: () => Promise.resolve(rows.map((row) => ({ ...row }))), exec: () => Promise.resolve() }),
      transaction: () => Promise.reject(new Error('unused')),
      close: () => Promise.resolve(),
      toDbError: () => new DbError(),
    });
    const single = createDb(returning([{ n: 1 }]));
    await expect(single.one('select')).resolves.toEqual({ n: 1 });
    await expect(single.maybeOne('select')).resolves.toEqual({ n: 1 });
    const many = createDb(returning([{ n: 1 }, { n: 2 }]));
    await expect(many.one('select')).rejects.toMatchObject({ code: 'db_unexpected_row_count', rowCount: 2 });
    await expect(many.maybeOne('select')).rejects.toMatchObject({ code: 'db_unexpected_row_count', rowCount: 2 });
    const none = createDb(returning([]));
    await expect(none.one('select')).rejects.toMatchObject({ code: 'db_unexpected_row_count', rowCount: 0 });
    await expect(none.maybeOne('select')).resolves.toBeNull();
  });

  it('rejects an undefined parameter before anything reaches the driver', async () => {
    const driver = new StubDriver();
    const db = createDb(driver);
    await expect(db.query('select $1', [undefined])).rejects.toMatchObject({ code: 'db_undefined_param' });
    expect(driver.log).toEqual([]);
  });

  it('close() waits for queued work, closes once, and refuses later use', async () => {
    const driver = new StubDriver();
    const db = createDb(driver);
    const pending = db.query('select pending');
    await db.close();
    await db.close();
    await pending;
    expect(driver.log).toEqual(['root: select pending', 'CLOSE']);
    await expect(db.query('select 1')).rejects.toMatchObject({ code: 'db_closed' });
  });

  it('refuses close() on a transaction handle', async () => {
    const db = createDb(new StubDriver());
    await expect(db.tx((tx) => tx.close())).rejects.toMatchObject({ code: 'db_close_in_tx' });
  });
});
