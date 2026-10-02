import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db, DbRow } from '@/server/db';
import { TransientError } from '@/server/domain/errors';
import type { Deps } from '@/server/ports';
import { seedAccount, seedSettings } from '@/server/jobs/testing';
import { seedOwner } from '@/server/services/accounts/testing';
import { startCheckout } from '@/server/services/billing';
import { createOwnerScopeForTest } from '@/server/services/auth/owner-scope';
import { runAccountDaily, runDailyCron } from '@/server/services/daily';
import { disconnectOrphan, purgeAccountIfDue, reconcileBillingTombstones } from '@/server/services/purge';
import { useTestDb as setUpTestDb } from '../db/harness';
import { interceptBefore } from '../db/intercept';
import {
  accountRowCounts,
  alertCodes,
  createRetentionRig,
  DAY,
  HOUR,
  installNewPortal,
  MINUTE,
  revokeNow,
  runDaily,
  seedInstalledAccount,
  seedSubscription,
  type RetentionRig,
} from './support';

// What the purge and the daily runs must never get wrong (PLAN §9.10 steps 5-6, D-48, D-82): a
// local `stale`/`unknown` status never stands for Razorpay's word (the purge asks Razorpay; a failed
// read never resolves a tombstone); a subscription created while the purge runs is tombstoned; the
// re-checks before the auth-user delete and inside the last transaction hold (a reconnect or a bind
// during the purge wins); a crash between the auth-user delete and the last transaction is retried
// cleanly; an orphan with an unexpired pending owner is kept; the tombstone reconcile's failure paths
// and the daily cron's time budget.

const getDb = setUpTestDb();
let rig: RetentionRig;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = createRetentionRig(getDb());
});

afterEach(() => {
  rig.stop();
  vi.useRealTimers();
});

function at(base: Date, ms: number): Date {
  return new Date(base.getTime() + ms);
}

async function tombstone(id: string): Promise<{ last_status: string; resolved_at: Date | null; last_checked_at: Date | null } | null> {
  return getDb().maybeOne(`select last_status, resolved_at, last_checked_at from billing_tombstones where provider_subscription_id = $1`, [id]);
}

function authUserExists(userId: string): boolean {
  return rig.fakes.auth.users().some((user) => user.userId === userId);
}

/** `target` with `after` run once each time `method` resolves (methods stay bound to the real object). */
function hookAfter<T extends object>(target: T, method: string, after: () => Promise<void>): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value: unknown = Reflect.get(object, property, receiver);
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (property !== method) return fn.bind(object);
      return async (...args: unknown[]) => {
        const result = await fn.apply(object, args);
        await after();
        return result;
      };
    },
  });
}

/** A Db whose first statement matching `match` throws `error` (inside a transaction: rolled back). */
function failOnce(db: Db, match: RegExp, error: Error): Db {
  let failed = false;
  const wrap = (handle: Db): Db => {
    const check = (sql: string): void => {
      if (!failed && match.test(sql)) {
        failed = true;
        throw error;
      }
    };
    return {
      async query<Row extends object = DbRow>(sql: string, params?: readonly unknown[]): Promise<Row[]> {
        check(sql);
        return handle.query<Row>(sql, params);
      },
      async one<Row extends object = DbRow>(sql: string, params?: readonly unknown[]): Promise<Row> {
        check(sql);
        return handle.one<Row>(sql, params);
      },
      async maybeOne<Row extends object = DbRow>(sql: string, params?: readonly unknown[]): Promise<Row | null> {
        check(sql);
        return handle.maybeOne<Row>(sql, params);
      },
      exec: (sql: string) => handle.exec(sql),
      tx: <T>(fn: (tx: Db) => Promise<T>): Promise<T> => handle.tx((inner) => fn(wrap(inner))),
      close: () => handle.close(),
    };
  };
  return wrap(db);
}

/** A reconnect landing mid-purge (an active connection needs tokens; these are never decrypted). */
async function reconnect(accountId: string): Promise<void> {
  const ciphertext = 'v1.0123abcd.aaaa.bbbb.cccc';
  await getDb().query(`update hubspot_connections set status = 'active', access_token_enc = $2, refresh_token_enc = $2 where account_id = $1`, [accountId, ciphertext]);
}

