import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

// PLAN §3: the module boundaries, the D-28 wall-clock ban and the D-13 compose ban are ESLint
// rules; this proves they are switched on for the paths they guard (a rule that silently stopped
// matching would otherwise pass `npm run lint` forever). Plus: every src/server module imports
// 'server-only'.

const root = process.cwd();

async function serverModules(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
}

describe('server-only', () => {
  it('is imported by every module under src/server', async () => {
    const missing: string[] = [];
    for (const file of await serverModules(path.join(root, 'src', 'server'))) {
      const text = await readFile(path.join(root, file), 'utf8');
      if (!/^import 'server-only';$/m.test(text)) missing.push(file);
    }
    expect(missing).toEqual([]);
  });
});

describe('nothing builds the container at `next build` (D-29)', () => {
  it('every page and layout reads the request before getDeps(), so the prerender attempt stops first', async () => {
    const entries = await readdir(path.join(root, 'src', 'app'), { withFileTypes: true, recursive: true });
    const files = entries
      .filter((entry) => entry.isFile() && /^(?:page|layout)\.tsx$/.test(entry.name))
      .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)));
    const late: string[] = [];
    let checked = 0;
    for (const file of files) {
      const text = await readFile(path.join(root, file), 'utf8');
      const deps = text.indexOf('getDeps(');
      if (deps === -1) continue;
      checked += 1;
      const request = [text.indexOf('await headers()'), text.indexOf('await connection()'), text.indexOf('await cookies()')].filter((i) => i !== -1);
      if (request.length === 0 || Math.min(...request) > deps) late.push(file);
    }
    expect(checked).toBeGreaterThan(15);
    expect(late).toEqual([]);
  });
});

