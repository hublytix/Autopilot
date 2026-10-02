// ESLint 9 flat config: Next.js core-web-vitals + typescript-eslint, plus the PLAN §3 module
// boundaries, the D-28 wall-clock ban and the D-13 compose-encoding ban.
import path from 'node:path';
import { defineConfig, globalIgnores } from 'eslint/config';
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import tseslint from 'typescript-eslint';

const ROOT = import.meta.dirname;
const ALL_FILES = ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'];
// Tests wire fakes into services and read fixtures, so the import boundaries do not apply to them.
const TEST_FILES = ['**/*.test.ts', '**/*.test.tsx'];
const SYSTEM_CLOCK = 'src/server/adapters/live/system-clock.ts';
// Compose-link builders wherever they live (domain, views, actions, services).
const COMPOSE_FILES = ['src/**/compose*.{ts,tsx}', 'src/**/compose/**/*.{ts,tsx}', 'src/**/compose-*/**/*.{ts,tsx}'];

// ---------------------------------------------------------------------------------------------
// Wall-clock ban (D-28): every timestamp comes from the injected Clock. Only SystemClock reads it.
// Assigning Luxon's Settings.now (the container drives it from the Clock) is deliberately allowed.
// Lint catches the syntactic forms; the containers and the Vitest setup also point Luxon's
// Settings.now at a Clock, so an implicit Luxon "now" (fromFormat('09:00', 'HH:mm'), a time-only
// fromISO) never reads the wall clock either.
// ---------------------------------------------------------------------------------------------
const CLOCK_MESSAGE = 'Read time from the injected Clock (deps.clock.now()); only SystemClock may read the wall clock (D-28).';
const LUXON_MESSAGE =
  'This Luxon call fills in the current time. Build instants from the injected Clock: DateTime.fromJSDate(deps.clock.now(), {zone}), DateTime.fromObject({year, month, day, …}, {zone}), or pass {base} (D-28).';
// Places where the identifier `Date` is not a value that can escape (types, `new Date(x)`, `instanceof Date`,
// `Date.UTC`/`Date.parse`, property keys). Everywhere else it is banned, which also stops
// `const D = Date`, `Reflect.construct(Date, [])`, `Date['now']()`, `globalThis.Date` and `Date()`.
const DATE_SAFE_PARENTS = [
  'NewExpression > Identifier.callee',
  "MemberExpression[computed=false][property.name=/^(?:UTC|parse)$/] > Identifier.object",
  "BinaryExpression[operator='instanceof'] > Identifier.right",
  // Type checks: z.instanceof(Date), expect(x).toBeInstanceOf(Date), expect.any(Date).
  "CallExpression[callee.property.name=/^(?:instanceof|toBeInstanceOf|any)$/] > Identifier.arguments",
  'TSTypeReference > Identifier.typeName',
  'TSTypeQuery > Identifier.exprName',
  'TSQualifiedName > Identifier.right',
  'Property[computed=false][shorthand=false] > Identifier.key',
  'PropertyDefinition[computed=false] > Identifier.key',
  'MethodDefinition[computed=false] > Identifier.key',
  'TSPropertySignature[computed=false] > Identifier.key',
  'TSMethodSignature[computed=false] > Identifier.key',
].join(', ');
// The same for Luxon's DateTime and Settings: member access by name (checked below) and types only.
const LUXON_SAFE_PARENTS = [
  'MemberExpression[computed=false] > Identifier.object',
  'ImportSpecifier > Identifier',
  'ExportSpecifier > Identifier',
  'TSTypeReference > Identifier.typeName',
  'TSTypeQuery > Identifier.exprName',
  'TSQualifiedName > Identifier',
  "BinaryExpression[operator='instanceof'] > Identifier.right",
  "CallExpression[callee.property.name=/^(?:instanceof|toBeInstanceOf|any)$/] > Identifier.arguments",
  'Property[computed=false][shorthand=false] > Identifier.key',
  'PropertyDefinition[computed=false] > Identifier.key',
  'MethodDefinition[computed=false] > Identifier.key',
  'TSPropertySignature[computed=false] > Identifier.key',
  'TSMethodSignature[computed=false] > Identifier.key',
].join(', ');
const TIME_BANS = [
  // Date
  { selector: `Identifier[name='Date']:not(${DATE_SAFE_PARENTS})`, message: CLOCK_MESSAGE },
  { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: CLOCK_MESSAGE },
  { selector: "NewExpression[callee.name='Date'] > SpreadElement.arguments", message: CLOCK_MESSAGE },
  { selector: "MemberExpression[computed=true][property.value='Date']", message: CLOCK_MESSAGE },
  { selector: "MemberExpression[object.name='performance'][property.name=/^(?:now|timeOrigin)$/]", message: CLOCK_MESSAGE },
  // Luxon
  { selector: `Identifier[name=/^(?:DateTime|Settings)$/]:not(${LUXON_SAFE_PARENTS})`, message: LUXON_MESSAGE },
  { selector: "MemberExpression[object.name=/^(?:DateTime|Settings)$/][computed=true]", message: LUXON_MESSAGE },
  { selector: "MemberExpression[object.name='DateTime'][property.name='now']", message: CLOCK_MESSAGE },
  { selector: "CallExpression[callee.object.name='Settings'][callee.property.name='now']", message: CLOCK_MESSAGE },
  // DateTime.local()/utc() with no arguments, only a year, or only options ({zone}) all return "now".
  {
    selector: "CallExpression[callee.object.name='DateTime'][callee.property.name=/^(?:local|utc)$/][arguments.length<2]",
    message: LUXON_MESSAGE,
  },
  {
    selector: "CallExpression[callee.object.name='DateTime'][callee.property.name=/^(?:local|utc)$/][arguments.0.type='ObjectExpression']",
    message: LUXON_MESSAGE,
  },
  // fromObject fills every unit above the largest one given from "now": it must carry the year.
  {
    selector:
      "CallExpression[callee.object.name='DateTime'][callee.property.name='fromObject'] > ObjectExpression.arguments:first-child:not(:has(> Property[key.name='year']))",
    message: LUXON_MESSAGE,
  },
  // Relative formatting and diffNow measure from "now" unless a base is given.
  { selector: "CallExpression[callee.property.name=/^toRelative(?:Calendar)?$/][arguments.length=0]", message: LUXON_MESSAGE },
  {
    selector:
      "CallExpression[callee.property.name=/^toRelative(?:Calendar)?$/] > ObjectExpression.arguments:first-child:not(:has(> Property[key.name='base']))",
    message: LUXON_MESSAGE,
  },
  { selector: "CallExpression[callee.property.name='diffNow']", message: LUXON_MESSAGE },
];
const COMPOSE_BANS = [
  {
    selector: "Identifier[name='URLSearchParams']",
    message: 'URLSearchParams encodes spaces as "+". Use the shared pct()/pctAddr() encoder (D-13, CMP-ENCODING-PLUS-SPACE).',
  },
  {
    selector: "MemberExpression[property.name='searchParams']",
    message: 'URL.searchParams encodes spaces as "+". Use the shared pct()/pctAddr() encoder (D-13, CMP-ENCODING-PLUS-SPACE).',
  },
];

