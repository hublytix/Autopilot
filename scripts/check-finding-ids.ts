// Finding-ID check (PLAN §15 M8): every research finding ID the docs cite resolves to exactly one
// section of the research evidence, a `###` (or deeper) heading `<ID> — <title>` in
// docs/research/*.md. DECISIONS and PLAN cite findings in brackets, alone or as a comma list
// ([HS-SCOPES], [HS-SCOPES, HS-EMAIL-SCOPES]); later entries also name them bare (SB-KEYS-MODEL).
//
// What counts as a citation, outside fenced code blocks and inline code spans:
//   - every item of a bracketed group that has the shape of an ID (upper-case letters and digits in
//     two or more hyphen-separated parts, e.g. NX14-ADVISORIES), whatever its prefix, except
//     decision numbers (D-07) and markdown link texts ([text](url));
//   - every bare token with the prefix of a known finding family (AI-, HS-, QS-, …: the first part
//     of the IDs the research headings define), so a typo in a family we use is caught too (a link
//     text such as [HS-SCOPES](research/…) is checked this way).
// It exits 1 listing each unknown ID with file and line, when an ID heads two sections, or when a
// required file is missing or the research defines no IDs.
//
// Usage: npm run check:finding-ids [-- <markdown file> …]   (default: DEFAULT_CITING_FILES)
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RESEARCH_DIR = 'docs/research';

export interface CitingFile {
  readonly path: string;
  /** A missing required file fails the check; a missing optional one is skipped. */
  readonly required: boolean;
}

/** PLAN and DECISIONS (PLAN §15 M8), plus the M8 docs that cite findings. */
export const DEFAULT_CITING_FILES: readonly CitingFile[] = [
  { path: 'docs/PLAN.md', required: true },
  { path: 'docs/DECISIONS.md', required: true },
  { path: 'docs/WIRE_UP.md', required: false },
  { path: 'docs/ARCHITECTURE.md', required: false },
];

