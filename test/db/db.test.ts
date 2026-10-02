import { describe, expect, it } from 'vitest';
import { DbError, DbUsageError } from '@/server/db/errors';
import type { Db } from '@/server/db/types';
import { useTestDb } from './harness';

// The Db contract (D-28) against real PGlite, on the migrated schema.

const NOW = new Date('2026-10-06T13:00:00.000Z');
const DAY_MS = 86_400_000;
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);

// Content a lead could submit: it must never reach an error (law 4).
const SECRET_MESSAGE = 'Please quote 40 standing desks, budget is tight - fixture-msg-7f3a';
const SECRET_EMAIL = 'fixture-lead-7f3a@example.com';

async function insertAccount(db: Db, portalId = '1001'): Promise<string> {
  const row = await db.one<{ id: string }>(
    `insert into public.accounts
       (hubspot_portal_id, processing_state_changed_at, trial_started_at, trial_ends_at, last_install_at, created_at)
     values ($1, $2, $2, $3, $2, $2)
     returning id`,
    [portalId, NOW, at(14 * DAY_MS)],
  );
  return row.id;
}

async function insertLead(db: Db, accountId: string, contactId = '501'): Promise<string> {
  const row = await db.one<{ id: string }>(
    `insert into public.leads (account_id, hubspot_contact_id, form_id, submitted_at, intake_trigger, received_at)
     values ($1, $2, 'form-1', $3, 'cron', $3)
     returning id`,
    [accountId, contactId, NOW],
  );
  return row.id;
}

/** Everything an error exposes when serialised, logged or reported. */
function exposed(error: unknown): string {
  const e = error as Error;
  return JSON.stringify({ ...e, name: e.name, message: e.message, stack: e.stack, string: String(e) });
}

