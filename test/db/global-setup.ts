// Vitest globalSetup (PLAN §12): migrate one PGlite database (fake shim + supabase/migrations) once
// per run, dump its data directory to a temp file and hand the path to the test files, which each
// load it once (test/db/harness.ts) instead of migrating again.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestProject } from 'vitest/node';
import { migrate } from '@/server/db/migrate';
import { createPgliteDb } from '@/server/db/pglite';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Path of a tarball of a freshly migrated PGlite data directory. */
    pgliteDumpPath: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const dir = await mkdtemp(path.join(tmpdir(), 'autopilot-pglite-'));
  const cleanup = (): Promise<void> => rm(dir, { recursive: true, force: true });
  const db = createPgliteDb();
  try {
    await migrate(db);
    const dump = await db.dumpDataDir();
    const file = path.join(dir, 'migrated.tar');
    await writeFile(file, new Uint8Array(await dump.arrayBuffer()));
    project.provide('pgliteDumpPath', file);
  } catch (error) {
    await cleanup();
    throw error;
  } finally {
    await db.close();
  }
  return cleanup;
}
