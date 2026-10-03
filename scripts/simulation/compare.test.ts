import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compareRuns, maskRandomValues, summaryDifferences } from './compare';

// The repeat-run comparison (PLAN §13 "The run is repeated with the system time set to 2030"):
// identical apart from `systemTime` and the values that are random in any two runs.

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'autopilot-compare-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const TOKEN_A = `apt_${'a'.repeat(43)}`;
const TOKEN_B = `apt_${'B'.repeat(43)}`;

async function writeRun(dir: string, summary: Record<string, unknown>, files: Record<string, string>): Promise<string> {
  const full = path.join(root, dir);
  await mkdir(full, { recursive: true });
  await writeFile(path.join(full, 'summary.json'), JSON.stringify(summary));
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(full, name), text);
  return full;
}

const SUMMARY = { scenario: 'week', systemTime: null, timeline: [{ at: '2026-10-06T13:00:00.000Z' }, { at: '2026-10-06T14:00:00.000Z' }], ok: true };

describe('compareRuns', () => {
  it('finds a run and its repeat identical when only systemTime and random tokens differ', async () => {
    const run = await writeRun('run', SUMMARY, {
      '001-magic_link.txt': 'http://localhost:3000/auth/confirm#th=0123456789abcdef0123456789abcdef01234567&type=email',
      '003-new_lead-L1.txt': `Send http://localhost:3000/a/${TOKEN_A}/send lead 5c1e8eea-23e0-43e7-83b6-24b5898081eb`,
      'notes.md': 'not an email',
    });
    const repeat = await writeRun('repeat', { ...SUMMARY, systemTime: '2030-01-01T00:00:00.000Z' }, {
      '001-magic_link.txt': 'http://localhost:3000/auth/confirm#th=fedcba9876543210fedcba9876543210fedcba98&type=email',
      '003-new_lead-L1.txt': `Send http://localhost:3000/a/${TOKEN_B}/send lead 0b6a7c2e-1111-4222-8333-944455556666`,
    });
    expect(await compareRuns(run, repeat)).toEqual({ files: 2, differences: [] });
  });

  it('reports a timeline entry that moved, a changed email and a missing one', async () => {
    const run = await writeRun('run', SUMMARY, { '001-magic_link.txt': 'Sent Tue 6 Oct', '002-inbox_test.txt': 'x' });
    const moved = { ...SUMMARY, systemTime: '2030', timeline: [SUMMARY.timeline[0], { at: '2030-01-01T00:00:00.000Z' }] };
    const repeat = await writeRun('repeat', moved, { '001-magic_link.txt': 'Sent Tue 1 Jan' });
    expect((await compareRuns(run, repeat)).differences).toEqual(['summary.timeline[1]', 'outbox files: 2 vs 1 (002-inbox_test.txt)', 'outbox 001-magic_link.txt']);
  });
});

describe('maskRandomValues and summaryDifferences', () => {
  it('masks action tokens, token hashes and UUIDs, nothing else', () => {
    expect(maskRandomValues(`/a/${TOKEN_A}/edit #th=${'ab'.repeat(28)}& 5C1E8EEA-23E0-43E7-83B6-24B5898081EB 2026-10-06`)).toBe(
      '/a/{action-token}/edit #th={token-hash}& {uuid} 2026-10-06',
    );
  });

  it('ignores systemTime and names arrays of different lengths', () => {
    expect(summaryDifferences({ systemTime: null, emails: [1, 2] }, { systemTime: '2030', emails: [1, 2, 3] })).toEqual(['summary.emails[2] (length 2 vs 3)']);
    expect(summaryDifferences({ ok: true }, { ok: false })).toEqual(['summary.ok']);
  });
});