/** A revoked account whose purge_after has just passed. */
async function dueForPurge(): Promise<Awaited<ReturnType<typeof seedInstalledAccount>>> {
  const account = await seedInstalledAccount(rig);
  return account;
}

describe('the local stale and unknown statuses never stand for Razorpay (D-82)', () => {
  it('a stale row Razorpay reports authenticated is cancelled before the purge, and its tombstone resolved', async () => {
    const account = await dueForPurge();
    const id = await seedSubscription(rig, account.accountId, 'authenticated');
    await revokeNow(rig, account.accountId);
    rig.clock.advance({ days: 30, minutes: 1 });
    // Marked stale locally (e.g. a re-fetch that failed at checkout); Razorpay holds it authenticated.
    await getDb().query(`update subscriptions set status = 'stale' where provider_subscription_id = $1`, [id]);

    const result = await purgeAccountIfDue(rig.deps, account.accountId);
    expect(result).toMatchObject({ status: 'purged', cancelledSubscriptions: 1, tombstones: 1 });
    expect((await rig.billing.fetchSubscription(id)).status).toBe('cancelled');
    expect(await tombstone(id)).toMatchObject({ last_status: 'cancelled', resolved_at: rig.clock.now(), last_checked_at: rig.clock.now() });
  });

  it('an undocumented status (stored unknown) raises billing_purge_cancel_in_dashboard and leaves an open tombstone', async () => {
    const account = await dueForPurge();
    const id = await seedSubscription(rig, account.accountId, 'active');
    await revokeNow(rig, account.accountId);
    rig.clock.advance({ days: 30, minutes: 1 });
    await getDb().query(`update subscriptions set status = 'unknown' where provider_subscription_id = $1`, [id]);
    const real = rig.billing.fetchSubscription.bind(rig.billing);
    const deps: Deps = {
      ...rig.deps,
      billing: new Proxy(rig.billing, {
        get(object, property, receiver) {
          if (property === 'fetchSubscription') return async (subscriptionId: string) => ({ ...(await real(subscriptionId)), status: 'on_hold' });
          const value: unknown = Reflect.get(object, property, receiver);
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(object) : value;
        },
      }),
    };

    expect(await purgeAccountIfDue(deps, account.accountId)).toMatchObject({ status: 'purged', cancelledSubscriptions: 0, tombstones: 1 });
    expect(await tombstone(id)).toEqual({ last_status: 'on_hold', resolved_at: null, last_checked_at: rig.clock.now() });
    expect(rig.alerts.find((alert) => alert.code === 'billing_purge_cancel_in_dashboard')?.fields).toEqual({ subscriptionId: id, status: 'on_hold' });
    expect((await rig.billing.fetchSubscription(id)).status).toBe('active');
  });

  it('a stale row whose read fails is never resolved unread: its tombstone stays open, and the reconcile cancels it the next day', async () => {
    const account = await dueForPurge();
    const id = await seedSubscription(rig, account.accountId, 'authenticated');
    await revokeNow(rig, account.accountId);
    rig.clock.advance({ days: 30, minutes: 1 });
    // Marked stale locally (e.g. a re-fetch that failed at checkout); Razorpay holds it authenticated.
    await getDb().query(`update subscriptions set status = 'stale' where provider_subscription_id = $1`, [id]);

    rig.billing.injectFailure('fetchSubscription', 'transient', 1);
    expect(await purgeAccountIfDue(rig.deps, account.accountId)).toMatchObject({ status: 'purged', cancelledSubscriptions: 0, tombstones: 1 });
    expect(await tombstone(id)).toEqual({ last_status: 'stale', resolved_at: null, last_checked_at: null });
    expect(alertCodes(rig)).not.toContain('billing_purge_cancel_in_dashboard');

    rig.clock.advance({ days: 1 });
    expect(await reconcileBillingTombstones(rig.deps)).toMatchObject({ checked: 1, cancelled: 1 });
    expect((await rig.billing.fetchSubscription(id)).status).toBe('cancelled');
    expect((await tombstone(id))?.resolved_at).not.toBeNull();
  });

  it('the daily reconcile reads a stale row again while it could still be authorised, and applies what Razorpay says', async () => {
    const account = await seedInstalledAccount(rig);
    const id = await seedSubscription(rig, account.accountId, 'created');
    await getDb().query(`update subscriptions set status = 'stale' where provider_subscription_id = $1`, [id]);
    // The owner authorised the old link (no start_at: charged and active at once); its webhooks never arrived.
    rig.billing.authenticate(id);
    rig.billing.takeWebhooks();
    rig.clock.advance({ hours: 1 });
    expect((await runDaily(rig, account.accountId)).reconcile).toEqual({ reconciled: 1 });
    expect(await getDb().one(`select status from subscriptions where provider_subscription_id = $1`, [id])).toEqual({ status: 'active' });
  });

  it('the daily reconcile stops reading a stale row 16 days after its expire_by', async () => {
    const account = await seedInstalledAccount(rig);
    const id = await seedSubscription(rig, account.accountId, 'created');
    await getDb().query(`update subscriptions set status = 'stale' where provider_subscription_id = $1`, [id]);
    // expire_by is 7 days out: read until day 7 + 16.
    rig.clock.advance({ days: 23, hours: -1 });
    expect((await runDaily(rig, account.accountId)).reconcile).toEqual({ reconciled: 1 });
    rig.clock.advance({ hours: 2 });
    expect((await runDaily(rig, account.accountId)).reconcile).toEqual({ reconciled: 0 });
  });
});

