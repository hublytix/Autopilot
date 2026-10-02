import { describe, expect, it } from 'vitest';
import { currentSubscription, entitled, entitlementOf, normalizeSubscriptionStatus, type SubscriptionSnapshot } from './entitlement';
import { RAZORPAY_SUBSCRIPTION_STATUSES, SUBSCRIPTION_STATUSES } from './types';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const trialOver = { trialEndsAt: new Date(NOW.getTime() - DAY) };
const inTrial = { trialEndsAt: new Date(NOW.getTime() + DAY) };

function sub(status: string, overrides: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot {
  return { id: 'sub-1', status, graceUntil: null, createdAt: new Date(NOW.getTime() - 10 * DAY), ...overrides };
}

describe('entitled (D-18) after the trial', () => {
  const table: readonly [string, boolean][] = [
    ['created', false],
    ['authenticated', true],
    ['active', true],
    ['pending', false], // no grace_until
    ['halted', false],
    ['cancelled', false],
    ['completed', false],
    ['expired', false],
    ['paused', false],
    ['stale', false],
    ['unknown', false],
    ['resumed', true],
    ['some_new_status', false],
    ['', false],
  ];

  it.each(table)('status %s → entitled %s', (status, expected) => {
    expect(entitled(trialOver, sub(status), NOW)).toBe(expected);
  });

  it('covers every Razorpay status and the local stale and unknown statuses', () => {
    const covered = new Set(table.map(([status]) => status));
    for (const status of SUBSCRIPTION_STATUSES) expect(covered.has(status)).toBe(true);
    expect(RAZORPAY_SUBSCRIPTION_STATUSES).toHaveLength(9);
  });

  it('is not entitled with no subscription at all', () => {
    expect(entitlementOf(trialOver, null, NOW)).toEqual({ entitled: false, reason: 'no_subscription' });
  });

  it('reports an unknown status separately so the caller can alert the admin', () => {
    expect(entitlementOf(trialOver, sub('suspended'), NOW)).toEqual({ entitled: false, reason: 'unknown_status' });
    expect(entitlementOf(trialOver, sub('halted'), NOW)).toEqual({ entitled: false, reason: 'inactive_subscription' });
  });
});

describe('entitled during the trial', () => {
  it.each([...SUBSCRIPTION_STATUSES, 'unknown_thing'])('is entitled whatever the subscription says (%s)', (status) => {
    expect(entitlementOf(inTrial, sub(status), NOW)).toEqual({ entitled: true, reason: 'trial' });
  });

  it('is entitled with no subscription', () => {
    expect(entitled(inTrial, null, NOW)).toBe(true);
  });

  it('ends exactly at trial_ends_at', () => {
    const endsNow = { trialEndsAt: NOW };
    expect(entitled(endsNow, null, new Date(NOW.getTime() - 1))).toBe(true);
    expect(entitled(endsNow, null, NOW)).toBe(false);
  });
});

describe('pending grace boundaries', () => {
  const graceUntil = new Date(NOW.getTime() + 3 * DAY);

  it('is entitled strictly before grace_until', () => {
    const pending = sub('pending', { graceUntil });
    expect(entitlementOf(trialOver, pending, new Date(graceUntil.getTime() - 1))).toEqual({ entitled: true, reason: 'grace' });
    expect(entitled(trialOver, pending, graceUntil)).toBe(false);
    expect(entitled(trialOver, pending, new Date(graceUntil.getTime() + 1))).toBe(false);
  });

  it('gives no grace to other statuses that carry a grace_until', () => {
    expect(entitled(trialOver, sub('halted', { graceUntil }), NOW)).toBe(false);
    expect(entitled(trialOver, sub('paused', { graceUntil }), NOW)).toBe(false);
  });
});

describe('normalizeSubscriptionStatus', () => {
  it('maps resumed to active and keeps every known status', () => {
    expect(normalizeSubscriptionStatus('resumed')).toBe('active');
    for (const status of SUBSCRIPTION_STATUSES) expect(normalizeSubscriptionStatus(status)).toBe(status);
  });

  it('returns null for an unknown status', () => {
    expect(normalizeSubscriptionStatus('ACTIVE')).toBeNull();
    expect(normalizeSubscriptionStatus('suspended')).toBeNull();
  });
});

describe('currentSubscription', () => {
  it('is null for no subscriptions', () => {
    expect(currentSubscription([])).toBeNull();
  });

  it('picks the latest logical created_at, whatever the order', () => {
    const older = sub('expired', { id: 'a', createdAt: new Date(NOW.getTime() - 5 * DAY) });
    const newer = sub('created', { id: 'b', createdAt: new Date(NOW.getTime() - DAY) });
    expect(currentSubscription([older, newer])).toBe(newer);
    expect(currentSubscription([newer, older])).toBe(newer);
  });

  it('prefers the newest row that still holds a mandate over newer rows without one (D-81)', () => {
    const older = sub('active', { id: 'a', createdAt: new Date(NOW.getTime() - 5 * DAY) });
    for (const status of ['created', 'stale', 'unknown', 'cancelled', 'expired', 'completed', 'unknown_status']) {
      const newer = sub(status, { id: 'b', createdAt: new Date(NOW.getTime() - DAY) });
      expect(currentSubscription([older, newer])).toBe(older);
      expect(currentSubscription([newer, older])).toBe(older);
    }
    // Among rows with a mandate, the newest still wins (resumed counts as active).
    for (const status of ['authenticated', 'active', 'pending', 'halted', 'paused', 'resumed']) {
      const newer = sub(status, { id: 'b', createdAt: new Date(NOW.getTime() - DAY) });
      expect(currentSubscription([older, newer])).toBe(newer);
    }
  });

  it('breaks a created_at tie by id so the result does not depend on row order', () => {
    const at = new Date(NOW.getTime() - DAY);
    const a = sub('active', { id: 'a', createdAt: at });
    const b = sub('halted', { id: 'b', createdAt: at });
    expect(currentSubscription([a, b])).toBe(b);
    expect(currentSubscription([b, a])).toBe(b);
  });

  it('decides entitlement from the current subscription only', () => {
    // The safety net cancelled the newer of two live subscriptions: the older one still pays.
    const older = sub('active', { id: 'a', createdAt: new Date(NOW.getTime() - 5 * DAY) });
    const cancelledNewer = sub('cancelled', { id: 'b', createdAt: new Date(NOW.getTime() - DAY) });
    expect(entitled(trialOver, currentSubscription([older, cancelledNewer]), NOW)).toBe(true);
    // A newer paused row (a mandate, not entitled) hides an older cancelled active one.
    const oldCancelled = sub('cancelled', { id: 'c', createdAt: new Date(NOW.getTime() - 9 * DAY) });
    const paused = sub('paused', { id: 'd', createdAt: new Date(NOW.getTime() - DAY) });
    expect(entitled(trialOver, currentSubscription([oldCancelled, paused]), NOW)).toBe(false);
  });
});
