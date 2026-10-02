import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '@/server/db';

// Named leases on the `leases` table (PLAN §5, D-16, D-28 rule 4): the poll cron's global lease and
// pollPortal's per-account lease. Each acquire, renew and release is one compare-and-set statement,
// so two callers can never both hold a lease, and a crashed holder's lease simply expires. Time comes
// from the caller's `$now` (Clock); SQL never reads the clock.

export interface Lease {
  readonly name: string;
  /** A random id per acquisition: only this holder can renew or release the lease. */
  readonly holder: string;
  readonly expiresAt: Date;
}

export interface AcquireLeaseInput {
  name: string;
  ttlMs: number;
  /** `$now`. */
  now: Date;
}

/** The lease names in use. */
export const LeaseNames = {
  /** The poll cron (`/api/cron/poll`): one run at a time (TTL 6 min, longer than maxDuration). */
  pollCron: 'poll',
  /** pollPortal for one account: the cron and the webhook-triggered portal_poll jobs never overlap. */
  accountPoll: (accountId: string): string => `poll:${accountId}`,
  /** The daily maintenance cron (`/api/cron/daily`): one run at a time (TTL 6 min). */
  dailyCron: 'daily',
} as const;

const leaseRowSchema = z.object({ name: z.string(), holder: z.string(), expires_at: z.date() });

function toLease(raw: unknown): Lease {
  const row = leaseRowSchema.parse(raw);
  return { name: row.name, holder: row.holder, expiresAt: row.expires_at };
}

function assertTtl(ttlMs: number): void {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new RangeError('lease_invalid_ttl');
}

/**
 * Takes the lease when it is free or expired. Returns the lease, or null while someone else holds
 * an unexpired one.
 */
export async function acquireLease(db: Db, input: AcquireLeaseInput): Promise<Lease | null> {
  assertTtl(input.ttlMs);
  const holder = randomUUID();
  const expiresAt = new Date(input.now.getTime() + input.ttlMs);
  const raw = await db.maybeOne(
    `insert into leases (name, holder, expires_at) values ($1, $2, $3)
     on conflict (name) do update set holder = excluded.holder, expires_at = excluded.expires_at
       where leases.expires_at <= $4
     returning name, holder, expires_at`,
    [input.name, holder, expiresAt, input.now],
  );
  return raw === null ? null : toLease(raw);
}

/** Extends a lease this holder still holds (unexpired). Null when it was lost. */
export async function renewLease(db: Db, lease: Lease, input: { ttlMs: number; now: Date }): Promise<Lease | null> {
  assertTtl(input.ttlMs);
  const raw = await db.maybeOne(
    `update leases set expires_at = $3
      where name = $1 and holder = $2 and expires_at > $4
      returning name, holder, expires_at`,
    [lease.name, lease.holder, new Date(input.now.getTime() + input.ttlMs), input.now],
  );
  return raw === null ? null : toLease(raw);
}

/** Gives the lease up. False when it had already expired and been taken by someone else. */
export async function releaseLease(db: Db, lease: Lease): Promise<boolean> {
  const rows = await db.query(`delete from leases where name = $1 and holder = $2 returning name`, [lease.name, lease.holder]);
  return rows.length > 0;
}

export type LeaseRun<T> = { readonly acquired: true; readonly value: T } | { readonly acquired: false };

/**
 * Runs `fn` while holding the lease, and releases it afterwards (also when `fn` throws). Returns
 * `{acquired: false}` without running `fn` when the lease is held elsewhere.
 */
export async function withLease<T>(db: Db, input: AcquireLeaseInput, fn: (lease: Lease) => Promise<T>): Promise<LeaseRun<T>> {
  const lease = await acquireLease(db, input);
  if (lease === null) return { acquired: false };
  try {
    return { acquired: true, value: await fn(lease) };
  } finally {
    await releaseLease(db, lease).catch(() => false);
  }
}
