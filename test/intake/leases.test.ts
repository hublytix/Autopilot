import { describe, expect, it } from 'vitest';
import { acquireLease, LeaseNames, releaseLease, renewLease, withLease } from '@/server/services/leases';
import { useTestDb as setUpTestDb } from '../db/harness';

// Named leases (PLAN §5 `leases`, D-16): single-statement compare-and-set acquire, renew and release.

const getDb = setUpTestDb();

const T0 = new Date('2026-10-06T14:00:00.000Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);

describe('leases', () => {
  it('lets one holder at a time take a lease until it expires', async () => {
    const first = await acquireLease(getDb(), { name: LeaseNames.pollCron, ttlMs: 60_000, now: T0 });
    expect(first).toMatchObject({ name: 'poll', expiresAt: at(60_000) });
    expect(await acquireLease(getDb(), { name: 'poll', ttlMs: 60_000, now: at(59_999) })).toBeNull();
    const second = await acquireLease(getDb(), { name: 'poll', ttlMs: 60_000, now: at(60_000) });
    expect(second?.holder).not.toBe(first?.holder);
    // The first holder lost it: it can neither renew nor release the new holder's lease.
    if (first === null || second === null) throw new Error('lease not acquired');
    expect(await renewLease(getDb(), first, { ttlMs: 60_000, now: at(60_001) })).toBeNull();
    expect(await releaseLease(getDb(), first)).toBe(false);
    expect(await renewLease(getDb(), second, { ttlMs: 120_000, now: at(61_000) })).toMatchObject({ expiresAt: at(181_000) });
    expect(await releaseLease(getDb(), second)).toBe(true);
    expect(await acquireLease(getDb(), { name: 'poll', ttlMs: 60_000, now: at(61_000) })).not.toBeNull();
  });

  it('keeps leases with different names apart', async () => {
    expect(await acquireLease(getDb(), { name: LeaseNames.accountPoll('a'), ttlMs: 60_000, now: T0 })).not.toBeNull();
    expect(await acquireLease(getDb(), { name: LeaseNames.accountPoll('b'), ttlMs: 60_000, now: T0 })).not.toBeNull();
    expect(await acquireLease(getDb(), { name: LeaseNames.accountPoll('a'), ttlMs: 60_000, now: T0 })).toBeNull();
  });

  it('withLease runs the function only while holding the lease, and releases it even when it throws', async () => {
    const input = { name: 'poll', ttlMs: 60_000, now: T0 };
    const nested = await withLease(getDb(), input, async () => withLease(getDb(), input, async () => 'inner'));
    expect(nested).toEqual({ acquired: true, value: { acquired: false } });
    await expect(withLease(getDb(), input, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await getDb().query(`select name from leases`)).toHaveLength(0);
  });

  it('refuses a non-positive TTL', async () => {
    await expect(acquireLease(getDb(), { name: 'poll', ttlMs: 0, now: T0 })).rejects.toThrow('lease_invalid_ttl');
  });
});