describe('a subscription created while the purge runs (D-82)', () => {
  it('a checkout that committed after the settle step still gets an open tombstone, and the admin is told', async () => {
    const account = await dueForPurge();
    await revokeNow(rig, account.accountId);
    rig.clock.advance({ days: 30, minutes: 1 });
    // Razorpay holds it; our row lands just before the purge's last transaction locks the account.
    const late = await rig.billing.createSubscription({
      planId: rig.deps.env.RAZORPAY_PLAN_ID,
      totalCount: 120,
      quantity: 1,
      customerNotify: true,
      expireBy: at(rig.clock.now(), 7 * DAY),
      notes: { autopilot_account_id: account.accountId },
    });
    const intercepted = interceptBefore(getDb(), /from accounts where id = \$1 for update/, async (handle) => {
      await handle.query(
        `insert into subscriptions (account_id, provider_subscription_id, plan_id, status, status_changed_at, short_url, expire_by, created_at)
         values ($1, $2, $3, 'created', $4, $5, $6, $4)`,
        [account.accountId, late.id, late.planId, rig.clock.now(), late.shortUrl, late.expireBy ?? null],
      );
    });
    expect(await purgeAccountIfDue({ ...rig.deps, db: intercepted.db }, account.accountId)).toMatchObject({ status: 'purged', tombstones: 1 });
    expect(intercepted.fired()).toBe(1);
    expect(await tombstone(late.id)).toEqual({ last_status: 'created', resolved_at: null, last_checked_at: null });
    expect(alertCodes(rig)).toContain('billing_purge_late_subscription');

    // If the customer authorises it anyway, the webhook path cancels it.
    rig.billing.authenticate(late.id);
    rig.billing.takeWebhooks();
    rig.clock.advance({ days: 1 });
    expect(await reconcileBillingTombstones(rig.deps)).toMatchObject({ checked: 1, cancelled: 1 });
  });

  it('a checkout whose account is purged before its row is written tombstones the new subscription itself', async () => {
    const account = await seedInstalledAccount(rig);
    const scope = createOwnerScopeForTest(account.accountId, account.ownerUserId);
    const intercepted = interceptBefore(getDb(), /from accounts where id = \$1 for no key update/, async (handle) => {
      await handle.query(`delete from accounts where id = $1`, [account.accountId]);
    });
    expect(await startCheckout({ ...rig.deps, db: intercepted.db }, scope)).toEqual({ type: 'unavailable' });
    const [created] = rig.billing.subscriptionIds();
    expect(created).toBeDefined();
    expect(await tombstone(created ?? '')).toEqual({ last_status: 'created', resolved_at: null, last_checked_at: null });
  });

  it('an account due for deletion gets no new checkout at all', async () => {
    const account = await dueForPurge();
    await revokeNow(rig, account.accountId);
    rig.clock.advance({ days: 30, minutes: 1 });
    expect(await startCheckout(rig.deps, createOwnerScopeForTest(account.accountId, account.ownerUserId))).toEqual({ type: 'closing' });
    expect(rig.billing.subscriptionIds()).toEqual([]);
  });
});

