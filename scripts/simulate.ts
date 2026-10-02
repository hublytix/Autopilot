// `npm run simulate` (PLAN §13, D-39): runs the staged scenario on fakes, PGlite in memory and a
// FakeClock, writes ./outbox/NNN-<kind>-<lead>.html/.txt and ./outbox/summary.json, and exits 1 if
// any check enabled so far fails (D-50).
//
// SIMULATE_SYSTEM_TIME (e.g. 2030) is recorded in the summary. The simulation never reads the wall
// clock, so the output must be the same whatever the system time is; the Vitest suite proves that
// by running every stage with the system time faked to 2030 (scripts/simulation/run.test.ts).
// Stages so far: boot (M1), seed + Day 0 intake (M2); see scripts/simulation/stages.ts.
import path from 'node:path';
import { runSimulation, SUMMARY_FILE } from './simulation/run';

async function main(): Promise<number> {
  const outboxDir = path.join(process.cwd(), 'outbox');
  const systemTime = process.env.SIMULATE_SYSTEM_TIME?.trim() || null;
  const summary = await runSimulation({ outboxDir, systemTime });

  for (const check of summary.checks.filter((c) => !c.ok)) {
    console.error(`simulate: FAIL [${check.stage}] ${check.id}${check.detail !== undefined ? `: ${check.detail}` : ''}`);
  }
  const passed = summary.checks.filter((c) => c.ok).length;
  const stages = summary.stages.map((s) => `${s.id}(${s.milestone})`).join(', ');
  console.log(
    `simulate: scenario=${summary.scenario} stages=[${stages}] timeline=${summary.timeline.length} ` +
      `emails=${summary.emails.length} leads=${summary.leads.length} checks=${passed}/${summary.checks.length} ` +
      `systemTime=${summary.systemTime ?? 'unset'} ok=${String(summary.ok)} -> ${path.relative(process.cwd(), path.join(outboxDir, SUMMARY_FILE))}`,
  );
  return summary.ok ? 0 : 1;
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
