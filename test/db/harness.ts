// PGlite test harness (PLAN §12). Each test file loads the migrated dump from the globalSetup once
// (createTestDb) and truncates between tests (resetDb). `useTestDb()` wires both into the hooks.
//
//   const getDb = useTestDb();
//   it('…', async () => { const db = getDb(); … });
//
// PGlite has one connection: test locking and races as sequential replays (PLAN §12).
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, inject } from 'vitest';
import { migrate } from '@/server/db/migrate';
import { createPgliteDb, type PgliteDb } from '@/server/db/pglite';
import type { Db } from '@/server/db/types';

let dump: Promise<Blob | null> | undefined;

/** The migrated dump for this test file (read once), or null when the globalSetup did not run. */
function loadDump(): Promise<Blob | null> {
  dump ??= (async () => {
    const file: unknown = inject('pgliteDumpPath');
    if (typeof file !== 'string') return null;
    return new Blob([new Uint8Array(await readFile(file))]);
  })();
  return dump;
}

/** A migrated, empty, in-memory database. Close it in afterAll. */
export async function createTestDb(): Promise<PgliteDb> {
  const data = await loadDump();
  if (data === null) {
    // Without the globalSetup (e.g. a custom config), migrate from scratch: slower, same result.
    const db = createPgliteDb();
    await migrate(db);
    return db;
  }
  const db = createPgliteDb({ loadDataDir: data });
  // Open it now, inside the hook's timeout, rather than in the first test.
  await db.query('select 1');
  return db;
}

/**
 * Empties every table in every non-system schema (public, auth, fake and any schema a later
 * migration adds), restarting identities. Only the migration ledger, fake._migrations, is kept.
 */
export async function resetDb(db: Db): Promise<void> {
  const tables = await db.query<{ name: string }>(
    `select format('%I.%I', n.nspname, c.relname) as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p')
        and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_%'
        and not (n.nspname = 'fake' and c.relname = '_migrations')
      order by n.nspname, c.relname`,
  );
  if (tables.length === 0) return;
  await db.exec(`truncate table ${tables.map((table) => table.name).join(', ')} restart identity cascade`);
}

/** Registers beforeAll/beforeEach/afterAll hooks; call the returned getter inside tests. */
export function useTestDb(): () => PgliteDb {
  let db: PgliteDb | undefined;
  beforeAll(async () => {
    db = await createTestDb();
  });
  beforeEach(async () => {
    if (db !== undefined) await resetDb(db);
  });
  afterAll(async () => {
    await db?.close();
  });
  return () => {
    if (db === undefined) throw new Error('useTestDb: the database is only available inside tests and hooks');
    return db;
  };
}