const ID_SHAPE = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;
const DECISION = /^D-\d+$/;
const HEADING = /^#{3,6}[ \t]+([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)(?=[ \t]|$)/;
const FENCE = /^[ \t]*(```|~~~)/;
/** A bracketed group that is not a markdown link text (`[text](url)`). */
const BRACKETS = /\[([^[\]\n]+)\](?!\()/g;
const INLINE_CODE = /`[^`\n]*`/g;

export interface FindingHeading {
  readonly id: string;
  readonly file: string;
  readonly line: number;
}

export interface Citation {
  readonly id: string;
  readonly file: string;
  readonly line: number;
}

export interface CheckResult {
  /** Missing files, duplicate headings, an empty research directory. */
  readonly problems: string[];
  /** Citations whose ID heads no research section, in file and line order. */
  readonly unknown: Citation[];
  /** Every distinct ID the research defines. */
  readonly known: number;
  /** Every citation found (bracketed or bare), one per ID and line. */
  readonly cited: number;
  /** The citing files that were read. */
  readonly scanned: string[];
}

/** The lines of a markdown text outside fenced code blocks, with their 1-based numbers. */
function proseLines(text: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let fence: string | null = null;
  text.split(/\r?\n/).forEach((raw, index) => {
    const marker = FENCE.exec(raw)?.[1];
    if (marker !== undefined) {
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      return;
    }
    if (fence === null) out.push({ text: raw, line: index + 1 });
  });
  return out;
}

/** The finding IDs a research file defines: `### <ID> — <title>` (or `####`, …). */
export function parseHeadings(text: string, file: string): FindingHeading[] {
  const headings: FindingHeading[] = [];
  for (const { text: line, line: number } of proseLines(text)) {
    const id = HEADING.exec(line)?.[1];
    if (id !== undefined) headings.push({ id, file, line: number });
  }
  return headings;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A matcher for bare tokens of the given ID families (longest prefix first). */
function bareMatcher(prefixes: ReadonlySet<string>): RegExp | null {
  if (prefixes.size === 0) return null;
  const alternatives = [...prefixes].sort((a, b) => b.length - a.length || a.localeCompare(b)).map(escapeRegExp);
  return new RegExp(`(?<![A-Za-z0-9-])((?:${alternatives.join('|')})-[A-Z0-9]+(?:-[A-Z0-9]+)*)(?![A-Za-z0-9])`, 'g');
}

/** The finding IDs a markdown text cites, one entry per ID and line. */
export function parseCitations(text: string, file: string, familyPrefixes: ReadonlySet<string>): Citation[] {
  const citations: Citation[] = [];
  const bare = bareMatcher(familyPrefixes);
  for (const { text: raw, line } of proseLines(text)) {
    const prose = raw.replace(INLINE_CODE, ' ');
    const ids = new Set<string>();
    for (const group of prose.matchAll(BRACKETS)) {
      for (const item of (group[1] ?? '').split(',')) {
        const id = item.trim();
        if (ID_SHAPE.test(id) && !DECISION.test(id)) ids.add(id);
      }
    }
    if (bare !== null) {
      for (const match of prose.matchAll(bare)) if (match[1] !== undefined) ids.add(match[1]);
    }
    for (const id of ids) citations.push({ id, file, line });
  }
  return citations;
}

/** The first hyphen-separated part of each ID: the families the bare-token scan looks for. */
export function familyPrefixes(ids: Iterable<string>): Set<string> {
  const prefixes = new Set<string>();
  for (const id of ids) {
    const prefix = id.split('-')[0];
    if (prefix !== undefined && prefix !== '') prefixes.add(prefix);
  }
  return prefixes;
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Runs the check from `cwd` (the repository root by default). Reads files only. */
export async function checkFindingIds(
  citing: readonly CitingFile[] = DEFAULT_CITING_FILES,
  cwd: string = process.cwd(),
  researchDir: string = RESEARCH_DIR,
): Promise<CheckResult> {
  const problems: string[] = [];
  const headings: FindingHeading[] = [];
  let researchFiles: string[] = [];
  try {
    researchFiles = (await readdir(resolve(cwd, researchDir))).filter((name) => name.endsWith('.md')).sort();
  } catch {
    problems.push(`${researchDir}: directory not found`);
  }
  for (const name of researchFiles) {
    const file = join(researchDir, name);
    headings.push(...parseHeadings(await readFile(resolve(cwd, file), 'utf8'), file));
  }

  const firstHeading = new Map<string, FindingHeading>();
  for (const heading of headings) {
    const first = firstHeading.get(heading.id);
    if (first === undefined) firstHeading.set(heading.id, heading);
    else problems.push(`${heading.id}: heads two sections (${first.file}:${first.line} and ${heading.file}:${heading.line})`);
  }
  if (researchFiles.length > 0 && firstHeading.size === 0) problems.push(`${researchDir}: no finding headings found`);

  const prefixes = familyPrefixes(firstHeading.keys());
  const citations: Citation[] = [];
  const scanned: string[] = [];
  for (const entry of citing) {
    const text = await readIfPresent(resolve(cwd, entry.path));
    if (text === null) {
      if (entry.required) problems.push(`${entry.path}: file not found`);
      continue;
    }
    const file = relative(cwd, resolve(cwd, entry.path));
    scanned.push(file);
    citations.push(...parseCitations(text, file, prefixes));
  }

  const unknown = citations.filter((citation) => !firstHeading.has(citation.id));
  return { problems, unknown, known: firstHeading.size, cited: citations.length, scanned };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const citing = args.length > 0 ? args.map((path) => ({ path, required: true })) : DEFAULT_CITING_FILES;
  const result = await checkFindingIds(citing);
  for (const problem of result.problems) console.error(`check:finding-ids: FAIL ${problem}`);
  for (const citation of result.unknown) {
    console.error(`check:finding-ids: FAIL ${citation.file}:${citation.line}: unknown finding ID ${citation.id}`);
  }
  if (result.problems.length > 0 || result.unknown.length > 0) {
    const ids = new Set(result.unknown.map((citation) => citation.id));
    if (ids.size > 0) console.error(`check:finding-ids: ${ids.size} unknown ID(s): ${[...ids].sort().join(', ')}`);
    return 1;
  }
  console.log(
    `check:finding-ids: OK, ${result.cited} citation(s) in ${result.scanned.join(', ')} resolve to the ${result.known} findings in ${RESEARCH_DIR}/*.md.`,
  );
  return 0;
}

// Run only as a script (tests import checkFindingIds).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error('check:finding-ids: FAIL could not complete the check:', err instanceof Error ? err.message : 'unknown error');
      process.exitCode = 1;
    },
  );
}
