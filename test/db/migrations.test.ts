import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultMigrationsDir, listMigrations, migrate } from '@/server/db/migrate';
import { createPgliteDb, type PgliteDb } from '@/server/db/pglite';
import type { Db } from '@/server/db/types';
import { createTestDb } from './harness';
import { scanSql, scanTs, stripSqlComments, tsStringLiterals, type WallClockHit } from './sql-scan';

// The PLAN §5 migration test (Definition of Done), over the public tables supabase/migrations creates.

const ROOT = process.cwd();

/** Every table PLAN §5 lists. Later migrations may add more; none may be missing. */
const PLAN_TABLES = [
  'accounts',
  'users',
  'login_intents',
  'settings',
  'hubspot_connections',
  'portal_history',
  'briefs',
  'brief_versions',
  'brief_jobs',
  'selected_forms',
  'leads',
  'lead_messages',
  'drafts',
  'action_tokens',
  'scheduled_jobs',
  'notifications_sent',
  'weekly_reports',
  'subscriptions',
  'billing_tombstones',
  'webhook_events',
  'audit_log',
  'baselines',
  'inbox_checks',
  'ai_calls',
  'rate_limits',
  'leases',
];

const CRUD = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;
const TABLE_PRIVILEGES = [...CRUD, 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const API_ROLES = ['anon', 'authenticated'] as const;

async function publicTables(db: Db): Promise<{ name: string; rls: boolean }[]> {
  return db.query<{ name: string; rls: boolean }>(
    `select c.relname as name, c.relrowsecurity as rls
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
      order by c.relname`,
  );
}

/** Item (2) over every ACL: grants on public tables and sequences to anon, authenticated or PUBLIC. */
async function apiRoleAclEntries(db: Db): Promise<string[]> {
  const rows = await db.query<{ relname: string; grantee: string; privilege_type: string }>(
    `select c.relname, coalesce(r.rolname, 'PUBLIC') as grantee, a.privilege_type
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join lateral aclexplode(coalesce(c.relacl, acldefault(case when c.relkind = 'S' then 's' else 'r' end::"char", c.relowner))) a
       left join pg_roles r on r.oid = a.grantee
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'S', 'v', 'm')
        and (a.grantee = 0 or r.rolname in ('anon', 'authenticated'))
      order by 1, 2, 3`,
  );
  return rows.map((row) => `${row.grantee} ${row.privilege_type} ${row.relname}`);
}

/** Default privileges (for objects created later in public) that reach anon, authenticated or PUBLIC. */
async function apiRoleDefaultAcl(db: Db): Promise<string[]> {
  const rows = await db.query<{ objtype: string; grantee: string; privilege_type: string }>(
    `select d.defaclobjtype::text as objtype, coalesce(r.rolname, 'PUBLIC') as grantee, a.privilege_type
       from pg_default_acl d
       left join pg_namespace n on n.oid = d.defaclnamespace
       cross join lateral aclexplode(d.defaclacl) a
       left join pg_roles r on r.oid = a.grantee
      where (n.nspname = 'public' or d.defaclnamespace = 0)
        and (a.grantee = 0 or r.rolname in ('anon', 'authenticated'))
      order by 1, 2, 3`,
  );
  return rows.map((row) => `${row.grantee} ${row.privilege_type} on ${row.objtype}`);
}

/** Creates a table, a sequence and a function as a later migration would, reads the API roles' access, rolls back. */
async function laterObjectsProbe(db: Db): Promise<Record<string, boolean>> {
  return db
    .tx(async (tx) => {
      await tx.exec(`create table public.autopilot_probe_t (id bigint generated always as identity primary key, v text);
                     create sequence public.autopilot_probe_s;
                     create function public.autopilot_probe_f() returns int language sql as $$ select 1 $$;`);
      const row = await tx.one<Record<string, boolean>>(
        `select has_table_privilege('anon', 'public.autopilot_probe_t', 'SELECT') as anon_table,
                has_table_privilege('authenticated', 'public.autopilot_probe_t', 'INSERT') as authenticated_table,
                has_sequence_privilege('anon', 'public.autopilot_probe_s', 'USAGE') as anon_sequence,
                has_function_privilege('authenticated', 'public.autopilot_probe_f()', 'EXECUTE') as authenticated_function,
                has_table_privilege('service_role', 'public.autopilot_probe_t', 'SELECT') as service_role_table`,
      );
      throw Object.assign(new Error('rollback'), { row });
    })
    .catch((error: unknown) => (error as { row: Record<string, boolean> }).row);
}

/** Migrates a fresh in-memory PGlite from a copy of supabase/migrations with `edit` applied to each file. */
async function migrateEdited(edit: (sql: string) => string): Promise<PgliteDb> {
  const dir = await mkdtemp(path.join(tmpdir(), 'autopilot-mutated-migrations-'));
  try {
    for (const file of await listMigrations()) {
      await writeFile(path.join(dir, path.basename(file.path)), edit(await readFile(file.path, 'utf8')), 'utf8');
    }
    const db = createPgliteDb();
    await migrate(db, { migrationsDir: dir });
    return db;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const PER_OBJECT_REVOKE = /^revoke all on (?:table public\.\w+|all sequences in schema public) from anon, authenticated;$/gm;
const DEFAULT_PRIVILEGE_REVOKE = /^alter default privileges (?:in schema public )?revoke [^;]+;$/gm;

async function filesUnder(dir: string, accept: (file: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full, accept)));
    else if (accept(full)) out.push(full);
  }
  return out.sort();
}