// ---------------------------------------------------------------------------------------------
// Module boundaries (PLAN §3). Type-only imports are always allowed (allowTypeImports).
//
// Two layers. `autopilot/import-boundaries` resolves every specifier to a repo path first (`@/`,
// `./../x`, `@/a/../b` all normalise to the same target) and also checks `import()`, `require()`
// and re-exports; it refuses non-canonical relative specifiers outright. The regex rules below
// match the raw specifier text, as a second layer.
// ---------------------------------------------------------------------------------------------
const DOMAIN_MSG = 'domain/ is pure: it may import only domain/, zod and luxon (PLAN §3).';
const PORTS_MSG = 'ports/ contains types only: use `import type` (PLAN §3).';
const ADAPTERS_MSG = 'adapters/ implement ports and never import services/ (PLAN §3).';
const SERVICES_MSG = 'services/ take a Deps object and never import adapters/ (PLAN §3).';
const APP_MSG = 'src/app may import @/server/http, views, actions and container only; use `import type` for anything else (PLAN §3).';
const CLIENT_MSG = 'components/ and shared/ are client-safe and must not import src/server (PLAN §3).';
const PROXY_MSG = 'src/proxy.ts may import only the CSP builder and the AuthProvider session-refresh adapter; the proxy never touches the database (PLAN §3, §7.7).';

const EXTENSION = /\.(?:[cm]?[jt]sx?|json)$/;
/** True when the repo path `target` is the module `dir` or lies inside it. */
const within = (target, dir) => target === dir || target.startsWith(`${dir}/`);
const withinAny = (target, dirs) => dirs.some((dir) => within(target, dir));