describe('the purge re-checks (PLAN §9.10 step 5)', () => {
  it('a reconnect during the subscription step stops the purge before the auth user is touched', async () => {
    const account = await dueForPurge();
    await seedSubscription(rig, account.accountId, 'pending');
    await revokeNow(rig, account.accountId);
    rig.clock.advance({ days: 30, minutes: 1 });
    const deps: Deps = { ...rig.deps, billing: hookAfter(rig.deps.billing, 'fetchSubscription', () => reconnect(account.accountId)) };

    expect(await purgeAccountIfDue(deps, account.accountId)).toEqual({ status: 'aborted', authUser: 'not_reached' });
    expect((await accountRowCounts(getDb(), account.accountId)).accounts).toBe(1);
    expect(authUserExists(account.ownerUserId)).toBe(true);
    expect(await getDb().query(`select provider_subscription_id from billing_tombstones`)).toEqual([]);
  });

  it('a reconnect right after the auth-user delete aborts the last transaction: nothing deleted, no tombstone, the admin alerted', async () => {
    const account = await dueForPurge();
    const id = await seedSubscription(rig, account.accountId, 'pending');
    await revokeNow(rig, account.accountId);
    rig.clock.advance({ days: 30, minutes: 1 });
    const deps: Deps = { ...rig.deps, auth: hookAfter(rig.deps.auth, 'deleteUser', () => reconnect(account.accountId)) };

    expect(await purgeAccountIfDue(deps, account.accountId)).toEqual({ status: 'aborted', authUser: 'deleted' });
    expect(alertCodes(rig)).toContain('account_purge_aborted');
    expect((await accountRowCounts(getDb(), account.accountId)).accounts).toBe(1);
    expect(await tombstone(id)).toBeNull();
  });

  it('a crash between the auth-user delete and the last transaction is retried cleanly: purged, nothing cancelled twice, the tombstone resolved', async () => {
    const account = await dueForPurge();
    const id = await seedSubscription(rig, account.accountId, 'active');
    await revokeNow(rig, account.accountId);
    rig.clock.advance({ days: 30, minutes: 1 });
    let cancels = 0;
    const billing = hookAfter(rig.deps.billing, 'cancelSubscription', async () => {
      cancels += 1;
    });

    const crashing: Deps = { ...rig.deps, billing, db: failOnce(getDb(), /delete from accounts where id = \$1/, new TransientError('db_connection_lost')) };
    const first = await runAccountDaily(crashing, account.accountId, { sleep: rig.sleep });
    expect(first.failures).toEqual([{ step: 'purge', code: 'db_connection_lost', retryable: true }]);
    expect((await accountRowCounts(getDb(), account.accountId)).accounts).toBe(1);
    expect(authUserExists(account.ownerUserId)).toBe(false);
    expect(await tombstone(id)).toBeNull();

    const second = await runAccountDaily({ ...rig.deps, billing }, account.accountId, { sleep: rig.sleep });
    expect(second.purge).toMatchObject({ status: 'purged', authUser: 'deleted', tombstones: 1, cancelledSubscriptions: 0 });
    expect(second.failures).toEqual([]);
    expect(cancels).toBe(1);
    expect(await tombstone(id)).toMatchObject({ last_status: 'cancelled', resolved_at: rig.clock.now() });
    expect((await accountRowCounts(getDb(), account.accountId)).accounts).toBe(0);
  });

  it('an owner bound between the orphan check and its transaction keeps the install: not an orphan, the connection stays active', async () => {
    const accountId = await installNewPortal(rig);
    rig.clock.advance({ days: 7, minutes: 1 });
    const { userId } = await rig.fakes.auth.createUser('late-binder@brightside-plumbing.example');
    const intercepted = interceptBefore(getDb(), /from accounts where id = \$1 for no key update/, async (handle) => {
      await handle.query(`insert into users (auth_user_id, account_id, email) values ($1, $2, 'late-binder@brightside-plumbing.example')`, [userId, accountId]);
      await handle.query(`update accounts set owner_user_id = $2 where id = $1`, [accountId, userId]);
    });
    expect(await disconnectOrphan({ ...rig.deps, db: intercepted.db }, accountId, { sleep: rig.sleep })).toBe('not_orphan');
    expect(intercepted.fired()).toBe(1);
    expect(await getDb().one(`select status from hubspot_connections where account_id = $1`, [accountId])).toEqual({ status: 'active' });
    expect((await purgeAccountIfDue(rig.deps, accountId)).status).toBe('not_due');
  });
});

