import 'server-only';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from './types';

// Fake-mode and test migrations (PLAN §5, D-29): fake-shim.sql, then every supabase/migrations file
// not yet in the fake._migrations ledger, in version order, each in its own transaction. Live
// Supabase never runs this: it gets the same files through `supabase db push` (WIRE_UP), and the
// shim's roles and auth schema already exist there.

const MIGRATION_FILE = /^(\d{14})_([a-z0-9_]+)\.sql$/;

// The files are read from the working directory at run time (fake mode runs from the repository).
// The turbopackIgnore comments stop `next build` tracing the whole project because of these paths.

export interface MigrationFile {
  /** The 14-digit timestamp prefix, e.g. `20261001000001`. */
  version: string;
  /** The rest of the file name, e.g. `init`. */
  name: string;
  path: string;
}

export interface MigrateOptions {
  /** Defaults to `<cwd>/supabase/migrations`. */
  migrationsDir?: string | undefined;
  /** Defaults to `<cwd>/src/server/db/fake-shim.sql`. */
  shimPath?: string | undefined;
}

export interface MigrateResult {
  /** Versions applied by this run, in order; empty when the ledger was already up to date. */
  applied: string[];
}

export function defaultMigrationsDir(): string {
  return path.join(/*turbopackIgnore: true*/ process.cwd(), 'supabase', 'migrations');
}

export function defaultShimPath(): string {
  return path.join(/*turbopackIgnore: true*/ process.cwd(), 'src', 'server', 'db', 'fake-shim.sql');
}

/** The migration files in version order. Files that don't match `<14 digits>_<name>.sql` are ignored. */
export async function listMigrations(dir: string = defaultMigrationsDir()): Promise<MigrationFile[]> {
  const files: MigrationFile[] = [];
  for (const entry of await readdir(/*turbopackIgnore: true*/ dir)) {
    const match = MIGRATION_FILE.exec(entry);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    files.push({ version: match[1], name: match[2], path: path.join(dir, entry) });
  }
  files.sort((a, b) => a.version.localeCompare(b.version));
  for (let i = 1; i < files.length; i += 1) {
    if (files[i]?.version === files[i - 1]?.version) throw new Error('duplicate_migration_version');
  }
  return files;
}

/** Brings a PGlite database up to date. Idempotent: a second run applies nothing. */
export async function migrate(db: Db, options: MigrateOptions = {}): Promise<MigrateResult> {
  const shim = await readFile(/*turbopackIgnore: true*/ options.shimPath ?? defaultShimPath(), 'utf8');
  const files = await listMigrations(options.migrationsDir ?? defaultMigrationsDir());

  await db.tx((tx) => tx.exec(shim));

  const done = new Set(
    (await db.query<{ version: string }>('select version from fake._migrations')).map((row) => row.version),
  );
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file.version)) continue;
    const sql = await readFile(/*turbopackIgnore: true*/ file.path, 'utf8');
    await db.tx(async (tx) => {
      await tx.exec(sql);
      await tx.query('insert into fake._migrations (version, name) values ($1, $2)', [file.version, file.name]);
    });
    applied.push(file.version);
  }
  return { applied };
}
