import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DbError, DbUsageError } from './errors';
import { normalizeParams, normalizeRows } from './normalize';
import type { Db, DbRow } from './types';

// The driver-independent half of the Db (D-28): the per-handle queue (rule 1), the
// handle-inside-its-own-transaction guard (rule 2), savepoints for nested transactions, the
// failed-transaction guard, row-count helpers and parameter normalisation. pglite.ts and postgres.ts
// each supply a Driver.

/** One connection: the client's own, or the one a transaction holds. */
export interface DriverConnection {
  /** One parameterised statement. Rows come back already parsed by the driver's type parsers. */
  query(sql: string, params: unknown[]): Promise<DbRow[]>;
  /** Several statements, no parameters. */
  exec(sql: string): Promise<void>;
}

export interface Driver {
  /** The client's own connection; may open the client lazily. */
  connection(): Promise<DriverConnection>;
  /** BEGIN, `fn`, COMMIT; ROLLBACK and rethrow `fn`'s error when it rejects. */
  transaction<T>(fn: (connection: DriverConnection) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  /** Maps anything the driver threw to a DbError that keeps only the safe fields. */
  toDbError(error: unknown): DbError;
}

/** Runs tasks one at a time, in call order. */
class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Resolves once every task queued so far has settled. */
  drain(): Promise<void> {
    return this.run(() => Promise.resolve());
  }
}

/**
 * Marks the async context of a transaction callback: inside it, the handle that opened the
 * transaction must not be used (its queue is held by the transaction, so it would deadlock or run
 * outside the transaction). One AsyncLocalStorage for the module; the barriers form a chain.
 */
interface Barrier {
  readonly handle: Handle;
  active: boolean;
  readonly parent: Barrier | undefined;
}
const barriers = new AsyncLocalStorage<Barrier>();

/** State shared by every level (savepoint) of one transaction. */
interface TxState {
  /** A statement failed, so the transaction is unusable until rolled back (to a savepoint). */
  aborted: boolean;
  savepoints: number;
}

abstract class Handle implements Db {
  protected readonly queue = new SerialQueue();

  protected constructor(protected readonly driver: Driver) {}

  /** Throws when this handle may no longer be used (closed or finished). */
  protected abstract assertOpen(): void;
  /** The connection this handle's statements run on. */
  protected abstract connection(): Promise<DriverConnection>;
  /** Called with every driver failure, before the mapped error is thrown. */
  protected abstract onDriverError(): void;
  protected abstract runTx<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  abstract close(): Promise<void>;

  protected guard(): void {
    this.assertOpen();
    for (let barrier = barriers.getStore(); barrier !== undefined; barrier = barrier.parent) {
      if (barrier.handle === this && barrier.active) throw new DbUsageError('db_handle_used_inside_tx');
    }
  }

  /** Runs `fn(child)` behind a barrier on this handle, then ends the child. */
  protected async inScope<T>(child: TxHandle, fn: (tx: Db) => Promise<T>): Promise<T> {
    const barrier: Barrier = { handle: this, active: true, parent: barriers.getStore() };
    try {
      return await barriers.run(barrier, () => fn(child));
    } finally {
      barrier.active = false;
      // Refuse new statements on the child, then let the ones it already queued finish, so nothing
      // runs on the connection after the transaction (or savepoint) ends.
      await child.finish();
    }
  }

  protected async statement<T>(run: (connection: DriverConnection) => Promise<T>): Promise<T> {
    try {
      return await run(await this.connection());
    } catch (error) {
      this.onDriverError();
      throw this.driver.toDbError(error);
    }
  }

  async query<Row extends object = DbRow>(sql: string, params?: readonly unknown[]): Promise<Row[]> {
    this.guard();
    const values = normalizeParams(params);
    const rows = await this.queue.run(() => this.statement((connection) => connection.query(sql, values)));
    return normalizeRows(rows) as unknown as Row[];
  }

  async one<Row extends object = DbRow>(sql: string, params?: readonly unknown[]): Promise<Row> {
    const rows = await this.query<Row>(sql, params);
    const [row] = rows;
    if (rows.length !== 1 || row === undefined) throw new DbUsageError('db_unexpected_row_count', rows.length);
    return row;
  }