describe('an orphan with an unexpired pending owner (PLAN §9.1 step 6)', () => {
  it('is kept while the pending owner is on time, and purged once pending_owner_expires_at is reached (the boundary counts as expired)', async () => {
    const accountId = await installNewPortal(rig);
    const installedAt = rig.clock.now();
    // An hour before the 7 days are up, the installer names the owner (magic link sent, valid 1 day).
    rig.clock.set(at(installedAt, 7 * DAY - HOUR));
    const expiresAt = at(rig.clock.now(), DAY);
    await getDb().query(`update accounts set pending_owner_email = 'mid-signup@brightside-plumbing.example', pending_owner_expires_at = $2 where id = $1`, [
      accountId,
      expiresAt,
    ]);

    rig.clock.set(at(installedAt, 7 * DAY + MINUTE));
    expect(await runDaily(rig, accountId)).toMatchObject({ orphan: 'not_orphan', purge: { status: 'not_due' } });
    expect(rig.hubspot.isInstalled()).toBe(true);
    expect(await getDb().one(`select status from hubspot_connections where account_id = $1`, [accountId])).toEqual({ status: 'active' });

    rig.clock.set(at(expiresAt, -1));
    expect(await runDaily(rig, accountId)).toMatchObject({ orphan: 'not_orphan', purge: { status: 'not_due' } });
    expect(rig.hubspot.isInstalled()).toBe(true);

    rig.clock.set(expiresAt);
    expect(await runDaily(rig, accountId)).toMatchObject({ orphan: 'disconnected', purge: { status: 'purged' } });
    expect(rig.hubspot.isInstalled()).toBe(false);
    expect((await accountRowCounts(getDb(), accountId)).accounts).toBe(0);
  });
});

describe('the tombstone reconcile failure paths', () => {
  async function tombstoned(status: 'created' | 'authenticated'): Promise<string> {
    const sub = await rig.billing.createSubscription({
      planId: rig.deps.env.RAZORPAY_PLAN_ID,
      totalCount: 120,
      quantity: 1,
      customerNotify: true,
      startAt: at(rig.clock.now(), 10 * DAY),
      expireBy: at(rig.clock.now(), 7 * DAY),
      notes: {},
    });
    if (status === 'authenticated') rig.billing.authenticate(sub.id);
    rig.billing.takeWebhooks();
    await getDb().query(`insert into billing_tombstones (provider_subscription_id, last_status, expire_by, purged_at) values ($1, 'created', $2, $3)`, [
      sub.id,
      sub.expireBy ?? null,
      at(rig.clock.now(), -DAY),
    ]);
    return sub.id;
  }

  it('a live tombstoned subscription whose cancel fails stays unresolved, alerted, and comes back the next run', async () => {
    const id = await tombstoned('authenticated');
    rig.billing.injectFailure('cancelSubscription', 'permanent');
    expect(await reconcileBillingTombstones(rig.deps)).toMatchObject({ checked: 1, failed: 1, cancelled: 0, resolved: 0 });
    expect(await tombstone(id)).toEqual({ last_status: 'authenticated', resolved_at: null, last_checked_at: rig.clock.now() });
    expect(alertCodes(rig)).toContain('billing_tombstone_cancel_failed');

    rig.clock.advance({ days: 1 });
    expect(await reconcileBillingTombstones(rig.deps)).toMatchObject({ checked: 1, cancelled: 1 });
    expect((await rig.billing.fetchSubscription(id)).status).toBe('cancelled');
    expect((await tombstone(id))?.resolved_at).not.toBeNull();
  });

  it('a config error stops the run after one row with exactly one alert, the other rows untouched', async () => {
    const ids = [await tombstoned('created'), await tombstoned('created'), await tombstoned('created')];
    rig.billing.injectFailure('fetchSubscription', 'config');
    expect(await reconcileBillingTombstones(rig.deps)).toEqual({ checked: 1, resolved: 0, cancelled: 0, open: 0, failed: 1, stopped: true, deferred: 2 });
    expect(alertCodes(rig)).toEqual(['billing_tombstone_reconcile_config']);
    for (const id of ids) expect(await tombstone(id)).toMatchObject({ last_status: 'created', last_checked_at: null, resolved_at: null });
  });
});