describe('migrations (PLAN §5 migration test)', () => {
  let db: PgliteDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('creates every table PLAN §5 lists, all in public', async () => {
    const names = (await publicTables(db)).map((table) => table.name);
    expect(names).toEqual(expect.arrayContaining(PLAN_TABLES));
  });

  it('(1) enables row level security on every public table', async () => {
    const tables = await publicTables(db);
    expect(tables.length).toBeGreaterThanOrEqual(PLAN_TABLES.length);
    expect(tables.filter((table) => !table.rls).map((table) => table.name)).toEqual([]);
  });

  it('defines no row level security policies (server-only access, D-21)', async () => {
    expect(await db.query(`select tablename, policyname from pg_policies where schemaname = 'public'`)).toEqual([]);
  });

  it('(2) gives anon and authenticated no privilege on any table or column', async () => {
    const granted: string[] = [];
    for (const { name } of await publicTables(db)) {
      for (const role of API_ROLES) {
        for (const privilege of TABLE_PRIVILEGES) {
          const row = await db.one<{ ok: boolean }>('select has_table_privilege($1, $2, $3) as ok', [role, `public.${name}`, privilege]);
          if (row.ok) granted.push(`${role} ${privilege} ${name}`);
        }
        const column = await db.one<{ ok: boolean }>(
          `select has_any_column_privilege($1, $2, 'SELECT') or has_any_column_privilege($1, $2, 'INSERT')
               or has_any_column_privilege($1, $2, 'UPDATE') as ok`,
          [role, `public.${name}`],
        );
        if (column.ok) granted.push(`${role} column privilege on ${name}`);
      }
    }
    expect(granted).toEqual([]);
  });

  it('(2) grants nothing on public tables or sequences to anon, authenticated or PUBLIC in any ACL', async () => {
    expect(await apiRoleAclEntries(db)).toEqual([]);
  });

  it('(2) leaves no default privilege for anon, authenticated or PUBLIC: tables, sequences and functions created later stay closed', async () => {
    expect(await apiRoleDefaultAcl(db)).toEqual([]);
    expect(await laterObjectsProbe(db)).toEqual({
      anon_table: false,
      authenticated_table: false,
      anon_sequence: false,
      authenticated_function: false,
      service_role_table: true,
    });
  });

  it('(2) gives anon and authenticated no privilege on any public sequence', async () => {
    const sequences = await db.query<{ name: string }>(
      `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'S'`,
    );
    expect(sequences.length).toBeGreaterThan(0); // the identity columns of the log tables
    for (const { name } of sequences) {
      for (const role of API_ROLES) {
        const row = await db.one<{ ok: boolean }>(`select has_sequence_privilege($1, $2, 'USAGE,SELECT,UPDATE') as ok`, [
          role,
          `public.${name}`,
        ]);
        expect(row.ok, `${role} on ${name}`).toBe(false);
      }
    }
  });

  it('(2) gives anon and authenticated no EXECUTE on public functions, including ones created later', async () => {
    const existing = await db.query(
      `select p.proname, r.role
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         cross join (values ('anon'), ('authenticated')) as r(role)
        where n.nspname = 'public' and has_function_privilege(r.role, p.oid, 'EXECUTE')`,
    );
    expect(existing).toEqual([]);

    // The default-privilege revokes cover functions a later migration creates.
    const probe = await db
      .tx(async (tx) => {
        await tx.exec('create function public.autopilot_probe() returns int language sql as $$ select 1 $$;');
        const row = await tx.one<{ anon: boolean; authenticated: boolean }>(
          `select has_function_privilege('anon', 'public.autopilot_probe()', 'EXECUTE') as anon,
                  has_function_privilege('authenticated', 'public.autopilot_probe()', 'EXECUTE') as authenticated`,
        );
        throw Object.assign(new Error('rollback'), { row });
      })
      .catch((error: unknown) => (error as { row: unknown }).row);
    expect(probe).toEqual({ anon: false, authenticated: false });
    expect(await db.query(`select 1 from pg_proc where proname = 'autopilot_probe'`)).toEqual([]);
  });

  it('(3) gives service_role select, insert, update and delete on every public table', async () => {
    const missing: string[] = [];
    for (const { name } of await publicTables(db)) {
      for (const privilege of CRUD) {
        const row = await db.one<{ ok: boolean }>(`select has_table_privilege('service_role', $1, $2) as ok`, [`public.${name}`, privilege]);
        if (!row.ok) missing.push(`${privilege} ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('enforces the grants: service_role can write a log row, anon cannot read', async () => {
    const outcome = await db
      .tx(async (tx) => {
        await tx.exec('set local role service_role');
        const inserted = await tx.query(`insert into public.audit_log (actor, action) values ('system', 'probe') returning id`);
        throw Object.assign(new Error('rollback'), { inserted: inserted.length });
      })
      .catch((error: unknown) => (error as { inserted: number }).inserted);
    expect(outcome).toBe(1);

    const denied: unknown = await db
      .tx(async (tx) => {
        await tx.exec('set local role anon');
        await tx.query('select * from public.leads');
      })
      .catch((error: unknown) => error);
    expect(denied).toMatchObject({ code: 'db_error', sqlstate: '42501' });
  });

  it('has no column default that reads the clock, except audit_log.at and webhook_events.received_at', async () => {
    const defaults = await db.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema in ('public', 'fake')
          and column_default ~* '(now|clock_timestamp|statement_timestamp|transaction_timestamp)\\(|current_(timestamp|date|time)|localtime'
        order by table_name, column_name`,
    );
    expect(defaults).toEqual([
      { table_name: 'audit_log', column_name: 'at' },
      { table_name: 'webhook_events', column_name: 'received_at' },
    ]);
  });

  it('(4) boots a persisted data directory twice; the ledger stops a second apply', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'autopilot-pglite-persist-'));
    try {
      const versions = (await listMigrations()).map((file) => file.version);
      expect(versions.length).toBeGreaterThan(0);

      const first = createPgliteDb({ dataDir: dir });
      try {
        expect(await migrate(first)).toEqual({ applied: versions });
        expect(await migrate(first)).toEqual({ applied: [] });
        await first.query(`insert into public.leases (name, holder, expires_at) values ('marker', 'test', $1)`, [
          new Date('2026-10-06T13:00:00.000Z'),
        ]);
      } finally {
        await first.close();
      }

      const second = createPgliteDb({ dataDir: dir });
      try {
        expect(await migrate(second)).toEqual({ applied: [] });
        const ledger = await second.query<{ version: string }>('select version from fake._migrations order by version');
        expect(ledger.map((row) => row.version)).toEqual(versions);
        expect(await second.query('select name from public.leases')).toEqual([{ name: 'marker' }]);
        // The shim re-ran on this boot; the legacy Supabase default grants it adds to a fresh
        // database must not come back once a migration has revoked them.
        expect(await apiRoleDefaultAcl(second)).toEqual([]);
        expect(await apiRoleAclEntries(second)).toEqual([]);
      } finally {
        await second.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('(5) finds no now(), current_timestamp or clock_timestamp in SQL outside the allow-list', async () => {
    const sqlFiles = [
      ...(await filesUnder(path.join(ROOT, 'supabase'), (file) => file.endsWith('.sql'))),
      ...(await filesUnder(path.join(ROOT, 'src', 'server'), (file) => file.endsWith('.sql'))),
    ];
    expect(sqlFiles.map((file) => path.relative(ROOT, file))).toEqual(
      expect.arrayContaining(['supabase/migrations/20261001000001_init.sql', 'src/server/db/fake-shim.sql']),
    );
    // Server code, and the scripts (the simulation and its seed helpers) that run SQL against the same database.
    const isSource = (file: string): boolean => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.endsWith('.d.ts');
    const tsFiles = [...(await filesUnder(path.join(ROOT, 'src', 'server'), isSource)), ...(await filesUnder(path.join(ROOT, 'scripts'), isSource))];
    expect(tsFiles.map((file) => path.relative(ROOT, file))).toEqual(
      expect.arrayContaining(['src/server/db/migrate.ts', 'scripts/simulation/run.ts', 'scripts/simulation/stages.ts']),
    );

    const hits: WallClockHit[] = [];
    for (const file of sqlFiles) hits.push(...scanSql(path.relative(ROOT, file), await readFile(file, 'utf8')));
    for (const file of tsFiles) hits.push(...scanTs(path.relative(ROOT, file), await readFile(file, 'utf8')));
    expect(hits).toEqual([]);
  });
});

// The PGlite shim starts every fresh database the way a pre-2026 Supabase project starts: anon,
// authenticated and service_role get everything in public by default (SB-DATA-API-GRANTS-2026).
// These tests prove the item (2) checks above can fail, and that each kind of revoke is needed.
describe('migration test (2) against legacy Supabase default grants', () => {
  it('a fresh database grants the API roles everything in public by default, before any migration', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'autopilot-no-migrations-'));
    const db = createPgliteDb();
    try {
      expect(await migrate(db, { migrationsDir: empty })).toEqual({ applied: [] });
      expect(await apiRoleDefaultAcl(db)).toEqual(
        expect.arrayContaining(['anon SELECT on r', 'authenticated INSERT on r', 'anon USAGE on S', 'authenticated EXECUTE on f']),
      );
      expect(await laterObjectsProbe(db)).toMatchObject({ anon_table: true, authenticated_table: true, anon_sequence: true, authenticated_function: true });
      // The real migrations then close it (the item (2) tests above run on exactly this path).
      expect((await migrate(db, { migrationsDir: defaultMigrationsDir() })).applied.length).toBeGreaterThan(0);
      expect(await apiRoleDefaultAcl(db)).toEqual([]);
      expect(await apiRoleAclEntries(db)).toEqual([]);
    } finally {
      await db.close();
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('fails item (2) when the migration loses its revokes', async () => {
    const original = await readFile(path.join(defaultMigrationsDir(), '20261001000001_init.sql'), 'utf8');
    expect(original.match(PER_OBJECT_REVOKE)?.length).toBeGreaterThanOrEqual(PLAN_TABLES.length);
    expect(original.match(DEFAULT_PRIVILEGE_REVOKE)?.length).toBeGreaterThanOrEqual(3);

    const db = await migrateEdited((sql) => sql.replace(PER_OBJECT_REVOKE, '').replace(DEFAULT_PRIVILEGE_REVOKE, ''));
    try {
      const granted = await apiRoleAclEntries(db);
      expect(granted).toEqual(expect.arrayContaining(['anon SELECT leads', 'authenticated DELETE lead_messages']));
      expect(granted.some((entry) => entry.endsWith('audit_log_id_seq'))).toBe(true);
      expect(await apiRoleDefaultAcl(db)).not.toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('fails the later-objects probe when only the default-privilege revokes are lost', async () => {
    const db = await migrateEdited((sql) => sql.replace(DEFAULT_PRIVILEGE_REVOKE, ''));
    try {
      // The per-table revokes still close every existing table…
      expect(await apiRoleAclEntries(db)).toEqual([]);
      // …but whatever a later migration creates is open again.
      expect(await apiRoleDefaultAcl(db)).not.toEqual([]);
      expect(await laterObjectsProbe(db)).toMatchObject({ anon_table: true, authenticated_function: true });
    } finally {
      await db.close();
    }
  });
});

describe('the wall-clock scanner itself', () => {
  it('allows only the two audit defaults and flags every other clock read', () => {
    const sql = `
      -- a comment may say now() freely
      create table public.audit_log (id bigint, at timestamptz not null default now(), actor text);
      create table public.webhook_events (received_at timestamptz not null default now());
      create table public.leads (received_at timestamptz not null default now());
      alter table public.audit_log alter column at set default now();
      update public.leads set dismissed_at = current_timestamp where dismissed_at < CLOCK_TIMESTAMP();
      select 'now'::timestamptz, localtimestamp, transaction_timestamp();
    `;
    expect(scanSql('x.sql', sql).map((hit) => `${hit.line}:${hit.text.toLowerCase()}`)).toEqual([
      '5:now(',
      '7:current_timestamp',
      '7:clock_timestamp(',
      "8:'now'",
      '8:localtimestamp',
      '8:transaction_timestamp(',
    ]);
  });

  it('flags the special date literals and the one-argument age(), which read the database clock too', () => {
    const sql = `
      select 'today'::date, 'TOMORROW'::timestamptz, date 'yesterday';
      select age(l.submitted_at) from public.leads l;
      select age(coalesce(l.replied_at, l.submitted_at)) from public.leads l;
      select age($1, l.submitted_at), age(greatest($1, l.submitted_at), l.received_at) from public.leads l;
      select 'todays special', page(1), storage (2);
    `;
    expect(scanSql('x.sql', sql).map((hit) => `${hit.line}:${hit.text.toLowerCase()}`)).toEqual([
      "2:'today'",
      "2:'tomorrow'",
      "2:'yesterday'",
      '3:age(',
      '4:age(',
    ]);
    expect(scanTs('x.ts', "const q = `select age(received_at), 'yesterday'::date`;").map((hit) => hit.text)).toEqual(["'yesterday'", 'age(']);
  });

  it('keeps quoted text and dollar-quoted bodies when stripping comments', () => {
    expect(stripSqlComments("select '-- not a comment', $$ /* body */ $$ -- gone")).toBe(
      "select '-- not a comment', $$ /* body */ $$        ",
    );
  });

  it('reads TypeScript string literals but not comments, code or regex literals', () => {
    const source = [
      '// now() in a comment',
      'const at = deps.clock.now();',
      'const re = /now()/;',
      "const sql = 'select now()';",
      'const t = `update x set y = current_timestamp`;',
    ].join('\n');
    expect(tsStringLiterals(source).map((literal) => literal.text)).toEqual(['select now()', 'update x set y = current_timestamp']);
    expect(scanTs('x.ts', source).map((hit) => `${hit.line}:${hit.text}`)).toEqual(['4:now(', '5:current_timestamp']);
  });
});
