import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // `server-only` throws outside a React Server Components bundle; tests import server modules directly.
      { find: /^server-only$/, replacement: fromRoot('./test/stubs/empty.ts') },
      { find: /^@\//, replacement: `${fromRoot('./src')}/` },
    ],
  },
  test: {
    environment: 'node',
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'test/**/*.test.ts',
      'test/**/*.test.tsx',
      'scripts/**/*.test.ts',
    ],
    exclude: ['node_modules/**', '.next/**', 'outbox/**', '.data/**', 'coverage/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // PGlite is single-connection and takes seconds to start: keep DB suites in at most two processes.
    pool: 'forks',
    maxWorkers: 2,
    // PGlite harness (PLAN §12): migrate one database per run and dumpDataDir() it; each test file
    // loads the dump once (test/db/harness.ts).
    globalSetup: ['test/db/global-setup.ts'],
    // Luxon's implicit "now" is a fixed instant in every test file (D-28).
    setupFiles: ['test/setup/luxon-clock.ts'],
  },
});