describe('the daily cron with a slow Razorpay (D-82)', () => {
  it('schedules every account_daily job first, and the tombstone reconcile stops at its time budget', async () => {
    const account = await seedInstalledAccount(rig);
    const ids: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const sub = await rig.billing.createSubscription({
        planId: rig.deps.env.RAZORPAY_PLAN_ID,
        totalCount: 120,
        quantity: 1,
        customerNotify: true,
        expireBy: at(rig.clock.now(), 7 * DAY),
        notes: {},
      });
      ids.push(sub.id);
      await getDb().query(`insert into billing_tombstones (provider_subscription_id, last_status, purged_at) values ($1, 'created', $2)`, [sub.id, at(rig.clock.now(), -DAY)]);
    }
    // Every read takes 30 s (each call is bounded at 8 s in live mode; the budget is what matters).
    const slow = new Proxy(rig.billing, {
      get(object, property, receiver) {
        const value: unknown = Reflect.get(object, property, receiver);
        if (typeof value !== 'function') return value;
        const fn = (value as (...args: unknown[]) => unknown).bind(object);
        if (property !== 'fetchSubscription') return fn;
        return async (...args: unknown[]) => {
          rig.clock.advance({ seconds: 30 });
          return fn(...args);
        };
      },
    });
    const summary = await runDailyCron({ ...rig.deps, billing: slow });
    expect(summary).toMatchObject({ status: 'ran', errors: 0, jobs: { accounts: 1, created: 1 }, tombstones: { checked: 4, deferred: 16, stopped: false } });
    expect(await getDb().query(`select account_id from scheduled_jobs where kind = 'account_daily'`)).toEqual([{ account_id: account.accountId }]);
    // The rows left keep their place (never checked: first tomorrow).
    const unchecked = await getDb().one<{ n: number }>(`select count(*)::int as n from billing_tombstones where last_checked_at is null`);
    expect(unchecked.n).toBe(16);
  });
});

describe('fake mode: the dev outbox follows the account (law 4, D-82)', () => {
  it('the purge deletes the outbox copies of the account’s emails (by lead, or to its own addresses), and nobody else’s', async () => {
    const db = getDb();
    const account = await seedInstalledAccount(rig);
    // Another account sharing the seeded alert address (owner@example.com), with its own owner.
    const other = await seedAccount(db, { now: rig.clock.now() });
    await seedSettings(db, { accountId: other, now: rig.clock.now() });
    await seedOwner(db, other, 'someone-else@okafor-bakery.example');
    const lead = await db.one<{ id: string }>(
      `insert into leads (account_id, hubspot_contact_id, form_id, submitted_at, intake_trigger, received_at) values ($1, '9001', 'form-1', $2, 'webhook', $2) returning id`,
      [account.accountId, rig.clock.now()],
    );
    const mail = (to: string[], subject: string, lead: string | null) =>
      db.query(`insert into fake.dev_outbox (created_at, "to", subject, html, text, kind, meta) values ($1, $2, $3, '<p>x</p>', 'x', 'new_lead', $4)`, [
        rig.clock.now(),
        to,
        subject,
        { lead },
      ]);
    await mail(['alerts@shared-inbox.example'], 'lead email for the account', lead.id);
    await mail(['owner@brightside-plumbing.example'], 'magic link to the owner', null);
    await mail(['owner@example.com'], 'to a shared alert address', null);
    await mail(['someone-else@okafor-bakery.example'], 'another account', null);
    await revokeNow(rig, account.accountId);
    rig.clock.advance({ days: 30, minutes: 1 });
    expect(await purgeAccountIfDue(rig.deps, account.accountId)).toMatchObject({ status: 'purged' });
    // owner@example.com is the seeded alert address of both accounts: kept for the other one.
    expect((await db.query<{ subject: string }>(`select subject from fake.dev_outbox order by subject`)).map((row) => row.subject)).toEqual([
      'another account',
      'to a shared alert address',
    ]);
  });
});
