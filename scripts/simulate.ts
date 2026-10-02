// `npm run simulate` (PLAN §13, D-39): runs the staged scenarios on fakes, PGlite in memory and a
// FakeClock, writes ./outbox/NNN-<kind>-<lead>.html/.txt and ./outbox/summary.json (the PLAN §13
// week) plus one directory per variant, and exits 1 if any check enabled so far fails (D-50).
//
// SIMULATE_SYSTEM_TIME (e.g. 2030) is recorded in the summary. The simulation never reads the wall
// clock, so the output must be the same whatever the system time is; the Vitest suite proves that
// by running the stages with the system time faked to 2030 (scripts/simulation/run.test.ts,
// scripts/simulation/{billing,lapse,disconnect}.test.ts).
// Scenarios (scripts/simulation/stages.ts):
//   week        the PLAN §13 week, ./outbox: boot (M1), the real onboarding pre-run (M3), Day 0 intake
//               with the drafted new_lead emails and the owner's taps (M2 + M4), the action links (M4),
//               Days 1–5 (M5), Monday's report and Wednesday's dashboard (M6), the test-lead
//               exclusions (M3), and the daily 03:17 UTC maintenance run for real all week (M7);
//   daily-cap   MAX_DRAFTED_LEADS_PER_DAY=1 (M6), ./outbox/daily-cap;
//   billing     subscribe during the trial → authenticated → past the trial end → charged → active (M7);
//   lapse       no subscription → inactive at the trial's end, one billing_inactive email (M7);
//   disconnect  Disconnect → the purge 30 days later, tombstones only, no content left (M7).
// Each scenario runs in its own process (they share nothing: own PGlite, fakes, clock and outbox
// directory), as many at once as the machine has cores; `--only <name>` runs one in this process.
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BILLING_SCENARIO, LAPSE_SCENARIO } from './simulation/billing';
import { DAILY_CAP_ENV, DAILY_CAP_SCENARIO } from './simulation/daily-cap';
import { DISCONNECT_SCENARIO } from './simulation/disconnect';
import { runSimulation, SCENARIO, SUMMARY_FILE, type RunOptions } from './simulation/run';
import { BILLING_STAGES, DAILY_CAP_STAGES, DISCONNECT_STAGES, LAPSE_STAGES, STAGES } from './simulation/stages';
import type { SimulationSummary } from './simulation/types';

/** Where each scenario writes, relative to ./outbox, and how it runs. */
const SCENARIOS: Readonly<Record<string, (outbox: string) => Omit<RunOptions, 'systemTime'>>> = {
  week: (outbox) => ({ outboxDir: outbox, stages: STAGES, scenario: SCENARIO }),
  'daily-cap': (outbox) => ({ outboxDir: path.join(outbox, 'daily-cap'), stages: DAILY_CAP_STAGES, scenario: DAILY_CAP_SCENARIO, env: DAILY_CAP_ENV }),
  billing: (outbox) => ({ outboxDir: path.join(outbox, 'billing'), stages: BILLING_STAGES, scenario: BILLING_SCENARIO }),
  lapse: (outbox) => ({ outboxDir: path.join(outbox, 'lapse'), stages: LAPSE_STAGES, scenario: LAPSE_SCENARIO }),
  disconnect: (outbox) => ({ outboxDir: path.join(outbox, 'disconnect'), stages: DISCONNECT_STAGES, scenario: DISCONNECT_SCENARIO }),
};

/** Lines a scenario process prints for the parent to pass on (everything else is the app's JSON log). */
const REPORT_PREFIX = 'simulate: ';

function report(summary: SimulationSummary, outboxDir: string): void {
  for (const check of summary.checks.filter((c) => !c.ok)) {
    console.error(`${REPORT_PREFIX}FAIL [${summary.scenario}/${check.stage}] ${check.id}${check.detail !== undefined ? `: ${check.detail}` : ''}`);
  }
  const passed = summary.checks.filter((c) => c.ok).length;
  const stages = summary.stages.map((s) => `${s.id}(${s.milestone})`).join(', ');
  console.log(
    `${REPORT_PREFIX}scenario=${summary.scenario} stages=[${stages}] timeline=${summary.timeline.length} ` +
      `emails=${summary.emails.length} leads=${summary.leads.length} checks=${passed}/${summary.checks.length} ` +
      `systemTime=${summary.systemTime ?? 'unset'} ok=${String(summary.ok)} -> ${path.relative(process.cwd(), path.join(outboxDir, SUMMARY_FILE))}`,
  );
}

async function runOne(name: string, outbox: string, systemTime: string | null): Promise<boolean> {
  const scenario = SCENARIOS[name];
  if (scenario === undefined) throw new Error(`unknown scenario ${name}`);
  const options = { ...scenario(outbox), systemTime };
  const summary = await runSimulation(options);
  report(summary, options.outboxDir);
  return summary.ok;
}

interface ChildResult {
  readonly name: string;
  readonly code: number | null;
  readonly reported: boolean;
  readonly tail: readonly string[];
}

/** Runs `--only name` in a child process with this process's loader (tsx), passing on its report lines. */
function runChild(name: string): Promise<ChildResult> {
  return new Promise((resolve) => {
    const script = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, [...process.execArgv, script, '--only', name], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const tail: string[] = [];
    let reported = false;
    let pending = '';
    const onData = (chunk: Buffer): void => {
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith(REPORT_PREFIX)) {
          if (line.startsWith(`${REPORT_PREFIX}scenario=`)) reported = true;
          console.log(line);
        }
        tail.push(line);
        if (tail.length > 40) tail.shift();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => resolve({ name, code, reported, tail }));
  });
}

/** Longest first, so the slowest scenario never starts last. */
const RUN_ORDER = ['disconnect', 'billing', 'lapse', 'week', 'daily-cap'] as const;

async function runAll(): Promise<boolean> {
  const queue: string[] = [...RUN_ORDER, ...Object.keys(SCENARIOS).filter((name) => !(RUN_ORDER as readonly string[]).includes(name))];
  const results: ChildResult[] = [];
  const workers = Math.max(1, Math.min(queue.length, availableParallelism()));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (let name = queue.shift(); name !== undefined; name = queue.shift()) results.push(await runChild(name));
    }),
  );
  let ok = true;
  for (const result of results) {
    if (result.code === 0) continue;
    ok = false;
    if (!result.reported) {
      console.error(`${REPORT_PREFIX}scenario ${result.name} stopped (exit ${String(result.code)}); its last lines:`);
      for (const line of result.tail) console.error(`  ${line}`);
    }
  }
  return ok;
}

async function main(): Promise<number> {
  const outbox = path.join(process.cwd(), 'outbox');
  const systemTime = process.env.SIMULATE_SYSTEM_TIME?.trim() || null;
  const only = process.argv.indexOf('--only');
  if (only >= 0) {
    const name = process.argv[only + 1] ?? '';
    return (await runOne(name, outbox, systemTime)) ? 0 : 1;
  }
  return (await runAll()) ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`${REPORT_PREFIX}failed`, err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error');
    process.exitCode = 1;
  },
);
