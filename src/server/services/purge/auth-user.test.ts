import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransientError } from '@/server/domain/errors';
import { seedAccount } from '@/server/jobs/testing';
import type { Deps } from '@/server/ports';
import { seedOwner } from '@/server/services/accounts/testing';
import { retryAuthUserDeletions } from '@/server/services/auth/auth-user-deletion';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import { createRetentionRig, DAY, type RetentionRig } from '../../../../test/retention/support';
import { deletePurgedAuthUser } from './auth-user';
import { loadPurgeState } from './eligibility';

// The purge's guarded auth-user delete (PLAN §9.1 step 6, §9.10 step 5, D-35, D-48, D-62, D-82),
// clause by clause: an admin's address, another account's users row by address alone, another
// unbound install's unexpired pending owner email (and the boundary at its expiry), another
// account's owner or pending id, no reference at all, and an address we no longer store (a
// branch-(b) reinstall) read from the AuthProvider. Removing any clause makes one case fail. A user
// kept for another install's pending owner is queued and deleted once that reference lapses.

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

const ADDRESS = 'pending.owner@brightside-plumbing.example';

function exists(userId: string): boolean {
  return rig.fakes.auth.users().some((user) => user.userId === userId);
}

/** An unbound account whose email step created `userId` for `address` (`address` null: a branch-(b) reinstall cleared it). */
async function unboundAccountPendingOn(userId: string, address: string | null): Promise<string> {
  const db = getDb();
  const now = rig.clock.now();
  const accountId = await seedAccount(db, { now, processingState: 'onboarding' });
  await db.query(`update accounts set pending_owner_auth_user_id = $2, pending_owner_email = $3, pending_owner_expires_at = $4 where id = $1`, [
    accountId,
    userId,
    address,
    address === null ? null : new Date(now.getTime() + DAY),
  ]);
  return accountId;
}

async function purgeAuthUserOf(accountId: string) {
  const state = await loadPurgeState(getDb(), accountId, rig.clock.now());
  if (state === null) throw new Error('account missing');
  return deletePurgedAuthUser(rig.deps, state);
}

async function queued(): Promise<string[]> {
  return (await getDb().query<{ auth_user_id: string }>(`select auth_user_id from auth_user_deletions order by auth_user_id`)).map((row) => row.auth_user_id);
}

describe('deletePurgedAuthUser: what keeps a pending auth user', () => {
  it('(a) an ADMIN_EMAILS address is never deleted', async () => {
    const admin = rig.deps.env.ADMIN_EMAILS[0] ?? '';
    expect(admin).not.toBe('');
    const { userId } = await rig.fakes.auth.createUser(admin);
    const accountId = await unboundAccountPendingOn(userId, admin.toUpperCase());
    expect(await purgeAuthUserOf(accountId)).toBe('kept');
    expect(exists(userId)).toBe(true);
    expect(await queued()).toEqual([]);
  });

  it('(b) another account’s users row with the same address (different case, different auth id) keeps it', async () => {
    const { userId } = await rig.fakes.auth.createUser(ADDRESS);
    const accountId = await unboundAccountPendingOn(userId, ADDRESS);
    const other = await seedAccount(getDb(), { now: rig.clock.now() });
    await seedOwner(getDb(), other, ADDRESS.toUpperCase(), '0b0b0b0b-0000-4000-8000-000000000001');
    expect(await purgeAuthUserOf(accountId)).toBe('kept');
    expect(exists(userId)).toBe(true);
  });

  it('(c) another unbound install whose pending owner email is the address keeps it until that expires (the boundary counts as expired)', async () => {
    const { userId } = await rig.fakes.auth.createUser(ADDRESS);
    const accountId = await unboundAccountPendingOn(userId, ADDRESS);
    const other = await seedAccount(getDb(), { now: rig.clock.now(), processingState: 'onboarding' });
    const expiresAt = new Date(rig.clock.now().getTime() + 2 * 60 * 60 * 1000);
    await getDb().query(`update accounts set owner_user_id = null, pending_owner_email = $2, pending_owner_expires_at = $3 where id = $1`, [other, ADDRESS.toUpperCase(), expiresAt]);
    expect(await purgeAuthUserOf(accountId)).toBe('kept');
    expect(exists(userId)).toBe(true);
    // Kept for now only: queued for the daily retry.
    expect(await queued()).toEqual([userId]);

    rig.clock.set(expiresAt);
    expect(await purgeAuthUserOf(accountId)).toBe('deleted');
    expect(exists(userId)).toBe(false);
  });

  it('(d) with no reference at all it is deleted', async () => {
    const { userId } = await rig.fakes.auth.createUser(ADDRESS);
    const accountId = await unboundAccountPendingOn(userId, ADDRESS);
    expect(await purgeAuthUserOf(accountId)).toBe('deleted');
    expect(exists(userId)).toBe(false);
    expect(await queued()).toEqual([]);
  });

  it('(e) another account that lists it as owner or as its pending user keeps it', async () => {
    const { userId } = await rig.fakes.auth.createUser(ADDRESS);
    const accountId = await unboundAccountPendingOn(userId, ADDRESS);
    const other = await seedAccount(getDb(), { now: rig.clock.now(), processingState: 'onboarding' });
    await getDb().query(`update accounts set pending_owner_auth_user_id = $2 where id = $1`, [other, userId]);
    expect(await purgeAuthUserOf(accountId)).toBe('kept');
    await getDb().query(`update accounts set pending_owner_auth_user_id = null, owner_user_id = $2 where id = $1`, [other, userId]);
    expect(await purgeAuthUserOf(accountId)).toBe('kept');
    expect(exists(userId)).toBe(true);
  });

  it('(f) an address we no longer store (branch-(b) reinstall) is read from the AuthProvider, so the address checks still run (D-82)', async () => {
    const { userId } = await rig.fakes.auth.createUser(ADDRESS);
    // A reinstall cleared the pending email but kept the user's id; another install now waits on that address.
    const accountId = await unboundAccountPendingOn(userId, null);
    const other = await seedAccount(getDb(), { now: rig.clock.now(), processingState: 'onboarding' });
    await getDb().query(`update accounts set owner_user_id = null, pending_owner_email = $2, pending_owner_expires_at = $3 where id = $1`, [
      other,
      ADDRESS,
      new Date(rig.clock.now().getTime() + DAY),
    ]);
    expect(await purgeAuthUserOf(accountId)).toBe('kept');
    expect(exists(userId)).toBe(true);
    // The purge then deletes the account; once that install's pending owner has expired unbound,
    // the daily retry deletes the user.
    await getDb().query(`delete from accounts where id = $1`, [accountId]);
    rig.clock.advance({ days: 1, minutes: 1 });
    expect(await retryAuthUserDeletions(rig.deps)).toMatchObject({ checked: 1, deleted: 1 });
    expect(exists(userId)).toBe(false);
    expect(await queued()).toEqual([]);
  });

  it('a user that is already gone counts as deleted', async () => {
    const accountId = await unboundAccountPendingOn('0c0c0c0c-0000-4000-8000-000000000002', null);
    expect(await purgeAuthUserOf(accountId)).toBe('deleted');
  });
});

