import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// The system-time preload (PLAN §13 "The run is repeated with the system time set to 2030"): a real
// Node process started with `--import` it, as `npm run simulate` starts each repeat scenario. The
// probe runs as an `--eval` string in that process, so it can read the (faked) wall clock the way a
// stray `new Date()` in the app would, including Postgres's own `now()` inside PGlite.

const PRELOAD = pathToFileURL(path.join(process.cwd(), 'scripts/simulation/system-time-preload.mjs')).href;

const PROBE = `
const D = globalThis.Date;
class Sub extends D {}
const { PGlite } = await import('@electric-sql/pglite');
const db = new PGlite();
const pg = await db.query("select to_char(now() at time zone 'UTC', 'YYYY') as year, to_char(clock_timestamp() at time zone 'UTC', 'YYYY') as clock");
await db.close();
const { statSync } = await import('node:fs');
const call = D();
console.log(JSON.stringify({
  name: D.name,
  marker: globalThis[Symbol.for('autopilot.simulatedSystemTime')] ?? null,
  newDateYear: new D().getUTCFullYear(),
  nowMs: D.now(),
  callYear: /\\b(\\d{4})\\b/.exec(call)?.[1] ?? null,
  epoch: new D(0).toISOString(),
  fromParts: new D(2026, 9, 6).getFullYear(),
  parse: D.parse('2026-10-06T13:00:00.000Z'),
  utc: D.UTC(2026, 9, 6, 13),
  instance: new D(5) instanceof D,
  nodeDate: statSync('.').mtime instanceof D,
  subclass: new Sub(0) instanceof Sub && new Sub(0) instanceof D && new Sub().getUTCFullYear(),
  timeOriginYear: new D(performance.timeOrigin + performance.now()).getUTCFullYear(),
  pgYear: pg.rows[0].year,
  pgClockYear: pg.rows[0].clock,
}));
`;

interface ProbeResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function probe(systemTime: string | undefined): Promise<ProbeResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.SIMULATE_SYSTEM_TIME;
  if (systemTime !== undefined) env.SIMULATE_SYSTEM_TIME = systemTime;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', PRELOAD, '--input-type=module', '--eval', PROBE], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function parsed(result: ProbeResult): Record<string, unknown> {
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>;
}

describe('the simulation system-time preload', () => {
  it('moves the whole process to 2030: Date, Date(), performance.timeOrigin and Postgres now() in PGlite', async () => {
    const result = parsed(await probe('2030'));
    const start = Date.UTC(2030, 0, 1);
    expect(result).toMatchObject({
      name: 'SimulatedDate',
      marker: '2030-01-01T00:00:00.000Z',
      newDateYear: 2030,
      callYear: '2030',
      timeOriginYear: 2030,
      pgYear: '2030',
      pgClockYear: '2030',
      subclass: 2030,
    });
    // The clock starts at the instant and advances with the process (a few seconds at most here).
    expect(result.nowMs).toBeGreaterThanOrEqual(start);
    expect(result.nowMs).toBeLessThan(start + 60_000);
  }, 60_000);

  it('leaves dates built from a value, instanceof (also for dates Node creates) and subclasses intact', async () => {
    const result = parsed(await probe('2030-06-15T12:00:00Z'));
    expect(result).toMatchObject({
      marker: '2030-06-15T12:00:00.000Z',
      epoch: '1970-01-01T00:00:00.000Z',
      fromParts: 2026,
      parse: Date.parse('2026-10-06T13:00:00.000Z'),
      utc: Date.UTC(2026, 9, 6, 13),
      instance: true,
      nodeDate: true,
    });
  }, 60_000);

  it('does nothing without SIMULATE_SYSTEM_TIME', async () => {
    const result = parsed(await probe(undefined));
    expect(result.name).toBe('Date');
    expect(result.marker).toBeNull();
  }, 60_000);

  it('refuses a value that is neither a year nor an ISO instant', async () => {
    const result = await probe('next tuesday');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('SIMULATE_SYSTEM_TIME must be a year or an ISO instant');
  }, 60_000);
});