/** Each zone: the files it guards, and a check returning a message for a forbidden target. */
const ZONES = [
  {
    files: ['src/server/domain'],
    check: (t) =>
      t.bare !== undefined
        ? /^(?:zod|luxon|server-only)(?:\/|$)/.test(t.bare) ? null : DOMAIN_MSG
        : within(t.path, 'src/server/domain') ? null : DOMAIN_MSG,
  },
  {
    files: ['src/server/ports'],
    check: (t) =>
      t.bare !== undefined
        ? t.bare === 'server-only' ? null : PORTS_MSG
        : withinAny(t.path, ['src/server/ports', 'src/server/domain']) ? null : PORTS_MSG,
  },
  { files: ['src/server/adapters'], check: (t) => (t.path !== undefined && within(t.path, 'src/server/services') ? ADAPTERS_MSG : null) },
  { files: ['src/server/services'], check: (t) => (t.path !== undefined && within(t.path, 'src/server/adapters') ? SERVICES_MSG : null) },
  {
    files: ['src/app'],
    check: (t) =>
      t.path !== undefined &&
      within(t.path, 'src/server') &&
      !withinAny(t.path, ['src/server/http', 'src/server/views', 'src/server/actions', 'src/server/container'])
        ? APP_MSG
        : null,
  },
  { files: ['src/components', 'src/shared'], check: (t) => (t.path !== undefined && within(t.path, 'src/server') ? CLIENT_MSG : null) },
  {
    files: ['src/proxy', 'src/proxy.ts'],
    check: (t) =>
      t.bare !== undefined
        ? t.bare === 'next/server' ? null : PROXY_MSG
        : withinAny(t.path, [
              'src/proxy',
              'src/shared',
              'src/server/security/csp',
              'src/server/adapters/live/auth',
              'src/server/adapters/fake/auth',
            ])
          ? null
          : PROXY_MSG,
  },
];

/** `x/../y`, `./..`, `//` and `/./` resolve somewhere other than they read; leading `../` runs are fine. */
const NON_CANONICAL = /(?:^|\/)(?!\.\.(?:\/|$))[^/]+\/\.\.(?:\/|$)|^\.\/\.\.|\/\/|\/\.\/|\/\.$/;

const importBoundaries = {
  meta: {
    type: 'problem',
    docs: { description: 'PLAN §3 module boundaries on resolved import targets (static, dynamic, require, re-export).' },
    schema: [],
  },
  create(context) {
    const file = path.relative(ROOT, context.filename).split(path.sep).join('/');
    const fileModule = file.replace(EXTENSION, '');
    const zones = ZONES.filter((zone) => zone.files.some((dir) => within(fileModule, dir) || within(file, dir)));

    const targetOf = (specifier) => {
      if (specifier.startsWith('@/')) return { path: path.posix.normalize(`src/${specifier.slice(2)}`).replace(EXTENSION, '') };
      if (specifier.startsWith('.')) {
        return { path: path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)).replace(EXTENSION, '') };
      }
      if (specifier.startsWith('/')) return { path: path.posix.relative(ROOT.split(path.sep).join('/'), specifier).replace(EXTENSION, '') };
      return { bare: specifier };
    };

    const check = (node, specifier) => {
      if ((specifier.startsWith('.') || specifier.startsWith('@/')) && NON_CANONICAL.test(specifier)) {
        context.report({ node, message: `Write the import path in canonical form, without inner '..' or '.' segments: '${specifier}' (PLAN §3).` });
        return;
      }
      const target = targetOf(specifier);
      for (const zone of zones) {
        const message = zone.check(target);
        if (message !== null) {
          context.report({ node, message });
          return;
        }
      }
    };

    const literalOf = (node) => {
      if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
      if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? null;
      return null;
    };
    const checkDynamic = (node, source) => {
      const specifier = literalOf(source);
      if (specifier === null) {
        if (zones.length > 0) context.report({ node, message: 'A guarded module may load only literal specifiers, so the boundary rules can check them (PLAN §3).' });
        return;
      }
      check(node, specifier);
    };
    const allTypeSpecifiers = (specifiers) =>
      specifiers.length > 0 && specifiers.every((s) => s.importKind === 'type' || s.exportKind === 'type');

    return {
      ImportDeclaration(node) {
        if (node.importKind === 'type' || allTypeSpecifiers(node.specifiers)) return;
        check(node.source, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source === null || node.source === undefined || node.exportKind === 'type' || allTypeSpecifiers(node.specifiers)) return;
        check(node.source, node.source.value);
      },
      ExportAllDeclaration(node) {
        if (node.exportKind === 'type') return;
        check(node.source, node.source.value);
      },
      ImportExpression(node) {
        checkDynamic(node, node.source);
      },
      TSImportEqualsDeclaration(node) {
        if (node.importKind === 'type' || node.moduleReference.type !== 'TSExternalModuleReference') return;
        checkDynamic(node, node.moduleReference.expression);
      },
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'require' || node.arguments.length === 0) return;
        const [first] = node.arguments;
        if (first !== undefined) checkDynamic(node, first);
      },
    };
  },
};

