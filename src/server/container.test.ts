import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DateTime, Settings } from 'luxon';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '@/server/domain/errors';
import { EnvError, FAKE_ENV, parseEnv, type Env } from '@/server/env';
import type { Db } from '@/server/db';
import type { Deps } from '@/server/ports';
import { FakeClock } from '@/server/adapters/fake/clock';
import { CLOCK_OFFSET_KEY, DevClock } from '@/server/adapters/fake/dev-clock';
import { SystemClock } from '@/server/adapters/live/system-clock';
import { AnthropicLLM } from '@/server/adapters/live/anthropic-llm';
import { HubSpotHttpClient } from '@/server/adapters/live/hubspot';
import { QstashScheduler } from '@/server/adapters/live/qstash-scheduler';
import { ResendMailer } from '@/server/adapters/live/resend-mailer';
import { insertJob, publishJobs } from '@/server/jobs';
import { seedAccount } from '@/server/jobs/testing';
import { buildContainer, buildLiveAdapters, createLiveDeps, getContainer, getDeps, resetContainer } from './container';

const store = globalThis as typeof globalThis & { __autopilot?: unknown };

/** The date Luxon fills in for a time-only input: whatever its notion of "now" is (Settings.now). */
const luxonToday = (): string | null => DateTime.fromFormat('12:00', 'HH:mm', { zone: 'UTC' }).toISODate();

afterEach(async () => {
  await resetContainer();
  vi.unstubAllEnvs();
});