describe('ESLint guards', () => {
  let eslint: ESLint;

  beforeAll(() => {
    eslint = new ESLint({ cwd: root });
  });

  /** Lints `code` as if it lived at `file` and returns the rule ids that fired. */
  async function rulesFiredAt(file: string, code: string): Promise<string[]> {
    const [result] = await eslint.lintText(code, { filePath: path.join(root, file) });
    return (result?.messages ?? []).map((message) => message.ruleId ?? 'fatal');
  }

  // Two layers guard the boundaries: the regex rule on the raw specifier and the resolved-path rule.
  const REGEX_BOUNDARY = '@typescript-eslint/no-restricted-imports';
  const RESOLVED_BOUNDARY = 'autopilot/import-boundaries';
  const SYNTAX = 'no-restricted-syntax';
  const isBoundary = (rule: string): boolean => rule === REGEX_BOUNDARY || rule === RESOLVED_BOUNDARY;

  it.each([
    ['src/server/services/x.ts', "import { FakeClock } from '@/server/adapters/fake/clock';\nexport const c = FakeClock;\n"],
    ['src/server/adapters/fake/x.ts', "import { run } from '@/server/services/run';\nexport const r = run;\n"],
    // Live HTTP handlers never depend on a (fake) adapter module; Deps carries the adapters.
    ['src/server/http/x.ts', "import { withSetCookies } from '@/server/adapters/fake/auth/cookies';\nexport const w = withSetCookies;\n"],
    ['src/server/domain/x.ts', "import { getEnv } from '@/server/env';\nexport const e = getEnv;\n"],
    ['src/server/domain/y.ts', "import { readFile } from 'node:fs/promises';\nexport const r = readFile;\n"],
    ['src/server/ports/x.ts', "import { getEnv } from '@/server/env';\nexport const e = getEnv;\n"],
    ['src/app/x/page.tsx', "import { migrate } from '@/server/db/migrate';\nexport const m = migrate;\n"],
    ['src/components/x.tsx', "import { getEnv } from '@/server/env';\nexport const e = getEnv;\n"],
    ['src/shared/x.ts', "import { log } from '../server/obs/log';\nexport const l = log;\n"],
    // PLAN §3, §7.7: the proxy imports only the CSP builder and the session-refresh adapter.
    ['src/proxy.ts', "import { createPgliteDb } from '@/server/db/pglite';\nexport const d = createPgliteDb;\n"],
    ['src/proxy.ts', "import { getEnv } from '@/server/env';\nexport const e = getEnv;\n"],
    ['src/proxy.ts', "import { getDeps } from '@/server/container';\nexport const d = getDeps;\n"],
    ['src/proxy.ts', "import { createServerClient } from '@supabase/ssr';\nexport const c = createServerClient;\n"],
  ])('rejects a boundary-crossing import in %s', async (file, code) => {
    expect((await rulesFiredAt(file, code)).filter(isBoundary)).toEqual(expect.arrayContaining([REGEX_BOUNDARY, RESOLVED_BOUNDARY]));
  });

  // Spellings that resolve to a forbidden module but do not read like it, and loads the regex layer
  // cannot see (import(), require(), re-exports). The resolved-path rule catches every one.
  it.each([
    ['src/server/services/x.ts', "import { m } from './../adapters/fake/mailer';\nexport const a = m;\n"],
    ['src/server/services/x.ts', "import { SystemClock } from '../../server/adapters/live/system-clock';\nexport const a = SystemClock;\n"],
    ['src/server/services/x.ts', "import { createFakeDeps } from '@/server/services/../adapters/fake';\nexport const a = createFakeDeps;\n"],
    ['src/server/services/x.ts', "export const a = await import('@/server/adapters/fake');\n"],
    ['src/server/services/x.ts', "export const a = await import(`@/server/adapters/fake`);\n"],
    ['src/server/services/x.ts', "const where = '@/server/adapters/fake';\nexport const a = await import(where);\n"],
    ['src/server/services/x.ts', "export { FakeClock } from '@/server/adapters/fake/clock';\n"],
    ['src/server/services/x.ts', "export * from '@/server/adapters/fake/clock';\n"],
    ['src/server/services/x.ts', "export const a = require('@/server/adapters/fake');\n"],
    ['src/app/x/page.tsx', "import { getEnv } from '@/server/http/../env';\nexport const a = getEnv;\n"],
    ['src/app/x/page.tsx', "import { log } from './../server/obs/log';\nexport const a = log;\n"],
    ['src/app/x/page.tsx', "import { log } from '../../server/obs/log';\nexport const a = log;\n"],
    ['src/app/x/page.tsx', "import { createPgliteDb } from '@/server/container/../db/pglite';\nexport const a = createPgliteDb;\n"],
    ['src/app/x/page.tsx', "export const a = await import('@/server/db');\n"],
    ['src/server/domain/x.ts', "import { getEnv } from '@/server/domain/../env';\nexport const a = getEnv;\n"],
    ['src/server/domain/x.ts', "import { log } from './../obs/log';\nexport const a = log;\n"],
    ['src/server/domain/x.ts', "export const a = await import('node:crypto');\n"],
    ['src/shared/x.ts', "import { getEnv } from './../server/env';\nexport const a = getEnv;\n"],
    ['src/shared/x.ts', "export const a = await import('@/server/env');\n"],
    ['src/proxy.ts', "export const a = await import('@/server/db');\n"],
    ['src/proxy.ts', "import { getEnv } from './server/env';\nexport const a = getEnv;\n"],
  ])('rejects a disguised or dynamic boundary crossing in %s: %s', async (file, code) => {
    expect(await rulesFiredAt(file, code)).toContain(RESOLVED_BOUNDARY);
  });

  it.each([
    ['src/app/x/route.ts', "import { getDeps } from '@/server/container';\nimport type { Db } from '@/server/db';\nexport const d: [typeof getDeps, Db | null] = [getDeps, null];\n"],
    ['src/server/domain/x.ts', "import { z } from 'zod';\nimport { DateTime } from 'luxon';\nimport type { Deps } from '@/server/ports';\nexport const v: [typeof z, typeof DateTime.fromISO, Deps | null] = [z, DateTime.fromISO, null];\n"],
    ['src/server/services/x.test.ts', "import { FakeClock } from '@/server/adapters/fake/clock';\nexport const c = FakeClock;\n"],
    ['src/server/services/x.ts', "import type { FakeAdapters } from '@/server/adapters/fake';\nimport { type FakeClock } from '@/server/adapters/fake/clock';\nexport type { FakeHubSpot } from '@/server/adapters/fake/hubspot';\nexport type X = [FakeAdapters, FakeClock];\n"],
    ['src/server/container.ts', "export const a = await import('@/server/adapters/fake');\n"],
    ['src/server/http/x.ts', "import type { FakeAdapters } from '@/server/adapters/fake';\nimport { withSetCookies } from '@/server/security/cookies';\nexport const a: [FakeAdapters | null, unknown] = [null, withSetCookies];\n"],
    ['src/proxy.ts', "import { NextResponse } from 'next/server';\nimport { buildCsp } from '@/server/security/csp';\nimport { FakeAuthProvider } from '@/server/adapters/fake/auth';\nimport { redact } from '@/shared/observability/redact';\nimport type { Deps } from '@/server/ports';\nexport const p: [unknown, unknown, unknown, unknown, Deps | null] = [NextResponse, buildCsp, FakeAuthProvider, redact, null];\n"],
  ])('allows the permitted imports in %s', async (file, code) => {
    expect((await rulesFiredAt(file, code)).filter(isBoundary)).toEqual([]);
  });

  it.each([
    ['Date.now()', 'export const t = Date.now();\n'],
    ['new Date()', 'export const t = new Date();\n'],
    ['Date()', 'export const t = Date();\n'],
    ['globalThis.Date.now()', 'export const t = globalThis.Date.now();\n'],
    ["globalThis['Date']", "export const t = new globalThis['Date']();\n"],
    ["Date['now']()", "export const t = Date['now']();\n"],
    ['new Date(...[])', 'export const t = new Date(...[]);\n'],
    ['const D = Date', 'const D = Date;\nexport const t = new D();\n'],
    ['Reflect.construct(Date, [])', 'export const t = Reflect.construct(Date, []);\n'],
    ['performance.now()', 'export const t = performance.now();\n'],
    ['performance.timeOrigin', 'export const t = performance.timeOrigin;\n'],
    ['DateTime.now()', "import { DateTime } from 'luxon';\nexport const t = DateTime.now();\n"],
    ["DateTime['now']()", "import { DateTime } from 'luxon';\nexport const t = DateTime['now']();\n"],
    ['const DT = DateTime', "import { DateTime } from 'luxon';\nconst DT = DateTime;\nexport const t = DT.now();\n"],
    ['DateTime.local()', "import { DateTime } from 'luxon';\nexport const t = DateTime.local();\n"],
    ['DateTime.local({ zone })', "import { DateTime } from 'luxon';\nexport const t = DateTime.local({ zone: 'UTC' });\n"],
    ['DateTime.utc({ locale })', "import { DateTime } from 'luxon';\nexport const t = DateTime.utc({ locale: 'en' });\n"],
    ['DateTime.utc(year)', "import { DateTime } from 'luxon';\nexport const t = DateTime.utc(2026);\n"],
    ['Settings.now()', "import { Settings } from 'luxon';\nexport const t = Settings.now();\n"],
    ['DateTime.fromObject({ hour })', "import { DateTime } from 'luxon';\nexport const t = DateTime.fromObject({ hour: 9 }, { zone: 'UTC' });\n"],
    ['dt.toRelative()', "import type { DateTime } from 'luxon';\nexport const t = (dt: DateTime) => dt.toRelative();\n"],
    ['dt.toRelativeCalendar({ unit })', "import type { DateTime } from 'luxon';\nexport const t = (dt: DateTime) => dt.toRelativeCalendar({ unit: 'days' });\n"],
    ['dt.diffNow()', "import type { DateTime } from 'luxon';\nexport const t = (dt: DateTime) => dt.diffNow();\n"],
  ])('bans the wall clock (%s) everywhere but SystemClock', async (_name, code) => {
    for (const file of ['src/server/services/x.ts', 'src/server/domain/x.ts', 'src/app/x/page.tsx', 'scripts/x.ts', 'scripts/simulation/x.mjs', 'test/x.test.ts']) {
      expect(await rulesFiredAt(file, code), file).toContain(SYNTAX);
    }
    expect(await rulesFiredAt('src/server/adapters/live/system-clock.ts', code)).not.toContain(SYNTAX);
  });

  it('exempts exactly SystemClock and the simulation\'s system-time preload from the wall-clock ban', async () => {
    const config = await readFile(path.join(root, 'eslint.config.mjs'), 'utf8');
    expect(/name: 'autopilot\/time-api-ban',\s*files: ALL_FILES,\s*ignores: \[SYSTEM_CLOCK, SIMULATED_SYSTEM_TIME\],/.test(config)).toBe(true);
    expect(config).toContain("const SIMULATED_SYSTEM_TIME = 'scripts/simulation/system-time-preload.mjs';");
    expect(await rulesFiredAt('scripts/simulation/system-time-preload.mjs', 'export const t = Date.now();\n')).not.toContain(SYNTAX);
  });

  it.each([
    ['a Date from a value', 'export const t = (ms: number): Date => new Date(ms);\n'],
    ['Date types, instanceof, Date.parse and Date.UTC', "export const a = (x: unknown): x is Date => x instanceof Date;\nexport const p = Date.parse('2026-10-06T13:00:00Z') + Date.UTC(2026, 9, 6);\nexport type T = { at: Date | null };\n"],
    ['Luxon from an explicit instant', "import { DateTime, Settings } from 'luxon';\nexport const t = (now: Date) => DateTime.fromJSDate(now, { zone: 'America/New_York' });\nexport const u = DateTime.utc(2026, 10, 6);\nexport const o = DateTime.fromObject({ year: 2026, month: 10, day: 6, hour: 9 }, { zone: 'UTC' });\nexport const r = (a: DateTime, b: DateTime) => a.toRelative({ base: b });\nexport const drive = (clock: { now(): Date }) => {\n  Settings.now = () => clock.now().getTime();\n};\n"],
  ])('allows %s', async (_name, code) => {
    expect(await rulesFiredAt('src/server/services/x.ts', code)).not.toContain(SYNTAX);
  });

  it('bans URLSearchParams and URL.searchParams in compose code only', async () => {
    for (const code of [
      "export const q = new URLSearchParams({ a: 'b c' }).toString();\n",
      "export const q = (base: string) => {\n  const url = new URL(base);\n  url.searchParams.set('body', 'b c');\n  return url.toString();\n};\n",
    ]) {
      for (const file of [
        'src/server/domain/compose.ts',
        'src/server/domain/compose/gmail.ts',
        'src/server/views/compose-link.ts',
        'src/server/actions/compose.ts',
        'src/components/compose/button.tsx',
      ]) {
        expect(await rulesFiredAt(file, code), file).toContain(SYNTAX);
      }
      expect(await rulesFiredAt('src/server/http/x.ts', code)).not.toContain(SYNTAX);
      expect(await rulesFiredAt('src/server/domain/compose.test.ts', code)).not.toContain(SYNTAX);
    }
  });

  it('keeps the wall-clock ban in compose code', async () => {
    expect(await rulesFiredAt('src/server/domain/compose.ts', 'export const t = Date.now();\n')).toContain(SYNTAX);
  });

  it('fails lint on an unused eslint-disable directive', async () => {
    const code = '// eslint-disable-next-line no-console\nexport const a = 1;\n';
    const [result] = await eslint.lintText(code, { filePath: path.join(root, 'src/server/services/x.ts') });
    expect(result?.errorCount).toBeGreaterThan(0);
  });
});

