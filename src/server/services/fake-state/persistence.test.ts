import { beforeEach, describe, expect, it } from 'vitest';
import { createFakeDeps, type PersistedFakeName } from '@/server/adapters/fake';
import { FakeBilling } from '@/server/adapters/fake/billing';
import { FakeClock } from '@/server/adapters/fake/clock';
import { FakeHubSpot } from '@/server/adapters/fake/hubspot';
import type { Db } from '@/server/db';
import { parseEnv } from '@/server/env';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import { fakeStateKey, startFakeStatePersistence, type FakeStatePersistence, type FlushScheduler } from './persistence';

const getDb = setUpTestDb();

const START = new Date('2026-10-06T13:00:00.000Z');
const env = parseEnv({ APP_MODE: 'fake' });

/** A FlushScheduler the test drives: nothing runs until `fire()`. */
function manualScheduler(): { schedule: FlushScheduler; pending: () => number; fire: () => void; delays: number[] } {
  const queue: (() => void)[] = [];
  const delays: number[] = [];
  return {
    schedule: (run, ms) => {
      queue.push(run);
      delays.push(ms);
      return () => {
        const index = queue.indexOf(run);
        if (index >= 0) queue.splice(index, 1);
      };
    },
    delays,
    pending: () => queue.length,
    fire: () => {
      for (const run of queue.splice(0)) run();
    },
  };
}

/** The fake-mode wiring the container uses, on the test database. */
async function boot(db: Db, scheduler: FlushScheduler, clock = new FakeClock(START)) {
  const ref: { persistence?: FakeStatePersistence<PersistedFakeName> } = {};
  const built = createFakeDeps({ env, db, clock, mailSink: { kind: 'memory' }, onStateChange: (name) => ref.persistence?.markChanged(name) });
  const persistence = await startFakeStatePersistence<PersistedFakeName>({
    db,
    sources: { hubspot: built.fakes.hubspot, billing: built.fakes.billing, auth: built.fakes.auth },
    schedule: scheduler,
    debounceMs: 50,
  });
  ref.persistence = persistence;
  return { ...built, persistence, clock };
}

async function stored(db: Db, name: PersistedFakeName): Promise<unknown> {
  const row = await db.maybeOne<{ value: unknown }>('select value from fake.state where key = $1', [fakeStateKey(name)]);
  return row?.value;
}

async function storedKeys(db: Db): Promise<string[]> {
  return (await db.query<{ key: string }>('select key from fake.state order by key')).map((r) => r.key);
}

let scheduler: ReturnType<typeof manualScheduler>;

beforeEach(() => {
  scheduler = manualScheduler();
});

