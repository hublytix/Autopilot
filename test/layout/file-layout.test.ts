import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Next.js looks for instrumentation (and proxy/middleware) only in the parent directory of the
// app/pages directory, and a root-level app/ or pages/ wins over src/. A misplaced file is
// ignored silently (NX14-INSTR-LOCATION, PLAN §12 "Layout and app smoke").

const root = process.cwd();
const exists = (relative: string): boolean => existsSync(path.join(root, relative));

describe('file layout', () => {
  it.each([
    'src/app',
    'src/instrumentation.ts',
    'src/instrumentation-client.ts',
    'src/sentry.server.config.ts',
    'src/sentry.edge.config.ts',
    'src/app/global-error.tsx',
    'src/shared/observability/sentry-options.ts',
    'vercel.json',
    // M2 routes (PLAN §7.3, §7.6)
    'src/app/api/cron/poll/route.ts',
    'src/app/api/hubspot/webhooks/route.ts',
    'src/app/api/hubspot/install/route.ts',
    'src/app/api/hubspot/oauth/callback/route.ts',
    'src/app/api/jobs/run/route.ts',
    'src/app/api/jobs/failed/route.ts',
    'src/app/dev/fake-hubspot/authorize/page.tsx',
  ])('has %s', (file) => {
    expect(exists(file)).toBe(true);
  });

  it.each([
    'app',
    'pages',
    'src/pages',
    'instrumentation.ts',
    'instrumentation.js',
    'instrumentation-client.ts',
    'middleware.ts',
    'middleware.js',
    'proxy.ts',
    'proxy.js',
    'src/middleware.ts',
    'src/middleware.js',
    'sentry.server.config.ts',
    'sentry.edge.config.ts',
    'sentry.client.config.ts',
    'src/sentry.client.config.ts',
  ])('has no %s', (file) => {
    expect(exists(file)).toBe(false);
  });

  // PLAN §8.1: the three periodic triggers (UTC), declared for Vercel Pro. The poll route arrived in
  // M2 (listed above); the weekly report (M6) and daily (M7) routes join the list when they land.
  it('vercel.json declares exactly the PLAN §8.1 cron schedules', () => {
    const config = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8')) as { crons?: unknown };
    expect(config.crons).toEqual([
      { path: '/api/cron/poll', schedule: '*/5 * * * *' },
      { path: '/api/cron/weekly-report', schedule: '0 * * * *' },
      { path: '/api/cron/daily', schedule: '17 3 * * *' },
    ]);
  });
});