  async maybeOne<Row extends object = DbRow>(sql: string, params?: readonly unknown[]): Promise<Row | null> {
    const rows = await this.query<Row>(sql, params);
    if (rows.length > 1) throw new DbUsageError('db_unexpected_row_count', rows.length);
    return rows[0] ?? null;
  }

  async exec(sql: string): Promise<void> {
    this.guard();
    await this.queue.run(() => this.statement((connection) => connection.exec(sql)));
  }

  async tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    this.guard();
    return this.queue.run(() => this.runTx(fn));
  }
}

class RootHandle extends Handle {
  private closed = false;

  constructor(driver: Driver) {
    super(driver);
  }

  protected assertOpen(): void {
    if (this.closed) throw new DbUsageError('db_closed');
  }

  protected connection(): Promise<DriverConnection> {
    return this.driver.connection();
  }

  protected onDriverError(): void {
    // Autocommit: a failed statement leaves nothing to roll back.
  }

  protected async runTx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    // Errors from `fn` (including DbErrors already mapped inside it) pass through unchanged; only a
    // failure of BEGIN, COMMIT or ROLLBACK themselves comes from the driver and needs mapping.
    let fromCallback: { error: unknown } | undefined;
    try {
      return await this.driver.transaction(async (connection) => {
        try {
          const state: TxState = { aborted: false, savepoints: 0 };
          const result = await this.inScope(new TxHandle(this.driver, connection, state), fn);
          // COMMIT on an aborted transaction silently rolls back: make that loud instead.
          if (state.aborted) throw new DbError({ sqlstate: '25P02' });
          return result;
        } catch (error) {
          fromCallback = { error };
          throw error;
        }
      });
    } catch (error) {
      if (fromCallback !== undefined && error === fromCallback.error) throw error;
      throw this.driver.toDbError(error);
    }
  }

  /** Runs `task` in this client's queue: no statement or transaction is in flight meanwhile. */
  async exclusive<T>(task: () => Promise<T>): Promise<T> {
    this.guard();
    return this.queue.run(task);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.guard();
    this.closed = true;
    await this.queue.drain();
    await this.driver.close();
  }
}

class TxHandle extends Handle {
  private finished = false;

  constructor(
    driver: Driver,
    private readonly conn: DriverConnection,
    private readonly state: TxState,
  ) {
    super(driver);
  }

  protected assertOpen(): void {
    if (this.finished) throw new DbUsageError('db_tx_finished');
  }

  protected connection(): Promise<DriverConnection> {
    return Promise.resolve(this.conn);
  }

  protected onDriverError(): void {
    this.state.aborted = true;
  }

  /** Ends this handle: later calls throw, already queued ones run to completion first. */
  async finish(): Promise<void> {
    this.finished = true;
    await this.queue.drain();
  }

  protected async runTx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    this.state.savepoints += 1;
    const savepoint = `autopilot_sp_${this.state.savepoints}`;
    await this.statement((connection) => connection.query(`savepoint ${savepoint}`, []));
    let result: T;
    try {
      result = await this.inScope(new TxHandle(this.driver, this.conn, this.state), fn);
    } catch (error) {
      await this.rollbackTo(savepoint);
      throw error;
    }
    if (this.state.aborted) {
      await this.rollbackTo(savepoint);
      throw new DbError({ sqlstate: '25P02' });
    }
    await this.statement((connection) => connection.query(`release savepoint ${savepoint}`, []));
    return result;
  }

  private async rollbackTo(savepoint: string): Promise<void> {
    await this.statement((connection) => connection.query(`rollback to savepoint ${savepoint}`, []));
    this.state.aborted = false;
    await this.statement((connection) => connection.query(`release savepoint ${savepoint}`, []));
  }

  close(): Promise<void> {
    return Promise.reject(new DbUsageError('db_close_in_tx'));
  }
}

/** The root handle, plus a hook for driver-specific maintenance (e.g. PGlite's dump). */
export interface DbClient extends Db {
  /** Runs `task` while no statement or transaction is in flight on this client. */
  exclusive<T>(task: () => Promise<T>): Promise<T>;
}

/** Wraps a driver in the Db contract. */
export function createDb(driver: Driver): DbClient {
  return new RootHandle(driver);
}
