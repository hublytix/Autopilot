import 'server-only';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Settings } from 'luxon';
import { SystemClock } from '@/server/adapters/live/system-clock';
import { ConfigError } from '@/server/domain/errors';
import { getEnv, type AppMode, type Env } from '@/server/env';
import type { FakeAdapters, FakeDeps, PersistedFakeName } from '@/server/adapters/fake';
import type { DevClock } from '@/server/adapters/fake/dev-clock';
import type { Db } from '@/server/db';
import type { AuthProvider, Billing, Clock, Deps, HubSpotClient, LLM, Mailer, Scheduler, WebFetcher } from '@/server/ports';
import type { FakeStatePersistence } from '@/server/services/fake-state';

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

/**
 * The process-wide container, built on first use. A failed build is not cached. Never during
 * `next build` (D-29): pages read the request (`await headers()`) before getDeps(), so the prerender
 * attempt stops there; anything that still got here would open and migrate fake mode's PGlite
 * directory (the one a running `npm start` uses) or build the live clients at build time, so it is
 * refused loudly instead.
 */
export function getContainer(): Promise<Container> {
  if (process.env.NEXT_PHASE === 'phase-production-build') return Promise.reject(new ConfigError('container_at_build'));
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
  const [{ createPgliteDb }, { migrate }, { createFakeDeps }, { DevClock }, { startFakeStatePersistence }, { createSchedulerBridge }] =
    await Promise.all([
      import('@/server/db/pglite'),
      import('@/server/db/migrate'),
      import('@/server/adapters/fake'),
      import('@/server/adapters/fake/dev-clock'),
      import('@/server/services/fake-state'),
      import('@/server/jobs/bridge'),
    ]);
  const db = createPgliteDb({ dataDir: await pgliteDataDir(env.FAKE_DB_DIR) });
  // The fake portal (whose OAuth tokens hubspot_connections stores) and the fake subscriptions are
  // restored from fake.state and saved back after every change (D-29, D-53).
  let persistence: FakeStatePersistence<PersistedFakeName> | undefined;
  let clock: DevClock;
  let built: FakeDeps;
  // The FakeScheduler delivers due jobs through the same dispatcher /api/jobs/run and
  // /api/jobs/failed use (PLAN §4, §8.3). The bridge reads the Deps at delivery time.
  const box: { deps?: Deps | undefined } = {};
  const bridge = createSchedulerBridge(() => {
    if (box.deps === undefined) throw new ConfigError('container_not_ready');
    return box.deps;
  });
  try {
    await migrate(db);
    clock = await DevClock.load(db, baseClock);
    built = createFakeDeps({
      env,
      db,
      clock,
      dispatch: (delivery) => bridge.dispatch(delivery),
      onJobFailure: (failure) => bridge.onFailure(failure),
      onStateChange: (name) => persistence?.markChanged(name),
    });
    box.deps = built.deps;
    persistence = await startFakeStatePersistence<PersistedFakeName>({
      db,
      sources: { hubspot: built.fakes.hubspot, billing: built.fakes.billing, auth: built.fakes.auth },
    });
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
  const saved = persistence;
  const restoreLuxon = driveLuxon(clock);
  // The dev job ticker (PLAN §4): due fake jobs every 10 s and the poll cron once per 5 minutes of
  // DevClock time. It starts only in fake mode outside Vitest and `next build` (null otherwise).
  const [{ startDevTickerIfEnabled, stopDevTicker }, { runSweeper }, { runRetentionGuard }] = await Promise.all([
    import('@/server/services/dev-ticker'),
    import('@/server/jobs/sweeper'),
    import('@/server/http/cron-poll'),
  ]);
  const ticker = startDevTickerIfEnabled({
    env,
    deps: built.deps,
    scheduler: built.fakes.scheduler,
    sweep: (d) => runSweeper(d),
    retentionGuard: runRetentionGuard,
  });
  return {
    mode: 'fake',
    deps: built.deps,
    fakes: built.fakes,
    devClock: clock,
    close: async () => {
      await stopDevTicker(ticker);
      await saved.close();
      restoreLuxon();
      await db.close();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Live mode
// ---------------------------------------------------------------------------------------------

/**
 * Every live port is built by buildLiveAdapters; this Proxy only backs a port a caller (tests) leaves
 * out of createLiveDeps, and fails loudly: every method call throws ConfigError('live_adapter_not_built').
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

/**
 * The live adapters, one per port: HubSpot, the LLM (Anthropic), the mailer (Resend), the scheduler
 * (QStash), the AuthProvider (Supabase), the WebFetcher (undici behind the SSRF guard) and billing
 * (Razorpay). buildLiveAdapters supplies all seven.
 */
export interface LiveAdapters {
  hubspot: HubSpotClient;
  llm: LLM;
  mailer: Mailer;
  scheduler: Scheduler;
  auth: AuthProvider;
  webFetcher: WebFetcher;
  billing: Billing;
}

/**
 * Builds the live adapters from the environment. The SDK modules (Anthropic, Resend, QStash) are
 * imported here, on first use, so fake mode never loads them. Constructing them sends nothing.
 */
export async function buildLiveAdapters(env: Env, clock: Clock): Promise<LiveAdapters> {
  const [
    { HubSpotHttpClient },
    { AnthropicLLM },
    { modelParamsConfig },
    { ResendMailer },
    { QstashScheduler },
    { createSupabaseAuthProvider },
    { HttpWebFetcher },
    { RazorpayBilling },
  ] = await Promise.all([
    import('@/server/adapters/live/hubspot'),
    import('@/server/adapters/live/anthropic-llm'),
    import('@/server/ai/model-params'),
    import('@/server/adapters/live/resend-mailer'),
    import('@/server/adapters/live/qstash-scheduler'),
    import('@/server/adapters/live/supabase-auth'),
    import('@/server/adapters/live/http-web-fetcher'),
    import('@/server/adapters/live/razorpay-billing'),
  ]);
  return {
    hubspot: new HubSpotHttpClient({
      clientId: env.HUBSPOT_CLIENT_ID,
      clientSecret: env.HUBSPOT_CLIENT_SECRET,
      apiVersion: env.HUBSPOT_API_VERSION,
    }),
    llm: new AnthropicLLM({
      apiKey: env.ANTHROPIC_API_KEY,
      models: { draft: env.ANTHROPIC_MODEL_DRAFT, fast: env.ANTHROPIC_MODEL_FAST },
      params: modelParamsConfig(env),
      clock,
    }),
    mailer: new ResendMailer({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM }),
    scheduler: new QstashScheduler({ token: env.QSTASH_TOKEN, baseUrl: env.QSTASH_URL, appUrl: env.APP_URL, clock }),
    auth: createSupabaseAuthProvider({
      supabaseUrl: env.SUPABASE_URL,
      publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
      secretKey: env.SUPABASE_SECRET_KEY,
      appUrl: env.APP_URL,
      clock,
    }),
    webFetcher: new HttpWebFetcher({ appUrl: env.APP_URL, clock }),
    billing: new RazorpayBilling({ keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET }),
  };
}

export interface LiveDepsOptions {
  env: Env;
  db: Db;
  clock?: Clock | undefined;
  /** From buildLiveAdapters; a port left out throws ConfigError('live_adapter_not_built') when used. */
  adapters?: Partial<LiveAdapters> | undefined;
}

/** Live Deps: SystemClock, Postgres.js and the live adapters given. */
export function createLiveDeps(options: LiveDepsOptions): Deps {
  const adapters = options.adapters ?? {};
  return {
    env: options.env,
    db: options.db,
    clock: options.clock ?? new SystemClock(),
    hubspot: adapters.hubspot ?? liveAdapterNotBuilt<HubSpotClient>(),
    llm: adapters.llm ?? liveAdapterNotBuilt<LLM>(),
    mailer: adapters.mailer ?? liveAdapterNotBuilt<Mailer>(),
    scheduler: adapters.scheduler ?? liveAdapterNotBuilt<Scheduler>(),
    billing: adapters.billing ?? liveAdapterNotBuilt<Billing>(),
    webFetcher: adapters.webFetcher ?? liveAdapterNotBuilt<WebFetcher>(),
    auth: adapters.auth ?? liveAdapterNotBuilt<AuthProvider>(),
  };
}

async function buildLiveContainer(env: Env, clock: Clock): Promise<Container> {
  const { createPostgresDb } = await import('@/server/db/postgres');
  const adapters = await buildLiveAdapters(env, clock);
  const db = createPostgresDb(env.DATABASE_URL);
  const restoreLuxon = driveLuxon(clock);
  return {
    mode: 'live',
    deps: createLiveDeps({ env, db, clock, adapters }),
    fakes: null,
    devClock: null,
    close: async () => {
      restoreLuxon();
      await db.close();
    },
  };
}