const autopilotPlugin = { meta: { name: 'autopilot' }, rules: { 'import-boundaries': importBoundaries } };

const OUTSIDE_SERVER = 'app|components|emails|shared|server|test|scripts';
const restrict = (regex, message) => ({ regex, message, allowTypeImports: true });
const boundary = (name, files, patterns) => ({
  name: `autopilot/boundaries/${name}`,
  files,
  ignores: TEST_FILES,
  rules: { '@typescript-eslint/no-restricted-imports': ['error', { patterns }] },
});

const BOUNDARIES = [
  boundary('domain', ['src/server/domain/**'], [
    restrict('^(?!\\.{0,2}/)(?!@/)(?!(?:zod|luxon|server-only)(?:/|$)).', DOMAIN_MSG),
    restrict('^@/(?!server/domain(?:/|$))', DOMAIN_MSG),
    restrict(
      `^(?:\\.\\./)+(?:${OUTSIDE_SERVER}|adapters|services|ports|db|security|jobs|http|views|actions|obs|env|container)(?:[/.]|$)`,
      DOMAIN_MSG,
    ),
  ]),
  boundary('ports', ['src/server/ports/**'], [
    restrict('^(?!\\.{0,2}/)(?!@/)(?!server-only$).', PORTS_MSG),
    restrict('^@/(?!server/(?:ports|domain)(?:/|$))', PORTS_MSG),
    restrict(
      `^(?:\\.\\./)+(?:${OUTSIDE_SERVER}|adapters|services|db|security|jobs|http|views|actions|obs|env|container)(?:[/.]|$)`,
      PORTS_MSG,
    ),
  ]),
  boundary('adapters', ['src/server/adapters/**'], [
    restrict('^@/server/services(?:/|$)', ADAPTERS_MSG),
    restrict('^(?:\\.\\./)+services(?:/|$)', ADAPTERS_MSG),
  ]),
  boundary('services', ['src/server/services/**'], [
    restrict('^@/server/adapters(?:/|$)', SERVICES_MSG),
    restrict('^(?:\\.\\./)+adapters(?:/|$)', SERVICES_MSG),
  ]),
  boundary('app', ['src/app/**'], [
    restrict('^@/server(?:/(?!(?:http|views|actions|container)(?:[/.]|$))|$)', APP_MSG),
    restrict('^(?:\\.\\./)+server(?:/(?!(?:http|views|actions|container)(?:[/.]|$))|$)', APP_MSG),
  ]),
  boundary('client-safe', ['src/components/**', 'src/shared/**'], [
    restrict('^@/server(?:/|$)', CLIENT_MSG),
    restrict('^(?:\\.\\./)+server(?:/|$)', CLIENT_MSG),
  ]),
  boundary('proxy', ['src/proxy.ts', 'src/proxy/**'], [
    restrict('^(?!\\.{0,2}/)(?!@/)(?!next/server$).', PROXY_MSG),
    restrict('^@/(?!server/security/csp(?:[/.]|$)|server/adapters/(?:live|fake)/auth(?:[/.]|$)|shared/|proxy/)', PROXY_MSG),
    restrict('^(?:\\.\\./)*(?:\\./)?server/(?!security/csp(?:[/.]|$)|adapters/(?:live|fake)/auth(?:[/.]|$))', PROXY_MSG),
  ]),
];

export default defineConfig([
  ...nextCoreWebVitals,
  ...tseslint.configs.recommended,
  {
    name: 'autopilot/linter-options',
    // A stale `eslint-disable` fails lint; test/layout/boundaries.test.ts forbids disabling the guards at all.
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  {
    name: 'autopilot/typescript',
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    name: 'autopilot/time-api-ban',
    files: ALL_FILES,
    ignores: [SYSTEM_CLOCK],
    rules: { 'no-restricted-syntax': ['error', ...TIME_BANS] },
  },
  {
    // Overrides the rule above for compose files, so it repeats the time bans. Compose tests may
    // decode URLs with searchParams; only the builders are bound by D-13.
    name: 'autopilot/compose-encoding-ban',
    files: COMPOSE_FILES,
    ignores: TEST_FILES,
    rules: { 'no-restricted-syntax': ['error', ...TIME_BANS, ...COMPOSE_BANS] },
  },
  {
    name: 'autopilot/import-boundaries',
    files: ['src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    ignores: TEST_FILES,
    plugins: { autopilot: autopilotPlugin },
    rules: { 'autopilot/import-boundaries': 'error' },
  },
  ...BOUNDARIES,
  globalIgnores(['.next/**', 'node_modules/**', 'out/**', 'build/**', 'outbox/**', 'coverage/**', '.data/**', 'next-env.d.ts']),
]);
