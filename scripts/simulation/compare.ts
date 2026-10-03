// Compares two runs of one scenario: the normal run and its repeat under a faked system time
// (PLAN §13 "The run is repeated with the system time set to 2030", §18). The simulation never reads
// the wall clock, so the two must be identical: summary.json (apart from `systemTime`, which records
// the repeat's clock) and every outbox email, byte for byte once the values that are random by design
// (action tokens, magic-link token hashes, UUIDs; different in any two runs) are masked.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { SUMMARY_FILE } from './run';

/** The email files a run writes into its outbox directory (`NNN-<kind>[-<lead>].html/.txt`). */
export const OUTBOX_EMAIL_FILE = /^\d{3}-[A-Za-z0-9_-]+\.(?:html|txt)$/;

/** Values that differ between any two runs (cryptographically random), whatever the clock says. */
const RANDOM_VALUES: readonly (readonly [RegExp, string])[] = [
  [/apt_[A-Za-z0-9_-]{43}/g, '{action-token}'],
  [/\bth=[0-9a-f]{32,}/g, 'th={token-hash}'],
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{uuid}'],
];

export function maskRandomValues(text: string): string {
  return RANDOM_VALUES.reduce((masked, [pattern, replacement]) => masked.replace(pattern, replacement), text);
}

/** Where two parsed summaries differ: top-level keys, and the first differing index of an array. */
export function summaryDifferences(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => key !== 'systemTime');
  const differences: string[] = [];
  for (const key of keys) {
    const left = a[key];
    const right = b[key];
    if (isDeepStrictEqual(left, right)) continue;
    if (Array.isArray(left) && Array.isArray(right)) {
      const index = Array.from({ length: Math.max(left.length, right.length) }, (_, i) => i).find((i) => !isDeepStrictEqual(left[i], right[i]));
      differences.push(`summary.${key}[${String(index)}]${left.length !== right.length ? ` (length ${left.length} vs ${right.length})` : ''}`);
    } else {
      differences.push(`summary.${key}`);
    }
  }
  return differences;
}

async function emailFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => OUTBOX_EMAIL_FILE.test(name)).sort();
}

export interface RunComparison {
  /** Email files compared (html and txt). */
  readonly files: number;
  /** Empty when the runs are identical. */
  readonly differences: readonly string[];
}

/** Compares the run in `dir` with its repeat in `repeatDir`. */
export async function compareRuns(dir: string, repeatDir: string): Promise<RunComparison> {
  const read = async (from: string) => JSON.parse(await readFile(path.join(from, SUMMARY_FILE), 'utf8')) as Record<string, unknown>;
  const differences = summaryDifferences(await read(dir), await read(repeatDir));
  const [files, repeatFiles] = await Promise.all([emailFiles(dir), emailFiles(repeatDir)]);
  if (!isDeepStrictEqual(files, repeatFiles)) differences.push(`outbox files: ${files.length} vs ${repeatFiles.length} (${files.filter((f) => !repeatFiles.includes(f)).concat(repeatFiles.filter((f) => !files.includes(f))).join(', ')})`);
  for (const file of files.filter((f) => repeatFiles.includes(f))) {
    const [text, repeatText] = await Promise.all([readFile(path.join(dir, file), 'utf8'), readFile(path.join(repeatDir, file), 'utf8')]);
    if (maskRandomValues(text) !== maskRandomValues(repeatText)) differences.push(`outbox ${file}`);
  }
  return { files: files.length, differences };
}
