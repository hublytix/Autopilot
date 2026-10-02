import { describe, expect, it } from 'vitest';
import { DbError } from './errors';
import {
  createPostgresDb,
  createPostgresDbFromClient,
  postgresToDbError,
  type PostgresClientLike,
  type PostgresQueryable,
} from './postgres';

// No test here opens a connection: the live driver is exercised through a stub client.

const FIXTURE_TEXT = 'Hi, I need a quote for 40 chairs - secret-lead@example.com';
const QUERY_TEXT = 'insert into public.lead_messages (lead_id, account_id, message, purge_at) values ($1, $2, $3, $4)';

/** Shaped like a Postgres.js PostgresError (field names from postgres/src/connection.js). */
function postgresError(fields: Record<string, unknown>): Error {
  const error = new Error(`null value in column "purge_at" violates not-null constraint ${FIXTURE_TEXT}`);
  return Object.assign(error, { name: 'PostgresError', ...fields, query: QUERY_TEXT, parameters: ['id', 'acct', FIXTURE_TEXT, null] });
}

class RowList extends Array<Record<string, unknown>> {
  count = 0;
  command = 'SELECT';
}

class StubClient implements PostgresClientLike {
  readonly calls: { where: string; query: string; params: unknown[] | undefined }[] = [];
  nextError: unknown;
  ended = false;

  private queryable(where: string): PostgresQueryable {
    return {
      unsafe: (query, params) => {
        this.calls.push({ where, query, params });
        if (this.nextError !== undefined) {
          const error = this.nextError;
          this.nextError = undefined;
          return Promise.reject(error);
        }
        const rows = new RowList();
        rows.push({ id: '1', at: new Date('2026-10-06T13:00:00.000Z') });
        return Promise.resolve(rows);
      },
    };
  }

  unsafe(query: string, params?: unknown[]): PromiseLike<readonly unknown[]> {
    return this.queryable('root').unsafe(query, params);
  }

  async begin<T>(fn: (sql: PostgresQueryable) => Promise<T>): Promise<T> {
    this.calls.push({ where: 'begin', query: 'BEGIN', params: undefined });
    try {
      const result = await fn(this.queryable('tx'));
      this.calls.push({ where: 'begin', query: 'COMMIT', params: undefined });
      return result;
    } catch (error) {
      this.calls.push({ where: 'begin', query: 'ROLLBACK', params: undefined });
      throw error;
    }
  }

  end(): Promise<void> {
    this.ended = true;
    return Promise.resolve();
  }
}

describe('postgresToDbError', () => {
  it('keeps the SQLSTATE and object names and drops the message, detail, query and parameters', () => {
    const error = postgresToDbError(
      postgresError({
        code: '23502',
        table_name: 'lead_messages',
        column_name: 'purge_at',
        schema_name: 'public',
        detail: `Failing row contains (id, acct, ${FIXTURE_TEXT}, null).`,
      }),
    );
    expect(error).toBeInstanceOf(DbError);
    expect(error).toMatchObject({ code: 'db_error', sqlstate: '23502', table: 'lead_messages', column: 'purge_at', kind: 'permanent' });
    const everything = JSON.stringify({ ...error, message: error.message, stack: error.stack });
    expect(everything).not.toContain('secret-lead');
    expect(everything).not.toContain('40 chairs');
    expect(everything).not.toContain('insert into');
    expect(everything).not.toContain('null value');
  });

  it('carries the constraint name of a unique violation', () => {
    const error = postgresToDbError(postgresError({ code: '23505', constraint_name: 'users_email_lower_key', table_name: 'users' }));
    expect(error.isUniqueViolation('users_email_lower_key')).toBe(true);
  });

  it('maps connection-level failures (no SQLSTATE) to transient errors', () => {
    for (const code of ['CONNECTION_CLOSED', 'CONNECTION_DESTROYED', 'CONNECT_TIMEOUT', 'ECONNRESET', 'ECONNREFUSED']) {
      const error = postgresToDbError(Object.assign(new Error(`connect ${code} 10.0.0.1:6543`), { code }));
      expect(error).toMatchObject({ sqlstate: undefined, kind: 'transient', message: 'db_error' });
    }
  });

  it('maps a server-side transient SQLSTATE to a transient error', () => {
    expect(postgresToDbError(postgresError({ code: '40001' })).kind).toBe('transient');
  });

  it('maps anything else to a permanent error with no fields', () => {
    for (const thrown of [new Error(FIXTURE_TEXT), 'a string', null, Object.assign(new Error('x'), { code: 'UNDEFINED_VALUE' })]) {
      const error = postgresToDbError(thrown);
      expect(error).toMatchObject({ sqlstate: undefined, kind: 'permanent', message: 'db_error' });
    }
  });
});

describe('Postgres.js-backed Db (stub client)', () => {
  it('normalises parameters, then returns plain rows copied out of the RowList', async () => {
    const client = new StubClient();
    const db = createPostgresDbFromClient(client);
    const at = new Date('2026-10-06T13:00:00.000Z');
    const rows = await db.query('select $1, $2, $3', [at, { a: 1 }, 7n]);
    expect(Array.isArray(rows) && !(rows instanceof RowList)).toBe(true);
    expect(rows).toEqual([{ id: '1', at }]);
    expect(client.calls).toEqual([{ where: 'root', query: 'select $1, $2, $3', params: [at, '{"a":1}', '7'] }]);
  });

  it('runs exec() without parameters (simple protocol, several statements)', async () => {
    const client = new StubClient();
    await createPostgresDbFromClient(client).exec('create table a (id int); create table b (id int);');
    expect(client.calls).toEqual([{ where: 'root', query: 'create table a (id int); create table b (id int);', params: undefined }]);
  });

  it('runs a transaction on the begin() connection and maps a failed statement to DbError', async () => {
    const client = new StubClient();
    const db = createPostgresDbFromClient(client);
    await db.tx(async (tx) => {
      await tx.query('select 1');
    });
    client.nextError = postgresError({ code: '23505', constraint_name: 'leads_account_contact_submitted_key', table_name: 'leads' });
    const error: unknown = await db.tx((tx) => tx.query('insert dup')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DbError);
    expect(error).toMatchObject({ sqlstate: '23505', constraint: 'leads_account_contact_submitted_key' });
    expect(client.calls.map((call) => `${call.where}: ${call.query}`)).toEqual([
      'begin: BEGIN',
      'tx: select 1',
      'begin: COMMIT',
      'begin: BEGIN',
      'tx: insert dup',
      'begin: ROLLBACK',
    ]);
  });

  it('ends the client on close()', async () => {
    const client = new StubClient();
    await createPostgresDbFromClient(client).close();
    expect(client.ended).toBe(true);
  });

  it('builds the live client lazily: constructing and closing it opens no connection', async () => {
    const db = createPostgresDb('postgres://autopilot:fake-password@127.0.0.1:1/postgres');
    await expect(db.close()).resolves.toBeUndefined();
  });
});
