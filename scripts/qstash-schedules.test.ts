import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAKE_ENV, parseEnv } from '@/server/env';
import { buildSchedulePlan, CRON_ROUTES, destinationProblems, formatPlan, parseArgs } from './qstash-schedules';

// The QStash schedule plan (D-16), built without any network call: it must mirror vercel.json, so
// switching from Vercel Cron to QStash schedules changes the trigger and nothing else.

const LIVE_LIKE = { APP_URL: 'https://autopilot.example.com', ENV_NAMESPACE: 'prod' } as const;

describe('buildSchedulePlan', () => {
  it('has the same routes and UTC schedules as vercel.json, in order', () => {
    const vercel = JSON.parse(readFileSync(path.join(process.cwd(), 'vercel.json'), 'utf8')) as { crons: { path: string; schedule: string }[] };
    const plan = buildSchedulePlan(LIVE_LIKE);
    expect(plan.map((s) => ({ path: new URL(s.destination).pathname, schedule: s.cron }))).toEqual(vercel.crons);
    expect(CRON_ROUTES.map((r) => r.cron)).toEqual(['*/5 * * * *', '0 * * * *', '17 3 * * *']);
  });

  it('POSTs to {APP_URL}/api/cron/* (the URL the cron routes verify the signature against) with fixed ids', () => {
    expect(buildSchedulePlan(LIVE_LIKE)).toEqual([
      { scheduleId: 'prod-cron-poll', destination: 'https://autopilot.example.com/api/cron/poll', cron: '*/5 * * * *', method: 'POST', retries: 0 },
      {
        scheduleId: 'prod-cron-weekly-report',
        destination: 'https://autopilot.example.com/api/cron/weekly-report',
        cron: '0 * * * *',
        method: 'POST',
        retries: 3,
      },
      { scheduleId: 'prod-cron-daily', destination: 'https://autopilot.example.com/api/cron/daily', cron: '17 3 * * *', method: 'POST', retries: 3 },
    ]);
  });

  it('is the same plan on a second run (ids are stable, so QStash updates rather than adds)', () => {
    expect(buildSchedulePlan(LIVE_LIKE)).toEqual(buildSchedulePlan(LIVE_LIKE));
    const ids = buildSchedulePlan(LIVE_LIKE).map((s) => s.scheduleId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('keys the ids by ENV_NAMESPACE, so two deployments on one QStash account do not collide', () => {
    const staging = buildSchedulePlan({ ...LIVE_LIKE, ENV_NAMESPACE: 'staging' }).map((s) => s.scheduleId);
    expect(staging).toEqual(['staging-cron-poll', 'staging-cron-weekly-report', 'staging-cron-daily']);
  });

  it('builds from a parsed environment (the fake one here: a dry run works anywhere)', () => {
    const plan = buildSchedulePlan(parseEnv({ APP_MODE: 'fake' }));
    expect(plan.map((s) => s.destination)).toEqual([
      `${FAKE_ENV.APP_URL}/api/cron/poll`,
      `${FAKE_ENV.APP_URL}/api/cron/weekly-report`,
      `${FAKE_ENV.APP_URL}/api/cron/daily`,
    ]);
    expect(plan.map((s) => s.scheduleId)).toEqual(['fake-local-cron-poll', 'fake-local-cron-weekly-report', 'fake-local-cron-daily']);
  });
});

describe('destinationProblems', () => {
  it('accepts a public https APP_URL', () => {
    expect(destinationProblems(buildSchedulePlan(LIVE_LIKE))).toEqual([]);
  });

  it.each(['http://localhost:3000', 'https://localhost', 'https://127.0.0.1:8443', 'https://app.local', 'http://autopilot.example.com'])(
    'refuses %s, which QStash cannot reach or would call in clear text',
    (appUrl) => {
      expect(destinationProblems(buildSchedulePlan({ ...LIVE_LIKE, APP_URL: appUrl }))).not.toEqual([]);
    },
  );
});

describe('arguments and output', () => {
  it('knows --dry-run and refuses anything else', () => {
    expect(parseArgs([])).toEqual({ dryRun: false });
    expect(parseArgs(['--dry-run'])).toEqual({ dryRun: true });
    expect(() => parseArgs(['--force'])).toThrow('unknown argument');
  });

  it('prints one aligned line per schedule, with nothing secret in it', () => {
    const lines = formatPlan(buildSchedulePlan(LIVE_LIKE));
    expect(lines).toEqual([
      '  prod-cron-poll           */5 * * * *  POST https://autopilot.example.com/api/cron/poll  retries=0',
      '  prod-cron-weekly-report  0 * * * *    POST https://autopilot.example.com/api/cron/weekly-report  retries=3',
      '  prod-cron-daily          17 3 * * *   POST https://autopilot.example.com/api/cron/daily  retries=3',
    ]);
    const printed = formatPlan(buildSchedulePlan(parseEnv({ APP_MODE: 'fake' }))).join('\n');
    expect(printed).not.toContain(FAKE_ENV.QSTASH_TOKEN);
  });
});
