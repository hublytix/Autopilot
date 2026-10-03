// `npm run simulate` (PLAN §13, D-39): runs the staged scenarios on fakes, PGlite in memory and a
// FakeClock, writes ./outbox/NNN-<kind>-<lead>.html/.txt and ./outbox/summary.json (the PLAN §13
// week) plus one directory per variant, and exits 1 if any check enabled so far fails (D-50).
//
// The run is then repeated with the system time set to 2030 (PLAN §13 "Setup", §18): each scenario
// again, in a process whose wall clock the preload scripts/simulation/system-time-preload.mjs moves to
// 2030-01-01T00:00:00Z (Date, Date(), performance.timeOrigin, and with them Postgres's now() inside
// PGlite), into ./outbox/system-time/ (variants beneath it). The simulation never reads the wall clock,
// so each repeat must match its run exactly: summary.json apart from `systemTime`, and every email
// file once the values that are random by design are masked (scripts/simulation/compare.ts). Any
// difference fails the command. SIMULATE_SYSTEM_TIME (a year or an ISO instant) picks another time
// for the repeat. The Vitest suite proves the same in-process with Vitest's faked Date
// (scripts/simulation/run.test.ts, scripts/simulation/{billing,lapse,disconnect}.test.ts) and tests the
// preload itself (scripts/simulation/system-time.test.ts).
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
// directory), as many at once as the machine has cores. `--only <name> [--outbox <dir>]` runs one in
// this process; with SIMULATE_SYSTEM_TIME set it must run under the preload, e.g.
//   SIMULATE_SYSTEM_TIME=2030 npx tsx --tsconfig tsconfig.scripts.json \
//     --import ./scripts/simulation/system-time-preload.mjs scripts/simulate.ts --only week --outbox outbox/system-time
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BILLING_SCENARIO, LAPSE_SCENARIO } from './simulation/billing';
import { compareRuns } from './simulation/compare';
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

/** The instant the system-time preload installed in this process (ISO), or null without it. */
function installedSystemTime(): string | null {
  const marker: unknown = (globalThis as Record<symbol, unknown>)[Symbol.for('autopilot.simulatedSystemTime')];
  return typeof marker === 'string' ? marker : null;
}

async function runOne(name: string, outbox: string): Promise<boolean> {
  const scenario = SCENARIOS[name];
  if (scenario === undefined) throw new Error(`unknown scenario ${name}`);
  // A repeat run that silently kept the real clock would prove nothing.
  const requested = process.env.SIMULATE_SYSTEM_TIME?.trim() ?? '';
  const systemTime = installedSystemTime();
  if (requested !== '' && systemTime === null) {
    throw new Error('SIMULATE_SYSTEM_TIME is set but the system-time preload is not active (start with --import ./scripts/simulation/system-time-preload.mjs)');
  }
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

/** The repeat's own outbox root, beneath ./outbox (each variant in its own directory under it). */
const REPEAT_DIR = 'system-time';
const PRELOAD = fileURLToPath(new URL('./simulation/system-time-preload.mjs', import.meta.url));

interface ChildRun {
  readonly name: string;
  /** SIMULATE_SYSTEM_TIME for a repeat (run under the preload); null for the run itself. */
  readonly systemTime: string | null;
  readonly outbox: string;
}

/** Runs `--only name` in a child process with this process's loader (tsx), passing on its report lines. */
function runChild(run: ChildRun): Promise<ChildResult> {
  return new Promise((resolve) => {
    const script = fileURLToPath(import.meta.url);
    const preload = run.systemTime === null ? [] : ['--import', pathToFileURL(PRELOAD).href];
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.SIMULATE_SYSTEM_TIME;
    if (run.systemTime !== null) env.SIMULATE_SYSTEM_TIME = run.systemTime;
    const child = spawn(process.execPath, [...process.execArgv, ...preload, script, '--only', run.name, '--outbox', run.outbox], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
    child.on('close', (code) => resolve({ name: run.systemTime === null ? run.name : `${run.name}@${run.systemTime}`, code, reported, tail }));
  });
}

/** Longest first, so the slowest scenario never starts last. */
const RUN_ORDER = ['disconnect', 'billing', 'lapse', 'week', 'daily-cap'] as const;

async function runAll(outbox: string, repeatSystemTime: string): Promise<boolean> {
  const repeatOutbox = path.join(outbox, REPEAT_DIR);
  const names = [...RUN_ORDER, ...Object.keys(SCENARIOS).filter((name) => !(RUN_ORDER as readonly string[]).includes(name))];
  // Each scenario and its repeat side by side, longest first.
  const queue: ChildRun[] = names.flatMap((name) => [
    { name, systemTime: null, outbox },
    { name, systemTime: repeatSystemTime, outbox: repeatOutbox },
  ]);
  const results: ChildResult[] = [];
  const workers = Math.max(1, Math.min(queue.length, availableParallelism()));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (let run = queue.shift(); run !== undefined; run = queue.shift()) results.push(await runChild(run));
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
  if (!ok) return false;

  // Each run against its repeat (PLAN §13: the 2030 run must be identical).
  for (const name of names) {
    const make = SCENARIOS[name];
    if (make === undefined) continue;
    const comparison = await compareRuns(make(outbox).outboxDir, make(repeatOutbox).outboxDir);
    const label = `${REPORT_PREFIX}repeat with the system time at ${repeatSystemTime}: ${name}`;
    if (comparison.differences.length === 0) {
      console.log(`${label} identical (summary.json and ${comparison.files} email files)`);
    } else {
      ok = false;
      console.error(`${REPORT_PREFIX}FAIL ${name}: the repeat differs: ${comparison.differences.slice(0, 10).join('; ')}`);
    }
  }
  return ok;
}

function argument(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<number> {
  const outbox = path.resolve(argument('--outbox') ?? path.join(process.cwd(), 'outbox'));
  const only = argument('--only');
  if (only !== undefined) return (await runOne(only, outbox)) ? 0 : 1;
  return (await runAll(outbox, process.env.SIMULATE_SYSTEM_TIME?.trim() || '2030')) ? 0 : 1;
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
