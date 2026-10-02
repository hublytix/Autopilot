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
    // M3 (PLAN §7.2, §7.3, §7.4, §7.5, §7.7): the proxy sits next to src/app, never at the root.
    'src/proxy.ts',
    'src/app/login/page.tsx',
    'src/app/auth/confirm/route.ts',
    'src/app/auth/signout/route.ts',
    'src/app/auth/error/page.tsx',
    'src/app/onboarding/layout.tsx',
    'src/app/onboarding/email/page.tsx',
    'src/app/onboarding/brief/page.tsx',
    'src/app/onboarding/forms/page.tsx',
    'src/app/onboarding/preferences/page.tsx',
    'src/app/onboarding/inbox/page.tsx',
    'src/app/onboarding/baseline/page.tsx',
    'src/app/dashboard/page.tsx',
    'src/app/api/onboarding/status/route.ts',
    'src/app/a/[token]/send/route.ts',
    'src/app/a/[token]/beacon/route.ts',
    'src/app/a/[token]/copy/page.tsx',
    'src/app/a/[token]/verify-notify/page.tsx',
    'src/app/a/[token]/edit/page.tsx',
    'src/app/a/[token]/dismiss/page.tsx',
    // M6 (PLAN §7.3, §7.5): the Monday report's due-check and the dashboard pages.
    'src/app/api/cron/weekly-report/route.ts',
    'src/app/dashboard/layout.tsx',
    'src/app/dashboard/leads/[id]/page.tsx',
    'src/app/dashboard/brief/page.tsx',
    'src/server/security/ssrf.ts',
    'src/server/security/csp.ts',
    'src/server/security/same-origin.ts',
    // M7 (PLAN §7.3, §7.5, §7.6): billing, the daily cron, settings, disconnect and /admin.
    'src/app/api/cron/daily/route.ts',
    'src/app/api/razorpay/webhook/route.ts',
    'src/app/api/billing/checkout/route.ts',
    'src/app/api/billing/resume/route.ts',
    'src/app/api/billing/cancel/route.ts',
    'src/app/dashboard/billing/page.tsx',
    'src/app/dashboard/billing/checkout/page.tsx',
    'src/app/dashboard/settings/page.tsx',
    'src/app/dashboard/settings/forms/page.tsx',
    'src/app/dashboard/settings/disconnect/page.tsx',
    'src/app/admin/page.tsx',
    'src/app/dev/fake-checkout/[id]/page.tsx',
    'src/app/dev/fake-checkout/[id]/decision/route.ts',
    'src/server/security/razorpay-signature.ts',
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

  // PLAN §8.1: the three periodic triggers (UTC), declared for Vercel Pro (scripts/qstash-schedules.ts
  // mirrors them; its own test compares the two).
  it('vercel.json declares exactly the PLAN §8.1 cron schedules', () => {
    const config = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8')) as { crons?: unknown };
    expect(config.crons).toEqual([
      { path: '/api/cron/poll', schedule: '*/5 * * * *' },
      { path: '/api/cron/weekly-report', schedule: '0 * * * *' },
      { path: '/api/cron/daily', schedule: '17 3 * * *' },
    ]);
  });

  // Vercel Cron calls GET; a QStash schedule POSTs (D-16). Each declared path needs both handlers.
  it('every vercel.json cron path has a route file with GET and POST', () => {
    const config = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8')) as { crons: { path: string }[] };
    for (const cron of config.crons) {
      const file = path.join(root, 'src/app', cron.path, 'route.ts');
      expect(existsSync(file), cron.path).toBe(true);
      const source = readFileSync(file, 'utf8');
      expect(source, cron.path).toMatch(/export async function GET\(/);
      expect(source, cron.path).toMatch(/export async function POST\(/);
    }
  });
});
