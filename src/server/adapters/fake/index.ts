import 'server-only';
import { modelParamsConfig } from '@/server/ai/model-params';
import { ConfigError } from '@/server/domain/errors';
import type { Db } from '@/server/db';
import type { Env } from '@/server/env';
import { classifyRefreshFailure } from '@/server/hubspot/refresh-classifier';
import type { Clock, Deps } from '@/server/ports';
import { deriveKey } from '@/server/security/keys';
import { FakeAuthProvider } from './auth';
import { FAKE_RAZORPAY_PLAN, FakeBilling } from './billing';
import { FakeHubSpot } from './hubspot';
import { FakeLLM } from './llm';
import { devOutboxSink, FakeMailer, type FakeMailSink } from './mailer';
import { FakeScheduler, type FakeDispatch, type FakeOnFailure } from './scheduler';
import { FakeWebFetcher } from './web-fetcher';

// Fake-mode wiring (PLAN §4, D-29): every port's fake, configured from the environment so the fakes
// and the code that verifies them agree (OAuth client, webhook secrets, plan id, models). Used by
// the container (dev), the simulation and tests.

/** The fakes behind a fake-mode Deps, with their test and dev helpers. */
export interface FakeAdapters {
  readonly clock: Clock;
  readonly hubspot: FakeHubSpot;
  readonly llm: FakeLLM;
  readonly mailer: FakeMailer;
  readonly scheduler: FakeScheduler;
  readonly billing: FakeBilling;
  readonly webFetcher: FakeWebFetcher;
  readonly auth: FakeAuthProvider;
}

/** The fakes whose state fake mode keeps in `fake.state` across restarts (PLAN §4, D-29): portal, subscriptions, auth users and sessions. */
export const PERSISTED_FAKES = ['hubspot', 'billing', 'auth'] as const;
export type PersistedFakeName = (typeof PERSISTED_FAKES)[number];

export interface FakeDepsOptions {
  env: Env;
  db: Db;
  /** The DevClock (wall clock + persisted offset) in dev; a FakeClock in the simulation and tests. */
  clock: Clock;
  /** Default: fake.dev_outbox through `db` (dev). Tests pass `{kind: 'memory'}`, the simulation a directory. */
  mailSink?: FakeMailSink | undefined;
  /**
   * The job handler the fake scheduler delivers to (`/api/jobs/run`): the container, the simulation
   * and the job test rig pass the scheduler bridge (src/server/jobs/bridge.ts). Without it every
   * delivery fails with ConfigError('job_dispatcher_not_built').
   */
  dispatch?: FakeDispatch | undefined;
  /** The QStash failure callback (`/api/jobs/failed`). */
  onJobFailure?: FakeOnFailure | undefined;
  /** A portal in the fixture format. Default: test/fixtures/hubspot-portal.json. */
  portal?: unknown;
  /** Receives the simulated duration of a slow brief, e.g. `(ms) => fakeClock.advance(ms)`. */
  elapse?: ((ms: number) => void) | undefined;
  /** Default: `<cwd>/test/fixtures/site`. */
  siteDir?: string | undefined;
  /**
   * Fake mode (the container): called after every method call on a persisted fake (PERSISTED_FAKES),
   * when its state may have changed, so the snapshot can be saved. Tests and the simulation omit it.
   */
  onStateChange?: ((name: PersistedFakeName) => void) | undefined;
}

export interface FakeDeps {
  deps: Deps;
  fakes: FakeAdapters;
}

const dispatcherNotBuilt: FakeDispatch = () => {
  throw new ConfigError('job_dispatcher_not_built');
};

/** Methods that read or replace the whole state: calling them is never a change to save. */
const NOT_A_CHANGE: ReadonlySet<PropertyKey> = new Set<PropertyKey>(['snapshot', 'restore']);

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

/**
 * `fake` behind a Proxy that calls `changed` after each method call (synchronous, and again when an
 * async method settles), whether it succeeded or threw: a failure can change state too (a consumed
 * injected fault). Methods run on the fake itself, so its private fields keep working, and
 * `instanceof` still holds. Getters pass through; the snapshot methods run without notifying.
 */
function notifyingProxy<T extends object>(fake: T, changed: () => void): T {
  const wrappers = new Map<PropertyKey, unknown>();
  return new Proxy(fake, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function' || property === 'constructor') return value;
      const cached = wrappers.get(property);
      if (cached !== undefined) return cached;
      const method = value as (...args: unknown[]) => unknown;
      const notify = !NOT_A_CHANGE.has(property);
      const wrapper = (...args: unknown[]): unknown => {
        let result: unknown;
        try {
          result = Reflect.apply(method, target, args);
        } finally {
          if (notify) changed();
        }
        if (notify && isPromiseLike(result)) result.then(changed, changed);
        return result;
      };
      wrappers.set(property, wrapper);
      return wrapper;
    },
  });
}

/** Builds every fake from the environment. Opens nothing: the Db stays lazy. */
export function createFakeDeps(options: FakeDepsOptions): FakeDeps {
  const { env, db, clock, onStateChange } = options;
  const persisted = <T extends object>(name: PersistedFakeName, fake: T): T =>
    onStateChange === undefined ? fake : notifyingProxy(fake, () => onStateChange(name));
  const fakes: FakeAdapters = {
    clock,
    hubspot: persisted(
      'hubspot',
      new FakeHubSpot({
        clock,
        portal: options.portal,
        appUrl: env.APP_URL,
        clientId: env.HUBSPOT_CLIENT_ID,
        clientSecret: env.HUBSPOT_CLIENT_SECRET,
        // The real D-11 classifier decides revoked / config / transient for the fake's refresh failures.
        classifyRefreshFailure,
      }),
    ),
    // The parameter assertion (PLAN §4) checks every request against the env's model settings.
    llm: new FakeLLM({
      models: { draft: env.ANTHROPIC_MODEL_DRAFT, fast: env.ANTHROPIC_MODEL_FAST },
      modelParams: modelParamsConfig(env),
      elapse: options.elapse,
    }),
    mailer: new FakeMailer({ clock, sink: options.mailSink ?? devOutboxSink(db) }),
    scheduler: new FakeScheduler({
      clock,
      dispatch: options.dispatch ?? dispatcherNotBuilt,
      onFailure: options.onJobFailure,
      maxDelaySeconds: env.QSTASH_MAX_DELAY_SECONDS,
    }),
    // The fake knows exactly one plan; give it the configured id so checkout and the plan check agree.
    billing: persisted(
      'billing',
      new FakeBilling({
        clock,
        appUrl: env.APP_URL,
        webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
        plan: { ...FAKE_RAZORPAY_PLAN, id: env.RAZORPAY_PLAN_ID },
      }),
    ),
    webFetcher: new FakeWebFetcher({ siteDir: options.siteDir }),
    // Persisted too: a dev restart must keep the bound owner's auth user and sessions (users.auth_user_id).
    auth: persisted(
      'auth',
      new FakeAuthProvider({
        clock,
        sessionSigningKey: deriveKey(env.APP_SECRET, 'fake-session'),
        secureCookies: env.APP_URL.startsWith('https:'),
      }),
    ),
  };
  const deps: Deps = {
    env,
    db,
    clock,
    hubspot: fakes.hubspot,
    llm: fakes.llm,
    mailer: fakes.mailer,
    scheduler: fakes.scheduler,
    billing: fakes.billing,
    webFetcher: fakes.webFetcher,
    auth: fakes.auth,
  };
  return { deps, fakes };
}
