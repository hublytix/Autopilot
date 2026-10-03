import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkFindingIds, familyPrefixes, parseCitations, parseHeadings, type CitingFile } from './check-finding-ids';

// The finding-ID check (PLAN §15 M8) on planted docs: citations in PLAN and DECISIONS must resolve
// to a heading in docs/research/*.md; anything else is listed with its file and line.

let cwd: string;

async function put(relativePath: string, text: string): Promise<void> {
  const file = path.join(cwd, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
}

const RESEARCH = [
  '# 02 HubSpot',
  '### HS-SCOPES — Minimum read-only scope set',
  'text',
  '### HS-EMAIL-SCOPES — Reading email engagements',
  '#### HS-V1-REVOKE-RESPONSE — a verifier-added item',
  '### 02.y Test vectors',
  '```',
  '### HS-INSIDE-A-FENCE — not a heading',
  '```',
].join('\n');

const ONLY_PLAN: readonly CitingFile[] = [{ path: 'docs/PLAN.md', required: true }];

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'autopilot-finding-ids-'));
  await put('docs/research/02-hubspot.md', RESEARCH);
  await put('docs/research/07-qstash.md', '### QS-CANCEL — Cancelling scheduled messages\n### NX14-ADVISORIES — advisories\n');
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('check:finding-ids', () => {
  it('passes when every bracketed and bare citation heads a research section', async () => {
    await put(
      'docs/PLAN.md',
      [
        'Scopes [HS-SCOPES] and lists [HS-SCOPES, HS-EMAIL-SCOPES], a deeper heading [HS-V1-REVOKE-RESPONSE].',
        'A bare mention (QS-CANCEL) and NX14-ADVISORIES-based reasoning.',
      ].join('\n'),
    );
    const result = await checkFindingIds(ONLY_PLAN, cwd);
    expect(result.problems).toEqual([]);
    expect(result.unknown).toEqual([]);
    expect(result.known).toBe(5);
    expect(result.cited).toBe(5);
  });

  it('lists each unknown ID with its file and line, in brackets or bare', async () => {
    await put('docs/PLAN.md', 'ok [HS-SCOPES]\nlist [HS-SCOPES, HS-SCOPE-TYPO]\nbare QS-CANCELL here\nnew family [ZZ-NOT-RESEARCHED]\n');
    const result = await checkFindingIds(ONLY_PLAN, cwd);
    expect(result.unknown).toEqual([
      { id: 'HS-SCOPE-TYPO', file: path.join('docs', 'PLAN.md'), line: 2 },
      { id: 'QS-CANCELL', file: path.join('docs', 'PLAN.md'), line: 3 },
      { id: 'ZZ-NOT-RESEARCHED', file: path.join('docs', 'PLAN.md'), line: 4 },
    ]);
  });

  it('ignores decision numbers, link texts, placeholders, inline code and fenced code', async () => {
    await put(
      'docs/PLAN.md',
      [
        'See [D-03] and [D-07, D-49]; the [Name] placeholder, [token], [at] and [.] defangs.',
        'A link [ZZ-LINK-TEXT](https://example.com) and a class `[A-Z0-9-]` or `HS-IN-CODE`.',
        '```sql',
        'select 1 -- [HS-IN-A-FENCE] QS-IN-A-FENCE',
        '```',
      ].join('\n'),
    );
    const result = await checkFindingIds(ONLY_PLAN, cwd);
    expect(result.unknown).toEqual([]);
    expect(result.cited).toBe(0);
  });

  it('still checks a known-family ID used as a link text', async () => {
    await put('docs/PLAN.md', 'See [HS-SCOPES](research/02-hubspot.md) and [HS-SCOPEZ](research/02-hubspot.md).\n');
    const result = await checkFindingIds(ONLY_PLAN, cwd);
    expect(result.unknown.map((c) => c.id)).toEqual(['HS-SCOPEZ']);
  });

  it('does not count a heading inside a fenced block in the research as a finding', async () => {
    await put('docs/PLAN.md', 'Cited [HS-INSIDE-A-FENCE].\n');
    const result = await checkFindingIds(ONLY_PLAN, cwd);
    expect(result.unknown.map((c) => c.id)).toEqual(['HS-INSIDE-A-FENCE']);
  });

  it('fails when an ID heads two sections, or a required file is missing; skips a missing optional one', async () => {
    await put('docs/research/09-other.md', '### HS-SCOPES — defined again\n');
    await put('docs/PLAN.md', '[HS-SCOPES]\n');
    const result = await checkFindingIds(
      [...ONLY_PLAN, { path: 'docs/DECISIONS.md', required: true }, { path: 'docs/WIRE_UP.md', required: false }],
      cwd,
    );
    expect(result.problems).toEqual([
      `HS-SCOPES: heads two sections (${path.join('docs', 'research', '02-hubspot.md')}:2 and ${path.join('docs', 'research', '09-other.md')}:1)`,
      'docs/DECISIONS.md: file not found',
    ]);
    expect(result.scanned).toEqual([path.join('docs', 'PLAN.md')]);
  });

  it('fails when the research directory is missing', async () => {
    await rm(path.join(cwd, 'docs', 'research'), { recursive: true });
    await put('docs/PLAN.md', '[HS-SCOPES]\n');
    const result = await checkFindingIds(ONLY_PLAN, cwd);
    expect(result.problems).toEqual(['docs/research: directory not found']);
    expect(result.unknown.map((c) => c.id)).toEqual(['HS-SCOPES']);
  });

  it('parses headings, families and one citation per ID and line', () => {
    expect(parseHeadings(RESEARCH, 'r.md').map((h) => `${h.id}@${h.line}`)).toEqual([
      'HS-SCOPES@2',
      'HS-EMAIL-SCOPES@4',
      'HS-V1-REVOKE-RESPONSE@5',
    ]);
    expect([...familyPrefixes(['HS-SCOPES', 'NX14-ADVISORIES', 'NX-SUPPORT-STATUS'])].sort()).toEqual(['HS', 'NX', 'NX14']);
    expect(parseCitations('[HS-SCOPES] again HS-SCOPES, and X-HS-HEADER', 'f.md', new Set(['HS']))).toEqual([
      { id: 'HS-SCOPES', file: 'f.md', line: 1 },
    ]);
  });

  it('passes on this repository: PLAN, DECISIONS and the M8 docs cite only researched findings', async () => {
    const result = await checkFindingIds();
    expect(result.problems).toEqual([]);
    expect(result.unknown).toEqual([]);
    expect(result.cited).toBeGreaterThan(100);
  });
});