describe('container', () => {
  it('builds nothing at import time', () => {
    expect(store.__autopilot).toBeUndefined();
  });

  it('fake mode: one lazily built, migrated PGlite with every fake, shared through globalThis', async () => {
    vi.stubEnv('APP_MODE', 'fake');
    vi.stubEnv('FAKE_DB_DIR', 'memory://');
    const first = getContainer();
    expect(getContainer()).toBe(first);
    expect(store.__autopilot).toBe(first);

    const container = await first;
    expect(container.mode).toBe('fake');
    expect(container.fakes).not.toBeNull();
    const deps = await getDeps();
    expect(deps).toBe(container.deps);
    expect(deps.env.APP_MODE).toBe('fake');
    expect(deps.clock).toBeInstanceOf(DevClock);
    expect(container.devClock).toBe(deps.clock);
    expect(await deps.db.query('select version from fake._migrations')).toEqual([{ version: '20261001000001' }]);
    expect(deps.hubspot).toBe(container.fakes?.hubspot);
    expect(deps.mailer).toBe(container.fakes?.mailer);
  });

  it('fake mode: the mailer writes to fake.dev_outbox', async () => {
    vi.stubEnv('APP_MODE', 'fake');
    vi.stubEnv('FAKE_DB_DIR', 'memory://');
    const deps = await getDeps();
    await deps.mailer.send({
      to: ['owner@brightside-plumbing.example'],
      subject: 'Sign in',
      html: '<p>Link</p>',
      text: 'Link',
      tags: [{ name: 'kind', value: 'magic_link' }],
      idempotencyKey: 'fake-local:magic:1',
    });
    expect(await deps.db.query('select kind, subject from fake.dev_outbox')).toEqual([{ kind: 'magic_link', subject: 'Sign in' }]);
  });

  it('fake mode: the fakes accept the documented fake configuration', async () => {
    vi.stubEnv('APP_MODE', 'fake');
    vi.stubEnv('FAKE_DB_DIR', 'memory://');
    const deps = await getDeps();
    await expect(deps.billing.fetchPlan(FAKE_ENV.RAZORPAY_PLAN_ID)).resolves.toMatchObject({ id: FAKE_ENV.RAZORPAY_PLAN_ID });
    expect(deps.hubspot.authorizeUrl({ state: 's', redirectUri: FAKE_ENV.HUBSPOT_REDIRECT_URI, scopes: ['oauth'] })).toContain(
      `client_id=${FAKE_ENV.HUBSPOT_CLIENT_ID}`,
    );
  });

  it('fake mode: the clock offset survives a restart on the same FAKE_DB_DIR, and drives Luxon', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'autopilot-container-'));
    const base = new FakeClock(new Date('2026-10-06T13:00:00.000Z'));
    const env = parseEnv({ APP_MODE: 'fake', FAKE_DB_DIR: dir });
    const luxonBefore = Settings.now;
    try {
      const first = await buildContainer(env, { baseClock: base });
      try {
        expect(first.deps.clock.now().toISOString()).toBe('2026-10-06T13:00:00.000Z');
        await first.devClock?.advance({ days: 2, hours: 3 });
        expect(first.deps.clock.now().toISOString()).toBe('2026-10-08T16:00:00.000Z');
        expect(luxonToday()).toBe('2026-10-08');
        expect(await first.deps.db.query('select value from fake.state where key = $1', [CLOCK_OFFSET_KEY])).toEqual([
          { value: { offsetMs: (2 * 24 + 3) * 3_600_000 } },
        ]);
      } finally {
        await first.close();
      }
      expect(Settings.now).toBe(luxonBefore);

      // The wall clock moved on while the app was down; the offset is kept, not the instant.
      base.advance({ minutes: 5 });
      const second = await buildContainer(env, { baseClock: base });
      try {
        expect(second.devClock?.offsetMs).toBe((2 * 24 + 3) * 3_600_000);
        expect(second.deps.clock.now().toISOString()).toBe('2026-10-08T16:05:00.000Z');
        expect(luxonToday()).toBe('2026-10-08');
        await second.devClock?.set(new Date('2026-10-06T13:05:00.000Z'));
        expect(second.devClock?.offsetMs).toBe(0);
      } finally {
        await second.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fake mode: two boots on one FAKE_DB_DIR see the same portal tokens and subscriptions', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'autopilot-container-'));
    const base = new FakeClock(new Date('2026-10-06T13:00:00.000Z'));
    const env = parseEnv({ APP_MODE: 'fake', FAKE_DB_DIR: dir });
    try {
      const first = await buildContainer(env, { baseClock: base });
      let tokens: Awaited<ReturnType<Deps['hubspot']['exchangeCode']>>;
      let subscriptionId: string;
      try {
        const code = first.fakes?.hubspot.createAuthCode({ redirectUri: env.HUBSPOT_REDIRECT_URI }) ?? '';
        tokens = await first.deps.hubspot.exchangeCode(code, env.HUBSPOT_REDIRECT_URI);
        subscriptionId = (
          await first.deps.billing.createSubscription({
            planId: env.RAZORPAY_PLAN_ID,
            totalCount: 120,
            quantity: 1,
            customerNotify: false,
            expireBy: new Date('2026-10-07T13:00:00.000Z'),
            notes: { autopilot_account_id: 'acct-1' },
          })
        ).id;
      } finally {
        // Closing flushes the pending (debounced) snapshot writes.
        await first.close();
      }

      base.advance({ minutes: 5 });
      const second = await buildContainer(env, { baseClock: base });
      try {
        expect(second.fakes?.hubspot.isInstalled()).toBe(true);
        await expect(second.deps.hubspot.accountDetails(tokens.accessToken)).resolves.toMatchObject({ portalId: '1234567' });
        await expect(second.deps.hubspot.refresh(tokens.refreshToken)).resolves.toMatchObject({ refreshToken: tokens.refreshToken });
        await expect(second.deps.billing.fetchSubscription(subscriptionId)).resolves.toMatchObject({ id: subscriptionId, status: 'created' });
        expect(
          (await second.deps.db.query<{ key: string }>('select key from fake.state order by key')).map((row) => row.key),
        ).toEqual(['billing_snapshot', 'hubspot_snapshot']);
      } finally {
        await second.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fake mode: the fake scheduler delivers jobs to the registered handlers, as /api/jobs/run would', async () => {
    const env = parseEnv({ APP_MODE: 'fake', FAKE_DB_DIR: 'memory://' });
    const container = await buildContainer(env, { baseClock: new FakeClock(new Date('2026-10-06T13:00:00.000Z')) });
    try {
      const { deps } = container;
      const now = deps.clock.now();
      // A paused account: the portal_poll handler (registered by the intake service) skips it.
      const accountId = await seedAccount(deps.db, { now, processingState: 'paused' });
      const row = await deps.db.tx((tx) => insertJob(tx, { kind: 'portal_poll', accountId, dedupeKey: `poll:${accountId}:test`, runAt: now, now }));
      expect(row).not.toBeNull();
      await publishJobs(deps, row === null ? [] : [row]);
      expect(await container.fakes?.scheduler.runDue()).toBe(1);
      expect(await deps.db.query('select kind, status from scheduled_jobs')).toEqual([{ kind: 'portal_poll', status: 'skipped' }]);
    } finally {
      await container.close();
    }
  });

  it('fake mode: the fake LLM asserts every request against the env model settings', async () => {
    const env = parseEnv({ APP_MODE: 'fake', FAKE_DB_DIR: 'memory://', ANTHROPIC_MODEL_FAST: 'claude-unknown-model' });
    const container = await buildContainer(env, { baseClock: new FakeClock(new Date('2026-10-06T13:00:00.000Z')) });
    try {
      await expect(
        container.deps.llm.classify({ message: 'Need a quote', formName: 'Contact us', firstName: null, company: null }),
      ).rejects.toThrow('anthropic_model_not_supported');
    } finally {
      await container.close();
    }
  });

  it('fake mode: the dev clock refuses to move backwards through advance()', async () => {
    const env = parseEnv({ APP_MODE: 'fake', FAKE_DB_DIR: 'memory://' });
    const container = await buildContainer(env, { baseClock: new FakeClock(new Date('2026-10-06T13:00:00.000Z')) });
    try {
      await expect(container.devClock?.advance(-1)).rejects.toThrow('dev_clock_invalid_advance');
      expect(container.devClock?.offsetMs).toBe(0);
    } finally {
      await container.close();
    }
  });

  it('live mode: Luxon follows the injected clock while the container is open', async () => {
    const env = parseEnv({ APP_MODE: 'fake' });
    const clock = new FakeClock(new Date('2026-10-06T13:00:00.000Z'));
    const before = Settings.now;
    const live: Env = { ...env, APP_MODE: 'live', DATABASE_URL: 'postgres://user:pass@127.0.0.1:1/none' };
    const container = await buildContainer(live, { baseClock: clock });
    try {
      expect(container.mode).toBe('live');
      expect(container.devClock).toBeNull();
      expect(container.deps.clock).toBe(clock);
      expect(luxonToday()).toBe('2026-10-06');
    } finally {
      await container.close();
    }
    expect(Settings.now).toBe(before);
  });

  it('an invalid environment rejects and is not cached', async () => {
    vi.stubEnv('APP_MODE', 'staging');
    await expect(getContainer()).rejects.toBeInstanceOf(EnvError);
    expect(store.__autopilot).toBeUndefined();
  });

  it('live mode: HubSpot, the LLM, the mailer and the scheduler use their live adapters (built without any network call)', async () => {
    const env = parseEnv({ APP_MODE: 'fake' });
    const clock = new FakeClock(new Date('2026-10-06T13:00:00.000Z'));
    const adapters = await buildLiveAdapters(env, clock);
    expect(adapters.hubspot).toBeInstanceOf(HubSpotHttpClient);
    expect(adapters.llm).toBeInstanceOf(AnthropicLLM);
    expect(adapters.mailer).toBeInstanceOf(ResendMailer);
    expect(adapters.scheduler).toBeInstanceOf(QstashScheduler);
    const db = { close: () => Promise.resolve() } as unknown as Db;
    const deps = createLiveDeps({ env, db, clock, adapters });
    expect(deps.hubspot).toBe(adapters.hubspot);
    expect(deps.scheduler).toBe(adapters.scheduler);
    expect(() => deps.billing.fetchPlan('plan_x')).toThrow('live_adapter_not_built');
  });

  it('live mode: ports without a live adapter throw ConfigError live_adapter_not_built when used', async () => {
    const env = parseEnv({ APP_MODE: 'fake' });
    const db = { close: () => Promise.resolve() } as unknown as Db;
    const deps = createLiveDeps({ env, db });
    expect(deps.clock).toBeInstanceOf(SystemClock);
    expect(deps.db).toBe(db);
    for (const port of [deps.hubspot, deps.llm, deps.mailer, deps.scheduler, deps.billing, deps.webFetcher, deps.auth]) {
      expect(port).not.toHaveProperty('then');
    }
    expect(() => deps.hubspot.listForms('token')).toThrow(ConfigError);
    expect(() => deps.mailer.send({ to: [], subject: '', html: '', text: '', idempotencyKey: 'k' })).toThrow('live_adapter_not_built');
    await expect(Promise.resolve(deps.llm)).resolves.toBe(deps.llm);
  });
});
