import { describe, expect, it } from 'vitest';
import {
  appliedStatus,
  checkoutGuard,
  checkoutTiming,
  graceAfter,
  isReusableCheckout,
  isUsableCheckoutLink,
  mapRazorpayStatus,
  type CheckoutConfig,
  type GuardRow,
} from './checkout-guard';
import { SUBSCRIPTION_STATUSES, type SubscriptionStatus } from './types';

// The pure billing rules (PLAN §9.9, §12 "domain/checkout-guard.test.ts", D-18, D-20, D-82),
// table-driven: the checkout guard over every status, the reuse rule's boundaries, the
// start_at/expire_by rule, the status mapping and the grace.

const NOW = new Date('2026-10-08T12:00:00.000Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const CONFIG: CheckoutConfig = { planId: 'plan_fakeonly', appUrl: 'http://localhost:3000' };
const LINK = 'https://rzp.io/rzp/Dqdqx3h';

function row(status: SubscriptionStatus, overrides: Partial<GuardRow> = {}): GuardRow {
  return {
    id: `id-${status}`,
    planId: 'plan_fakeonly',
    status,
    shortUrl: LINK,
    startAt: null,
    expireBy: new Date(NOW.getTime() + DAY),
    createdAt: new Date(NOW.getTime() - DAY),
    ...overrides,
  };
}

describe('checkoutGuard (D-18)', () => {
  const table: readonly [SubscriptionStatus, 'blocked' | 'reuse' | 'create'][] = [
    ['authenticated', 'blocked'],
    ['active', 'blocked'],
    ['pending', 'blocked'],
    ['halted', 'blocked'],
    ['paused', 'blocked'],
    ['unknown', 'blocked'],
    ['created', 'reuse'],
    ['expired', 'create'],
    ['cancelled', 'create'],
    ['completed', 'create'],
    ['stale', 'create'],
  ];

  it.each(table)('a %s subscription → %s', (status, expected) => {
    expect(checkoutGuard([row(status)], NOW, CONFIG).type).toBe(expected);
  });

  it('covers every stored status', () => {
    expect(new Set(table.map(([status]) => status))).toEqual(new Set(SUBSCRIPTION_STATUSES));
  });

  it('creates when there is no subscription at all', () => {
    expect(checkoutGuard([], NOW, CONFIG)).toEqual({ type: 'create', recheck: [] });
  });

  it('blocks on a live row even when a newer row is not live, and names its status', () => {
    const decision = checkoutGuard([row('halted', { createdAt: new Date(NOW.getTime() - 9 * DAY) }), row('cancelled')], NOW, CONFIG);
    expect(decision).toMatchObject({ type: 'blocked', row: { status: 'halted' } });
  });

  it('re-checks a created row it cannot reuse before creating', () => {
    const expired = row('created', { expireBy: NOW });
    expect(checkoutGuard([expired, row('cancelled')], NOW, CONFIG)).toEqual({ type: 'create', recheck: [expired] });
  });
});

describe('isReusableCheckout (PLAN §9.9 step 3)', () => {
  it('reuses while expire_by is in the future and start_at is null or in the future', () => {
    expect(isReusableCheckout(row('created'), NOW, CONFIG)).toBe(true);
    expect(isReusableCheckout(row('created', { startAt: new Date(NOW.getTime() + 1) }), NOW, CONFIG)).toBe(true);
  });

  it('stops at expire_by and at start_at exactly', () => {
    expect(isReusableCheckout(row('created', { expireBy: NOW }), NOW, CONFIG)).toBe(false);
    expect(isReusableCheckout(row('created', { expireBy: new Date(NOW.getTime() + 1) }), NOW, CONFIG)).toBe(true);
    expect(isReusableCheckout(row('created', { startAt: NOW }), NOW, CONFIG)).toBe(false);
  });

  it('needs a created row, the configured plan, an expiry and a usable link', () => {
    expect(isReusableCheckout(row('stale'), NOW, CONFIG)).toBe(false);
    expect(isReusableCheckout(row('created', { planId: 'plan_older' }), NOW, CONFIG)).toBe(false);
    expect(isReusableCheckout(row('created', { expireBy: null }), NOW, CONFIG)).toBe(false);
    expect(isReusableCheckout(row('created', { shortUrl: null }), NOW, CONFIG)).toBe(false);
    expect(isReusableCheckout(row('created', { shortUrl: 'javascript:alert(1)' }), NOW, CONFIG)).toBe(false);
  });
});

describe('isUsableCheckoutLink', () => {
  it.each([
    [LINK, true],
    ['https://api.razorpay.com/v1/t/subscriptions/x', true],
    ['http://localhost:3000/dev/fake-checkout/sub_X', true],
    ['http://rzp.io/i/x', false],
    ['javascript:alert(1)', false],
    ['data:text/html,x', false],
    ['https://user:pass@rzp.io/i/x', false],
    ['/dev/fake-checkout/sub_X', false],
    ['', false],
  ] as const)('%s → %s', (link, ok) => {
    expect(isUsableCheckoutLink(link, CONFIG.appUrl)).toBe(ok);
  });
});

describe('checkoutTiming (D-20)', () => {
  it('starts at the trial end with more than a day of trial left; the link lasts 7 days at most', () => {
    const trialEndsAt = new Date(NOW.getTime() + 12 * DAY + 123);
    const timing = checkoutTiming(trialEndsAt, NOW);
    expect(timing.startAt).toEqual(new Date(NOW.getTime() + 12 * DAY));
    expect(timing.expireBy).toEqual(new Date(NOW.getTime() + 7 * DAY));
  });

  it('ends the link 60 s before start_at when the trial ends within 7 days', () => {
    const trialEndsAt = new Date(NOW.getTime() + 3 * DAY);
    expect(checkoutTiming(trialEndsAt, NOW)).toEqual({ startAt: trialEndsAt, expireBy: new Date(trialEndsAt.getTime() - MIN) });
  });

  it('has no start_at with exactly one day (or less) of trial left, or none at all', () => {
    for (const left of [DAY, DAY - 1, MIN, 0, -5 * DAY]) {
      expect(checkoutTiming(new Date(NOW.getTime() + left), NOW)).toEqual({ startAt: null, expireBy: new Date(NOW.getTime() + 7 * DAY) });
    }
  });

  it('starts at the trial end just over the one-day boundary, the link still in the future', () => {
    const trialEndsAt = new Date(NOW.getTime() + DAY + 1000);
    const timing = checkoutTiming(trialEndsAt, NOW);
    expect(timing.startAt).toEqual(trialEndsAt);
    expect(timing.expireBy.getTime()).toBe(trialEndsAt.getTime() - MIN);
    expect(timing.expireBy.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('uses whole seconds, as Razorpay stores them', () => {
    const odd = new Date(NOW.getTime() + 999);
    const timing = checkoutTiming(new Date(odd.getTime() + 5 * DAY), odd);
    expect(timing.startAt?.getTime()).toBe(Math.floor((odd.getTime() + 5 * DAY) / 1000) * 1000);
    expect(timing.expireBy.getTime() % 1000).toBe(0);
  });
});

describe('mapRazorpayStatus (D-18, RZP-SUB-STATUSES)', () => {
  it('keeps the nine documented statuses and maps resumed to active', () => {
    for (const status of ['created', 'authenticated', 'active', 'pending', 'halted', 'cancelled', 'completed', 'expired', 'paused'] as const) {
      expect(mapRazorpayStatus(status)).toEqual({ status, known: true });
    }
    expect(mapRazorpayStatus('resumed')).toEqual({ status: 'active', known: true });
  });

  it('stores an undocumented status as the local unknown (it may hold a mandate), flagged unknown', () => {
    for (const raw of ['suspended', 'on_hold', 'ACTIVE', '', 'stale', 'unknown']) expect(mapRazorpayStatus(raw)).toEqual({ status: 'unknown', known: false });
  });
});

describe('appliedStatus', () => {
  it('takes what Razorpay says, except that a row never goes back to created', () => {
    expect(appliedStatus('created', 'created')).toBe('created');
    expect(appliedStatus('stale', 'created')).toBe('stale');
    expect(appliedStatus('expired', 'created')).toBe('expired');
    expect(appliedStatus('unknown', 'created')).toBe('stale');
    expect(appliedStatus('stale', 'authenticated')).toBe('authenticated');
    expect(appliedStatus('unknown', 'active')).toBe('active');
    expect(appliedStatus('active', 'unknown')).toBe('unknown');
  });
});

describe('graceAfter (D-18, D-82)', () => {
  const failedAt = new Date(NOW.getTime() - 2 * DAY);
  const activeSince = new Date(NOW.getTime() - 20 * DAY);

  it('starts the grace at the first pending event, three days long', () => {
    expect(graceAfter({ status: 'active', paymentFailedAt: null, graceUntil: null, statusChangedAt: activeSince }, 'pending', failedAt, NOW)).toEqual({
      paymentFailedAt: failedAt,
      graceUntil: new Date(failedAt.getTime() + 3 * DAY),
    });
  });

  it('without a pending event, starts it when we learnt of the failure', () => {
    expect(graceAfter({ status: 'active', paymentFailedAt: null, graceUntil: null, statusChangedAt: activeSince }, 'pending', null, NOW)).toEqual({
      paymentFailedAt: NOW,
      graceUntil: new Date(NOW.getTime() + 3 * DAY),
    });
  });

  it('keeps the first failure across repeated pending events, and moves back for an earlier one delivered late', () => {
    const previous = { status: 'pending' as const, paymentFailedAt: failedAt, graceUntil: new Date(failedAt.getTime() + 3 * DAY), statusChangedAt: failedAt };
    expect(graceAfter(previous, 'pending', new Date(failedAt.getTime() + DAY), NOW).paymentFailedAt).toEqual(failedAt);
    const earlier = new Date(failedAt.getTime() - 5 * MIN);
    expect(graceAfter(previous, 'pending', earlier, NOW)).toEqual({ paymentFailedAt: earlier, graceUntil: new Date(earlier.getTime() + 3 * DAY) });
  });

  it('ignores an old episode pending event delivered late when the row comes from another status', () => {
    // Episode 1 (25 days ago) ended with `active` 20 days ago; the new failure is minutes old.
    const oldEpisode = new Date(NOW.getTime() - 25 * DAY);
    const previous = { status: 'active' as const, paymentFailedAt: null, graceUntil: null, statusChangedAt: activeSince };
    expect(graceAfter(previous, 'pending', oldEpisode, NOW)).toEqual({ paymentFailedAt: NOW, graceUntil: new Date(NOW.getTime() + 3 * DAY) });
    // An event at or after the row's last change counts (the boundary is inclusive).
    expect(graceAfter(previous, 'pending', activeSince, NOW).paymentFailedAt).toEqual(activeSince);
  });

  it('ignores an old episode pending event delivered late while the new episode is pending', () => {
    // We learnt of the new failure 10 minutes ago (no event yet), then episode 1's event arrives.
    const learnt = new Date(NOW.getTime() - 10 * MIN);
    const previous = { status: 'pending' as const, paymentFailedAt: learnt, graceUntil: new Date(learnt.getTime() + 3 * DAY), statusChangedAt: learnt };
    expect(graceAfter(previous, 'pending', new Date(NOW.getTime() - 25 * DAY), NOW).paymentFailedAt).toEqual(learnt);
    // The new episode's own first event (a retry cycle earlier than we learnt) still moves it back.
    const ownFirst = new Date(learnt.getTime() - 3 * DAY);
    expect(graceAfter(previous, 'pending', ownFirst, NOW).paymentFailedAt).toEqual(ownFirst);
    expect(graceAfter(previous, 'pending', new Date(ownFirst.getTime() - 1000), NOW).paymentFailedAt).toEqual(learnt);
  });

  it('clears both on active and keeps them on any other status', () => {
    const previous = { status: 'pending' as const, paymentFailedAt: failedAt, graceUntil: NOW, statusChangedAt: failedAt };
    expect(graceAfter(previous, 'active', null, NOW)).toEqual({ paymentFailedAt: null, graceUntil: null });
    expect(graceAfter(previous, 'halted', null, NOW)).toEqual({ paymentFailedAt: failedAt, graceUntil: NOW });
  });
});