// Inline directives can switch any rule off, so the guards may not be disabled in source at all,
// and blanket disables (no rule list) are refused everywhere.
describe('ESLint directives', () => {
  const GUARDED = /no-restricted-syntax|no-restricted-imports|autopilot\//;
  const DIRECTIVE = /\/[/*]\s*eslint(?:-disable(?:-next-line|-line)?|-enable)?(?:\s|\*\/|$)[^\n]*/g;

  async function sourceFiles(): Promise<string[]> {
    const out: string[] = [];
    for (const dir of ['src', 'scripts', 'test']) {
      const entries = await readdir(path.join(root, dir), { withFileTypes: true, recursive: true });
      for (const entry of entries) {
        if (entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name)) out.push(path.relative(root, path.join(entry.parentPath, entry.name)));
      }
    }
    for (const file of ['eslint.config.mjs', 'next.config.ts', 'vitest.config.ts']) out.push(file);
    return out.sort();
  }

  /** Directives that switch a guard off, or switch everything off. */
  function offending(text: string): string[] {
    const found: string[] = [];
    for (const match of text.matchAll(DIRECTIVE)) {
      const directive = match[0];
      const rules = directive.replace(/^\/[/*]\s*eslint(?:-disable(?:-next-line|-line)?|-enable)?/, '').replace(/\*\/.*$/, '').split('--')[0]?.trim() ?? '';
      if (GUARDED.test(directive) || (/eslint-disable/.test(directive) && rules === '')) found.push(directive.trim());
    }
    return found;
  }

  it('recognises a guard being switched off', () => {
    expect(offending('// eslint-disable-next-line no-restricted-syntax\n')).toHaveLength(1);
    expect(offending('/* eslint-disable @typescript-eslint/no-restricted-imports */\n')).toHaveLength(1);
    expect(offending('/* eslint no-restricted-syntax: off */\n')).toHaveLength(1);
    expect(offending('// eslint-disable-line autopilot/import-boundaries\n')).toHaveLength(1);
    expect(offending('/* eslint-disable */\n')).toHaveLength(1);
    expect(offending('// eslint-disable-next-line\n')).toHaveLength(1);
    expect(offending('// eslint-disable-next-line react-hooks/exhaustive-deps -- reason\n')).toEqual([]);
  });

  it('never appear in src, scripts or test', async () => {
    const found: string[] = [];
    for (const file of await sourceFiles()) {
      if (file === 'test/layout/boundaries.test.ts') continue;
      for (const directive of offending(await readFile(path.join(root, file), 'utf8'))) found.push(`${file}: ${directive}`);
    }
    expect(found).toEqual([]);
  });
});
