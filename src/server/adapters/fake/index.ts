import 'server-only';
import { ConfigError } from '@/server/domain/errors';
import type { Db } from '@/server/db';
import type { Env } from '@/server/env';
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

export interface FakeDepsOptions {
  env: Env;
  db: Db;
  /** The DevClock (wall clock + persisted offset) in dev; a FakeClock in the simulation and tests. */
  clock: Clock;
  /** Default: fake.dev_outbox through `db` (dev). Tests pass `{kind: 'memory'}`, the simulation a directory. */
  mailSink?: FakeMailSink | undefined;
  /**
   * The job handler the fake scheduler delivers to (`/api/jobs/run`). The dispatcher arrives in M2;
   * until then every delivery fails with ConfigError('job_dispatcher_not_built').
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
}

export interface FakeDeps {
  deps: Deps;
  fakes: FakeAdapters;
}

const dispatcherNotBuilt: FakeDispatch = () => {
  throw new ConfigError('job_dispatcher_not_built');
};

/** Builds every fake from the environment. Opens nothing: the Db stays lazy. */
export function createFakeDeps(options: FakeDepsOptions): FakeDeps {
  const { env, db, clock } = options;
  const fakes: FakeAdapters = {
    clock,
    hubspot: new FakeHubSpot({
      clock,
      portal: options.portal,
      appUrl: env.APP_URL,
      clientId: env.HUBSPOT_CLIENT_ID,
      clientSecret: env.HUBSPOT_CLIENT_SECRET,
    }),
    llm: new FakeLLM({
      models: { draft: env.ANTHROPIC_MODEL_DRAFT, fast: env.ANTHROPIC_MODEL_FAST },
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
    billing: new FakeBilling({
      clock,
      appUrl: env.APP_URL,
      webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
      plan: { ...FAKE_RAZORPAY_PLAN, id: env.RAZORPAY_PLAN_ID },
    }),
    webFetcher: new FakeWebFetcher({ siteDir: options.siteDir }),
    auth: new FakeAuthProvider({
      clock,
      sessionSigningKey: deriveKey(env.APP_SECRET, 'fake-session'),
      secureCookies: env.APP_URL.startsWith('https:'),
    }),
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
