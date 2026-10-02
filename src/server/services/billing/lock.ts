import 'server-only';
import type { Db } from '@/server/db';

// The billing action lock (PLAN §9.9 step 1, D-18): `accounts.checkout_lock_until`, taken by a
// single-statement compare-and-set for 30 seconds, so two checkouts (two tabs, a double click) never
// create two subscriptions, and a cancel or resume never races a checkout. Released by the holder
// (compare-and-set on its own value); a crashed holder's lock lapses after 30 s.

export const BILLING_LOCK_MS = 30_000;

/** The lock's expiry when taken; null when another action holds it (or the account is gone). */
export async function takeBillingLock(db: Db, accountId: string, now: Date): Promise<Date | null> {
  const until = new Date(now.getTime() + BILLING_LOCK_MS);
  const row = await db.maybeOne(
    `update accounts set checkout_lock_until = $2
      where id = $1 and (checkout_lock_until is null or checkout_lock_until <= $3)
      returning id`,
    [accountId, until, now],
  );
  return row === null ? null : until;
}

/** Releases the lock taken at `until` (never someone else's). */
export async function releaseBillingLock(db: Db, accountId: string, until: Date): Promise<void> {
  await db.query(`update accounts set checkout_lock_until = null where id = $1 and checkout_lock_until = $2`, [accountId, until]);
}

/** Runs `fn` under the lock; `busy` when it is held. The lock is released however `fn` ends. */
export async function withBillingLock<T>(db: Db, accountId: string, now: Date, fn: () => Promise<T>): Promise<{ readonly type: 'done'; readonly value: T } | { readonly type: 'busy' }> {
  const until = await takeBillingLock(db, accountId, now);
  if (until === null) return { type: 'busy' };
  try {
    return { type: 'done', value: await fn() };
  } finally {
    await releaseBillingLock(db, accountId, until).catch(() => undefined);
  }
}