describe('fake state persistence', () => {
  it('saves a changed snapshot after the debounce, once for a burst of calls', async () => {
    const db = getDb();
    const { deps, fakes, persistence } = await boot(db, scheduler.schedule);
    const redirectUri = env.HUBSPOT_REDIRECT_URI;
    const code = fakes.hubspot.createAuthCode({ redirectUri });
    const tokens = await deps.hubspot.exchangeCode(code, redirectUri);
    await deps.hubspot.accountDetails(tokens.accessToken);

    // One debounce for the whole burst; nothing written before it fires.
    expect(scheduler.pending()).toBe(1);
    expect(scheduler.delays).toEqual([50]);
    expect(await storedKeys(db)).toEqual([]);

    scheduler.fire();
    await persistence.flush();
    expect(await storedKeys(db)).toEqual(['hubspot_snapshot']);
    expect(await stored(db, 'hubspot')).toEqual(JSON.parse(JSON.stringify(fakes.hubspot.snapshot())));
  });

  it('a new boot on the same database restores the portal tokens and the subscriptions', async () => {
    const db = getDb();
    const first = await boot(db, scheduler.schedule);
    const redirectUri = env.HUBSPOT_REDIRECT_URI;
    const tokens = await first.deps.hubspot.exchangeCode(first.fakes.hubspot.createAuthCode({ redirectUri }), redirectUri);
    const subscription = await first.deps.billing.createSubscription({
      planId: env.RAZORPAY_PLAN_ID,
      totalCount: 120,
      quantity: 1,
      customerNotify: false,
      expireBy: new Date(START.getTime() + 86_400_000),
      notes: { autopilot_account_id: 'acct-1' },
    });
    await first.persistence.close();

    const second = await boot(db, manualScheduler().schedule, new FakeClock(new Date(START.getTime() + 60_000)));
    expect(second.fakes.hubspot.isInstalled()).toBe(true);
    await expect(second.deps.hubspot.accountDetails(tokens.accessToken)).resolves.toMatchObject({ portalId: first.fakes.hubspot.portal.portalId });
    await expect(second.deps.hubspot.refresh(tokens.refreshToken)).resolves.toMatchObject({ refreshToken: tokens.refreshToken });
    await expect(second.deps.billing.fetchSubscription(subscription.id)).resolves.toMatchObject({ id: subscription.id, status: 'created' });
    expect(second.fakes.billing.subscriptionIds()).toEqual([subscription.id]);
  });

  it('does not write a snapshot that did not change', async () => {
    const db = getDb();
    const { fakes, persistence } = await boot(db, scheduler.schedule);
    fakes.hubspot.setRefreshMode('revoked');
    scheduler.fire();
    await persistence.flush();
    await db.query('delete from fake.state');

    // Read-only calls still mark the fake, but the snapshot equals what was written.
    fakes.hubspot.isInstalled();
    fakes.billing.subscriptionIds();
    scheduler.fire();
    await persistence.flush();
    expect(await storedKeys(db)).toEqual([]);
  });

  it('counts a call that threw as a change (a consumed injected failure)', async () => {
    const db = getDb();
    const { deps, fakes, persistence } = await boot(db, scheduler.schedule);
    const tokens = fakes.hubspot.installTokens();
    fakes.hubspot.injectFailure('accountDetails', { kind: 'server_error' });
    scheduler.fire();
    await persistence.flush();
    expect(await stored(db, 'hubspot')).toMatchObject({ faults: [expect.objectContaining({ operation: 'accountDetails' })] });

    await expect(deps.hubspot.accountDetails(tokens.accessToken)).rejects.toThrow();
    expect(scheduler.pending()).toBe(1);
    scheduler.fire();
    await persistence.flush();
    expect(await stored(db, 'hubspot')).toMatchObject({ faults: [] });
  });

  it('ignores a stored snapshot that no longer parses and keeps the fixture state', async () => {
    const db = getDb();
    await db.query(`insert into fake.state (key, value) values ($1, $2::jsonb)`, [fakeStateKey('hubspot'), JSON.stringify({ version: 999 })]);
    const { fakes, persistence } = await boot(db, scheduler.schedule);
    expect(fakes.hubspot.isInstalled()).toBe(false);
    expect(fakes.hubspot.portal.portalId).toBe('1234567');

    // The next change overwrites the unreadable snapshot.
    fakes.hubspot.installTokens();
    await persistence.close();
    expect(await stored(db, 'hubspot')).toMatchObject({ oauth: { installed: true } });
  });

  it('close() cancels the debounce, writes what is pending and ignores later changes', async () => {
    const db = getDb();
    const { fakes, persistence } = await boot(db, scheduler.schedule);
    fakes.hubspot.installTokens();
    await persistence.close();
    expect(scheduler.pending()).toBe(0);
    expect(await storedKeys(db)).toEqual(['hubspot_snapshot']);

    fakes.billing.injectFailure('*', 'transient', 1);
    expect(scheduler.pending()).toBe(0);
    await persistence.flush();
    expect(await storedKeys(db)).toEqual(['hubspot_snapshot']);
  });

  it('keeps a snapshot whose write failed dirty and writes it on the next flush', async () => {
    const db = getDb();
    let failNext = true;
    const flaky: Db = {
      ...db,
      query: async (sql, params) => {
        if (failNext && sql.includes('insert into fake.state')) {
          failNext = false;
          throw new Error('write failed');
        }
        return db.query(sql, params);
      },
    };
    const { fakes, persistence } = await boot(flaky, scheduler.schedule);
    fakes.hubspot.installTokens();
    await persistence.flush();
    expect(await storedKeys(db)).toEqual([]);
    await persistence.flush();
    expect(await storedKeys(db)).toEqual(['hubspot_snapshot']);
  });

  it('the persisted fakes are still instances of their classes, and deps shares them', async () => {
    const { deps, fakes } = await boot(getDb(), scheduler.schedule);
    expect(fakes.hubspot).toBeInstanceOf(FakeHubSpot);
    expect(fakes.hubspot.constructor).toBe(FakeHubSpot);
    expect(fakes.billing).toBeInstanceOf(FakeBilling);
    expect(deps.hubspot).toBe(fakes.hubspot);
    expect(deps.billing).toBe(fakes.billing);
    expect(fakes.hubspot.createAuthCode).toBe(fakes.hubspot.createAuthCode);
  });

  it('fakes built without onStateChange are the plain instances', () => {
    const built = createFakeDeps({ env, db: getDb(), clock: new FakeClock(START), mailSink: { kind: 'memory' } });
    expect(Object.getPrototypeOf(built.fakes.hubspot)).toBe(Object.getPrototypeOf(built.deps.hubspot));
    expect(built.deps.hubspot).toBe(built.fakes.hubspot);
  });
});
