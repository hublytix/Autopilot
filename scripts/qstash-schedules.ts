// QStash schedules for the periodic routes (PLAN §8.1, D-16, QS-SCHEDULES-ALTERNATIVE): the
// alternative to Vercel Cron (vercel.json) on any Vercel plan. Creates or updates three schedules
// with fixed ids, so running it again only updates them:
//   {ENV_NAMESPACE}-cron-poll           */5 * * * *  POST {APP_URL}/api/cron/poll
//   {ENV_NAMESPACE}-cron-weekly-report  0 * * * *    POST {APP_URL}/api/cron/weekly-report
//   {ENV_NAMESPACE}-cron-daily          17 3 * * *   POST {APP_URL}/api/cron/daily
// QStash evaluates cron in UTC, signs every delivery, and the routes verify that signature against
// their own `{APP_URL}/api/cron/*` URL (security/cron-auth.ts). Use only one trigger per route in
// production: with both Vercel Cron and these schedules, each tick runs twice (the leases make that
// harmless, but it doubles the work). A new schedule can take up to 60 s to become active.
//
// Usage (the live values in the gitignored worksheet `.env.wireup`, docs/WIRE_UP.md step 0.5; not
// `.env.production.local`, which `next build`/`next start` would load, and Vercel's "Sensitive"
// variables pull back empty anyway):
//   npx tsx --env-file=.env.wireup --tsconfig tsconfig.scripts.json scripts/qstash-schedules.ts --dry-run
//   npx tsx --env-file=.env.wireup --tsconfig tsconfig.scripts.json scripts/qstash-schedules.ts
// --dry-run prints the plan and calls nothing. A real run needs APP_MODE=live and an https APP_URL
// QStash can reach. The QStash token is never printed.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client, QstashError } from '@upstash/qstash';
import { EnvError, parseEnv, type Env } from '@/server/env';

/** The periodic routes and their UTC schedules, as vercel.json declares them (PLAN §8.1). */
export const CRON_ROUTES = [
  // A failed poll is not retried: the next tick is 5 minutes away and covers it.
  { name: 'poll', path: '/api/cron/poll', cron: '*/5 * * * *', retries: 0 },
  { name: 'weekly-report', path: '/api/cron/weekly-report', cron: '0 * * * *', retries: 3 },
  { name: 'daily', path: '/api/cron/daily', cron: '17 3 * * *', retries: 3 },
] as const;

export interface PlannedSchedule {
  /** Fixed, so a second run updates instead of adding (QStash allows letters, digits, `-`, `_`, `.`). */
  readonly scheduleId: string;
  readonly destination: string;
  readonly cron: string;
  readonly method: 'POST';
  readonly retries: number;
}

const SCHEDULE_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** The three schedules for this environment. Pure: no network, no secrets. */
export function buildSchedulePlan(env: Pick<Env, 'APP_URL' | 'ENV_NAMESPACE'>): PlannedSchedule[] {
  const origin = new URL(env.APP_URL).origin;
  return CRON_ROUTES.map((route) => {
    const scheduleId = `${env.ENV_NAMESPACE}-cron-${route.name}`;
    if (!SCHEDULE_ID.test(scheduleId)) throw new Error(`invalid schedule id: ${scheduleId}`);
    return { scheduleId, destination: `${origin}${route.path}`, cron: route.cron, method: 'POST', retries: route.retries };
  });
}

/** QStash must be able to reach the destinations: https and not a loopback or `.local` host. Returns the problems. */
export function destinationProblems(plan: readonly PlannedSchedule[]): string[] {
  const problems: string[] = [];
  for (const schedule of plan) {
    const url = new URL(schedule.destination);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:') problems.push(`${schedule.scheduleId}: the destination must use https`);
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || /^127\./.test(host) || host === '[::1]') {
      problems.push(`${schedule.scheduleId}: the destination must be reachable from QStash, not ${host}`);
    }
  }
  return problems;
}

export interface ScriptOptions {
  dryRun: boolean;
}

export function parseArgs(args: readonly string[]): ScriptOptions {
  let dryRun = false;
  for (const arg of args) {
    if (arg === '--dry-run') dryRun = true;
    else throw new Error(`unknown argument: ${arg} (usage: qstash-schedules [--dry-run])`);
  }
  return { dryRun };
}

/** One line per schedule; nothing secret. */
export function formatPlan(plan: readonly PlannedSchedule[]): string[] {
  const idWidth = Math.max(...plan.map((s) => s.scheduleId.length));
  const cronWidth = Math.max(...plan.map((s) => s.cron.length));
  return plan.map(
    (s) => `  ${s.scheduleId.padEnd(idWidth)}  ${s.cron.padEnd(cronWidth)}  ${s.method} ${s.destination}  retries=${s.retries}`,
  );
}

async function apply(env: Env, plan: readonly PlannedSchedule[]): Promise<void> {
  // Pinned like the live Scheduler: explicit token and region URL, never the dev server, no telemetry.
  const client = new Client({ token: env.QSTASH_TOKEN, baseUrl: env.QSTASH_URL, devMode: false, enableTelemetry: false });
  const existing = new Set((await client.schedules.list()).map((s) => s.scheduleId));
  for (const schedule of plan) {
    await client.schedules.create({
      scheduleId: schedule.scheduleId,
      destination: schedule.destination,
      cron: schedule.cron,
      method: schedule.method,
      retries: schedule.retries,
    });
    console.log(`qstash:schedules: ${existing.has(schedule.scheduleId) ? 'updated' : 'created'} ${schedule.scheduleId}`);
  }
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const env = parseEnv(process.env);
  const plan = buildSchedulePlan(env);
  console.log(`qstash:schedules: ${options.dryRun ? 'plan (dry run, nothing sent)' : 'plan'} for APP_MODE=${env.APP_MODE}:`);
  for (const line of formatPlan(plan)) console.log(line);
  if (options.dryRun) return 0;

  if (env.APP_MODE !== 'live') {
    console.error('qstash:schedules: FAIL a real run needs the live environment (APP_MODE=live); use --dry-run to preview.');
    return 1;
  }
  const problems = destinationProblems(plan);
  for (const problem of problems) console.error(`qstash:schedules: FAIL ${problem}`);
  if (problems.length > 0) return 1;
  await apply(env, plan);
  console.log('qstash:schedules: OK (a new schedule can take up to 60 s to become active)');
  return 0;
}

function describeFailure(err: unknown): string {
  if (err instanceof EnvError) return `invalid environment:\n  ${err.issues.join('\n  ')}`;
  // QStash error bodies are not echoed; the status says enough (401/403: token or region; 412: schedule limit).
  if (err instanceof QstashError) return `QStash refused the request (status ${err.status ?? 'none'})`;
  return err instanceof Error ? err.message : 'unknown error';
}

// Run only as a script (tests import the plan builder).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(`qstash:schedules: FAIL ${describeFailure(err)}`);
      process.exitCode = 1;
    },
  );
}