describe('retryAuthUserDeletions (the daily queue)', () => {
  it('keeps waiting while another install is pending on it, drops it once it is someone’s owner, and retries a failed delete', async () => {
    const db = getDb();
    const now = rig.clock.now();
    const { userId: claimed } = await rig.fakes.auth.createUser('claimed@brightside-plumbing.example');
    const { userId: waiting } = await rig.fakes.auth.createUser('waiting@brightside-plumbing.example');
    await db.query(`insert into auth_user_deletions (auth_user_id, requested_at) values ($1, $3), ($2, $3)`, [claimed, waiting, now]);
    const owned = await seedAccount(db, { now });
    await seedOwner(db, owned, 'claimed@brightside-plumbing.example', claimed);
    const pending = await seedAccount(db, { now, processingState: 'onboarding' });
    await db.query(`update accounts set owner_user_id = null, pending_owner_email = 'waiting@brightside-plumbing.example', pending_owner_expires_at = $2 where id = $1`, [
      pending,
      new Date(now.getTime() + DAY),
    ]);

    expect(await retryAuthUserDeletions(rig.deps)).toEqual({ checked: 2, deleted: 0, claimed: 1, waiting: 1, failed: 0, deferred: 0 });
    expect(exists(claimed)).toBe(true);
    expect(await queued()).toEqual([waiting]);

    // The pending owner expired unbound; the AuthProvider fails once, then the next day's run deletes it.
    rig.clock.advance({ days: 1, minutes: 1 });
    const failing: Deps = {
      ...rig.deps,
      auth: new Proxy(rig.deps.auth, {
        get(object, property, receiver) {
          if (property === 'deleteUser') return async () => Promise.reject(new TransientError('auth_unavailable'));
          const value: unknown = Reflect.get(object, property, receiver);
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(object) : value;
        },
      }),
    };
    expect(await retryAuthUserDeletions(failing)).toEqual({ checked: 1, deleted: 0, claimed: 0, waiting: 0, failed: 1, deferred: 0 });
    expect(await queued()).toEqual([waiting]);
    expect(exists(waiting)).toBe(true);
    rig.clock.advance({ days: 1 });
    expect(await retryAuthUserDeletions(rig.deps)).toMatchObject({ checked: 1, deleted: 1 });
    expect(exists(waiting)).toBe(false);
    expect(await queued()).toEqual([]);
  });
});
