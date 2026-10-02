import 'server-only';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Settings } from 'luxon';
import { SystemClock } from '@/server/adapters/live/system-clock';
import { ConfigError } from '@/server/domain/errors';
import { getEnv, type AppMode, type Env } from '@/server/env';
import type { FakeAdapters } from '@/server/adapters/fake';
import type { DevClock } from '@/server/adapters/fake/dev-clock';
import type { Db } from '@/server/db';
import type { AuthProvider, Billing, Clock, Deps, HubSpotClient, LLM, Mailer, Scheduler, WebFetcher } from '@/server/ports';

// The Deps factory and its lazy process-wide singleton (PLAN §3, §4, D-29). Nothing opens at import
// time: the first getDeps() parses the environment, picks the adapters for APP_MODE and, in fake
// mode, opens and migrates PGlite under FAKE_DB_DIR. The singleton lives on globalThis so Next's dev
// module reloads reuse one PGlite instance instead of opening the data directory twice. Drivers and
// fakes are imported dynamically, so a live build never loads PGlite or the fixtures.
//
// Every container points Luxon's Settings.now at its Clock, so Luxon calls that fill in "now"
// (a time-only fromISO, fromFormat('09:00', 'HH:mm')) follow the injected Clock too (D-28).

export interface Container {
  readonly mode: AppMode;
  readonly deps: Deps;
  /** Fake mode only: the fakes behind `deps`, for the /dev pages and the dev job ticker. */
  readonly fakes: FakeAdapters | null;
  /** Fake mode only: `deps.clock`, advanceable, its offset persisted in fake.state (PLAN §4). */
  readonly devClock: DevClock | null;
  /** Closes the database and hands Luxon back its previous clock. */
  close(): Promise<void>;
}

export interface BuildOptions {
  /** The clock under fake mode's offset clock, and live mode's clock. Default SystemClock (tests inject one). */
  baseClock?: Clock | undefined;
}

/** Points Luxon's notion of "now" at `clock`; returns the undo. */
function driveLuxon(clock: Clock): () => void {
  const previous = Settings.now;
  const fromClock = (): number => clock.now().getTime();
  Settings.now = fromClock;
  return () => {
    if (Settings.now === fromClock) Settings.now = previous;
  };
}

type ContainerGlobal = typeof globalThis & { __autopilot?: Promise<Container> | undefined };

const store = globalThis as ContainerGlobal;

/** The process-wide container, built on first use. A failed build is not cached. */
export function getContainer(): Promise<Container> {
  const existing = store.__autopilot;
  if (existing !== undefined) return existing;
  const building: Promise<Container> = (async () => buildContainer(getEnv()))().catch((error: unknown) => {
    if (store.__autopilot === building) store.__autopilot = undefined;
    throw error;
  });
  store.__autopilot = building;
  return building;
}

export async function getDeps(): Promise<Deps> {
  return (await getContainer()).deps;
}

/** Closes and forgets the singleton (tests, and the simulation's clean exit). */
export async function resetContainer(): Promise<void> {
  const existing = store.__autopilot;
  store.__autopilot = undefined;
  if (existing === undefined) return;
  const container = await existing.catch(() => undefined);
  await container?.close();
}

export async function buildContainer(env: Env, options: BuildOptions = {}): Promise<Container> {
  const baseClock = options.baseClock ?? new SystemClock();
  return env.APP_MODE === 'fake' ? buildFakeContainer(env, baseClock) : buildLiveContainer(env, baseClock);
}

// ---------------------------------------------------------------------------------------------
// Fake mode
// ---------------------------------------------------------------------------------------------

/** FAKE_DB_DIR as PGlite takes it: `memory://` stays in memory, a path is resolved and created. */
async function pgliteDataDir(fakeDbDir: string): Promise<string> {
  if (/^[a-z]+:\/\//.test(fakeDbDir)) return fakeDbDir;
  const dir = path.resolve(/*turbopackIgnore: true*/ fakeDbDir);
  await mkdir(/*turbopackIgnore: true*/ dir, { recursive: true });
  return dir;
}

async function buildFakeContainer(env: Env, baseClock: Clock): Promise<Container> {
  const [{ createPgliteDb }, { migrate }, { createFakeDeps }, { DevClock }] = await Promise.all([
    import('@/server/db/pglite'),
    import('@/server/db/migrate'),
    import('@/server/adapters/fake'),
    import('@/server/adapters/fake/dev-clock'),
  ]);
  const db = createPgliteDb({ dataDir: await pgliteDataDir(env.FAKE_DB_DIR) });
  let clock: DevClock;
  try {
    await migrate(db);
    clock = await DevClock.load(db, baseClock);
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
  // The fake portal and billing state still live in memory; persisting their snapshots in
  // fake.state arrives with the OAuth token storage in M2 (PLAN §15 M2).
  const { deps, fakes } = createFakeDeps({ env, db, clock });
  const restoreLuxon = driveLuxon(clock);
  return {
    mode: 'fake',
    deps,
    fakes,
    devClock: clock,
    close: async () => {
      restoreLuxon();
      await db.close();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Live mode
// ---------------------------------------------------------------------------------------------

/**
 * A port whose live adapter arrives in a later milestone (PLAN §15): every method call throws
 * ConfigError('live_adapter_not_built'), so live mode fails loudly rather than half-working.
 */
function liveAdapterNotBuilt<T extends object>(): T {
  return new Proxy({} as T, {
    get(_target, property) {
      // Not a thenable, and quiet under inspection or serialisation.
      if (typeof property === 'symbol' || property === 'then' || property === 'toJSON') return undefined;
      return () => {
        throw new ConfigError('live_adapter_not_built');
      };
    },
  });
}

export interface LiveDepsOptions {
  env: Env;
  db: Db;
  clock?: Clock | undefined;
}

/** Live Deps: SystemClock and Postgres.js; the HubSpot, LLM, mail, jobs, billing, fetch and auth adapters come in M2+. */
export function createLiveDeps(options: LiveDepsOptions): Deps {
  return {
    env: options.env,
    db: options.db,
    clock: options.clock ?? new SystemClock(),
    hubspot: liveAdapterNotBuilt<HubSpotClient>(),
    llm: liveAdapterNotBuilt<LLM>(),
    mailer: liveAdapterNotBuilt<Mailer>(),
    scheduler: liveAdapterNotBuilt<Scheduler>(),
    billing: liveAdapterNotBuilt<Billing>(),
    webFetcher: liveAdapterNotBuilt<WebFetcher>(),
    auth: liveAdapterNotBuilt<AuthProvider>(),
  };
}

async function buildLiveContainer(env: Env, clock: Clock): Promise<Container> {
  const { createPostgresDb } = await import('@/server/db/postgres');
  const db = createPostgresDb(env.DATABASE_URL);
  const restoreLuxon = driveLuxon(clock);
  return {
    mode: 'live',
    deps: createLiveDeps({ env, db, clock }),
    fakes: null,
    devClock: null,
    close: async () => {
      restoreLuxon();
      await db.close();
    },
  };
}