describe('Db on PGlite', () => {
  const getDb = useTestDb();

  describe('normalisation (D-28 rule 6)', () => {
    it('returns int8 and numeric as strings, timestamptz as Date, date as text, jsonb parsed, arrays as arrays', async () => {
      const row = await getDb().one(
        `select 9007199254740993::int8 as big, count(*) as n, 1.50::numeric as amount, 7::int4 as small,
                $1::timestamptz as at, '2026-10-05'::date as day, '{"a":[1,2],"b":null}'::jsonb as doc,
                array['x','y']::text[] as list, array[1,2]::int8[] as bigs, true as flag`,
        [NOW],
      );
      expect(row).toEqual({
        big: '9007199254740993',
        n: '1',
        amount: '1.50',
        small: 7,
        at: NOW,
        day: '2026-10-05',
        doc: { a: [1, 2], b: null },
        list: ['x', 'y'],
        bigs: ['1', '2'],
        flag: true,
      });
      expect(row['at']).toBeInstanceOf(Date);
    });

    it('returns identity ids from log tables as strings', async () => {
      const db = getDb();
      const first = await db.one<{ id: unknown }>(`insert into public.audit_log (actor, action) values ('system', 'test') returning id`);
      expect(first.id).toBe('1');
    });

    it('stores a plain-object parameter as jsonb and binds Date parameters exactly', async () => {
      const db = getDb();
      const accountId = await insertAccount(db);
      await db.query(`insert into public.audit_log (account_id, at, actor, action, meta) values ($1, $2, 'owner', 'paused', $3)`, [
        accountId,
        NOW,
        { previous: 'active', count: 2 },
      ]);
      const row = await db.one<{ at: Date; meta: unknown }>('select at, meta from public.audit_log where account_id = $1', [accountId]);
      expect(row.at.toISOString()).toBe(NOW.toISOString());
      expect(row.meta).toEqual({ previous: 'active', count: 2 });
    });
  });

  describe('one statement at a time (rule 1)', () => {
    it('answers concurrent queries on one handle correctly and in order', async () => {
      const db = getDb();
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => db.one<{ n: number }>('select $1::int4 as n', [i])));
      expect(results.map((row) => row.n)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    });
  });

  describe('transactions (rule 2)', () => {
    it('commits when the callback resolves', async () => {
      const db = getDb();
      const accountId = await db.tx((tx) => insertAccount(tx));
      expect(await db.maybeOne('select id from public.accounts where id = $1', [accountId])).toEqual({ id: accountId });
    });

    it('rolls back and rethrows the same error when the callback rejects', async () => {
      const db = getDb();
      const boom = new Error('callback failed');
      await expect(
        db.tx(async (tx) => {
          await insertAccount(tx, '2002');
          throw boom;
        }),
      ).rejects.toBe(boom);
      expect(await db.query(`select id from public.accounts where hubspot_portal_id = '2002'`)).toEqual([]);
    });

    it('throws when the root handle is used inside its own transaction, without breaking the transaction', async () => {
      const db = getDb();
      const accountId = await db.tx(async (tx) => {
        const misuse = await db.query('select 1').catch((error: unknown) => error);
        expect(misuse).toBeInstanceOf(DbUsageError);
        expect((misuse as DbUsageError).code).toBe('db_handle_used_inside_tx');
        return insertAccount(tx);
      });
      expect(await db.query('select id from public.accounts where id = $1', [accountId])).toHaveLength(1);
    });

    it('makes a caller outside the transaction wait for it, then see its committed rows', async () => {
      const db = getDb();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const txDone = db.tx(async (tx) => {
        await insertAccount(tx, '3003');
        await held;
      });
      const outside = db.query<{ n: string }>(`select count(*) as n from public.accounts where hubspot_portal_id = '3003'`);
      release();
      await txDone;
      expect(await outside).toEqual([{ n: '1' }]);
    });

    it('refuses to commit a transaction whose failed statement was swallowed', async () => {
      const db = getDb();
      const error: unknown = await db
        .tx(async (tx) => {
          await insertAccount(tx, '4004');
          await tx.query('select * from public.no_such_table').catch(() => undefined);
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DbError);
      expect((error as DbError).sqlstate).toBe('25P02');
      expect(await db.query(`select id from public.accounts where hubspot_portal_id = '4004'`)).toEqual([]);
    });

    it('rolls a failed nested transaction back to its savepoint and commits the rest', async () => {
      const db = getDb();
      const accountId = await insertAccount(db);
      await db.tx(async (tx) => {
        await insertLead(tx, accountId, '601');
        const duplicate = await tx.tx((inner) => insertLead(inner, accountId, '601')).catch((e: unknown) => e);
        expect(duplicate).toMatchObject({ sqlstate: '23505', constraint: 'leads_account_contact_submitted_key' });
        await insertLead(tx, accountId, '602');
      });
      const contacts = await db.query<{ hubspot_contact_id: string }>(
        'select hubspot_contact_id from public.leads where account_id = $1 order by hubspot_contact_id',
        [accountId],
      );
      expect(contacts.map((row) => row.hubspot_contact_id)).toEqual(['601', '602']);
    });
  });

  describe('errors (rule 7)', () => {
    it('reports a NOT NULL violation on lead_messages with sqlstate, table and column, and nothing else', async () => {
      const db = getDb();
      const accountId = await insertAccount(db);
      const leadId = await insertLead(db, accountId);
      const sql = `insert into public.lead_messages (lead_id, account_id, message, email, purge_at) values ($1, $2, $3, $4, $5)`;
      const error: unknown = await db.query(sql, [leadId, accountId, SECRET_MESSAGE, SECRET_EMAIL, null]).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DbError);
      expect(error).toMatchObject({
        code: 'db_error',
        message: 'db_error',
        sqlstate: '23502',
        table: 'lead_messages',
        column: 'purge_at',
        kind: 'permanent',
      });
      const text = exposed(error);
      for (const forbidden of [SECRET_MESSAGE, 'fixture-msg-7f3a', SECRET_EMAIL, 'fixture-lead-7f3a', leadId, sql, 'insert into', 'Failing row']) {
        expect(text).not.toContain(forbidden);
      }
      expect(Object.keys(error as object).sort()).toEqual(['column', 'constraint', 'httpStatus', 'kind', 'sqlstate', 'table', 'code', 'name'].sort());
      expect('cause' in (error as object)).toBe(false);
    });

    it('reports the constraint name of a unique violation (users lower(email))', async () => {
      const db = getDb();
      const first = await insertAccount(db, '5005');
      const second = await insertAccount(db, '5006');
      const insertUser = (accountId: string, authUserId: string, email: string): Promise<unknown> =>
        db.query('insert into public.users (auth_user_id, account_id, email) values ($1, $2, $3)', [authUserId, accountId, email]);
      await insertUser(first, '00000000-0000-4000-8000-000000000001', 'Owner@Example.com');
      const error: unknown = await insertUser(second, '00000000-0000-4000-8000-000000000002', 'owner@example.COM').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DbError);
      expect(error).toMatchObject({ sqlstate: '23505', constraint: 'users_email_lower_key', table: 'users' });
      expect(exposed(error)).not.toContain('owner@example');
    });

    it('does not echo an invalid input value back', async () => {
      const error: unknown = await getDb()
        .query('select $1::int4', [SECRET_MESSAGE])
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ sqlstate: '22P02' });
      expect(exposed(error)).not.toContain('fixture-msg-7f3a');
    });
  });

  describe('helpers', () => {
    it('one() and maybeOne() enforce their row counts', async () => {
      const db = getDb();
      await expect(db.one('select 1 as n where false')).rejects.toMatchObject({ code: 'db_unexpected_row_count', rowCount: 0 });
      await expect(db.maybeOne('select 1 as n where false')).resolves.toBeNull();
      await expect(db.maybeOne('select n from generate_series(1, 2) as n')).rejects.toMatchObject({ rowCount: 2 });
    });

    it('exec() runs several statements', async () => {
      const db = getDb();
      await db.exec(`insert into public.leases (name, holder, expires_at) values ('a', 'h', '2026-10-06T13:00:00Z');
                     insert into public.leases (name, holder, expires_at) values ('b', 'h', '2026-10-06T13:00:00Z');`);
      expect(await db.query('select name from public.leases order by name')).toEqual([{ name: 'a' }, { name: 'b' }]);
    });
  });

  describe('harness', () => {
    it('starts each test with empty tables and restarted identities', async () => {
      const db = getDb();
      expect(await db.query('select id from public.accounts')).toEqual([]);
      expect(await db.query('select id from public.audit_log')).toEqual([]);
      const row = await db.one<{ id: string }>(`insert into public.audit_log (actor, action) values ('system', 'again') returning id`);
      expect(row.id).toBe('1');
    });

    it('(setup for the next test) writes to auth.users, fake.state and fake.dev_outbox', async () => {
      const db = getDb();
      await db.query(`insert into auth.users (email) values ('harness@example.com')`);
      await db.query(`insert into fake.state (key, value) values ('harness', '{"n": 1}')`);
      await db.query(
        `insert into fake.dev_outbox (created_at, "to", subject, html, text, kind) values ($1, $2, 'S', '<p>h</p>', 'h', 'test')`,
        [new Date('2026-10-06T13:00:00.000Z'), ['harness@example.com']],
      );
      expect(await db.query('select 1 from auth.users')).toHaveLength(1);
    });

    it('empties every non-system schema between tests, but keeps the migration ledger', async () => {
      const db = getDb();
      expect(await db.query('select id from auth.users')).toEqual([]);
      expect(await db.query('select key from fake.state')).toEqual([]);
      expect(await db.query('select id from fake.dev_outbox')).toEqual([]);
      expect((await db.query('select version from fake._migrations')).length).toBeGreaterThan(0);
    });
  });
});
