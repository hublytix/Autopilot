// `npm run simulate` (PLAN §13, D-39): runs the staged scenario on fakes, PGlite in memory and a
// FakeClock, writes ./outbox/NNN-<kind>-<lead>.html/.txt and ./outbox/summary.json, and exits 1 if
// any check enabled so far fails (D-50).
//
// SIMULATE_SYSTEM_TIME (e.g. 2030) is recorded in the summary. The simulation never reads the wall
// clock, so the output must be the same whatever the system time is; the Vitest suite proves that
// by running every stage with the system time faked to 2030 (scripts/simulation/run.test.ts).
// Stages so far: boot (M1), the real onboarding pre-run (M3), Day 0 intake with the drafted
// new_lead emails and the owner's "Send from my email" taps (M2 + M4), `day-0-emails` (M4: "Edit
// first" and "Not a real lead" on the new_lead emails, and every action link of those emails
// resolving without counting a click), Days 1–5 (M5: #5's send on Wednesday, follow-up 1 ×4 on
// Thursday, #6's reply on Friday, follow-up 2 ×3 and reply_detected on Sunday, statuses after each
// step), Monday's report and Wednesday's final statuses and dashboard (M6), and the test-lead
// exclusions (M3); see scripts/simulation/stages.ts. Then the daily-cap variant (M6,
// MAX_DRAFTED_LEADS_PER_DAY=1) runs on its own into ./outbox/daily-cap/.
import path from 'node:path';
import { DAILY_CAP_ENV, DAILY_CAP_SCENARIO } from './simulation/daily-cap';
import { runSimulation, SUMMARY_FILE, type RunOptions } from './simulation/run';
import { DAILY_CAP_STAGES } from './simulation/stages';
import type { SimulationSummary } from './simulation/types';

function report(summary: SimulationSummary, outboxDir: string): void {
  for (const check of summary.checks.filter((c) => !c.ok)) {
    console.error(`simulate: FAIL [${summary.scenario}/${check.stage}] ${check.id}${check.detail !== undefined ? `: ${check.detail}` : ''}`);
  }
  const passed = summary.checks.filter((c) => c.ok).length;
  const stages = summary.stages.map((s) => `${s.id}(${s.milestone})`).join(', ');
  console.log(
    `simulate: scenario=${summary.scenario} stages=[${stages}] timeline=${summary.timeline.length} ` +
      `emails=${summary.emails.length} leads=${summary.leads.length} checks=${passed}/${summary.checks.length} ` +
      `systemTime=${summary.systemTime ?? 'unset'} ok=${String(summary.ok)} -> ${path.relative(process.cwd(), path.join(outboxDir, SUMMARY_FILE))}`,
  );
}

async function main(): Promise<number> {
  const outboxDir = path.join(process.cwd(), 'outbox');
  const systemTime = process.env.SIMULATE_SYSTEM_TIME?.trim() || null;
  const runs: RunOptions[] = [
    // The PLAN §13 week: ./outbox/NNN-<kind>-<lead>.html/.txt and ./outbox/summary.json.
    { outboxDir, systemTime },
    // The daily-cap variant (M6): its own directory, so the main outbox is exactly the 15 emails.
    { outboxDir: path.join(outboxDir, 'daily-cap'), systemTime, stages: DAILY_CAP_STAGES, scenario: DAILY_CAP_SCENARIO, env: DAILY_CAP_ENV },
  ];
  let ok = true;
  for (const options of runs) {
    const summary = await runSimulation(options);
    report(summary, options.outboxDir);
    ok &&= summary.ok;
  }
  return ok ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error('simulate: failed', err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error');
    process.exitCode = 1;
  },
);
