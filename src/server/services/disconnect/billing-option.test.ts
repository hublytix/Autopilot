import { describe, expect, it } from 'vitest';
import type { SubscriptionStatus } from '@/server/domain/types';
import type { SubscriptionRow } from '@/server/services/billing/rows';
import { disconnectBillingOption } from './billing-option';

// The Disconnect dialog's billing choice (PLAN §7.5, §9.1 step 5, D-48): offered only from
// `authenticated`/`active`; `paused`/`pending`/`halted` are explained; ended or unfinished ones
// leave nothing to cancel.

const T = new Date('2026-10-06T14:00:00.000Z');
let n = 0;

function row(status: SubscriptionStatus, extra: Partial<SubscriptionRow> = {}): SubscriptionRow {
  n += 1;
  return {
    id: `row-${n}`,
    accountId: 'acct',
    providerSubscriptionId: `sub_${n}`,
    planId: 'plan_x',
    status,
    statusChangedAt: T,
    shortUrl: null,
    startAt: null,
    expireBy: null,
    currentStart: null,
    currentEnd: null,
    paymentFailedAt: null,
    graceUntil: null,
    cancelAtCycleEnd: false,
    lastSyncedAt: null,
    createdAt: new Date(T.getTime() + n),
    ...extra,
  };
}

describe('disconnectBillingOption', () => {
  it('offers the cancel for authenticated (with the first payment date) and active (with the period end)', () => {
    const start = new Date('2026-10-20T14:00:00.000Z');
    expect(disconnectBillingOption([row('authenticated', { startAt: start })])).toEqual({ type: 'cancellable', status: 'authenticated', firstPaymentAt: start, periodEndsAt: null });
    const end = new Date('2026-11-20T14:00:00.000Z');
    expect(disconnectBillingOption([row('active', { currentEnd: end })])).toEqual({ type: 'cancellable', status: 'active', periodEndsAt: end, firstPaymentAt: null });
  });

  it.each(['paused', 'pending', 'halted', 'unknown'] as const)('explains %s instead of offering it', (status) => {
    expect(disconnectBillingOption([row(status)])).toEqual({ type: 'not_cancellable', status });
  });

  it('an active subscription already set to end says so', () => {
    const end = new Date('2026-11-20T14:00:00.000Z');
    expect(disconnectBillingOption([row('active', { cancelAtCycleEnd: true, currentEnd: end })])).toEqual({ type: 'already_cancelled', endsAt: end });
  });

  it.each(['created', 'stale', 'cancelled', 'completed', 'expired'] as const)('%s leaves nothing to cancel', (status) => {
    expect(disconnectBillingOption([row(status)])).toEqual({ type: 'none' });
  });

  it('no subscription: nothing to cancel', () => {
    expect(disconnectBillingOption([])).toEqual({ type: 'none' });
  });

  it('a cancellable row wins over a stuck one; the newest of each kind is used', () => {
    expect(disconnectBillingOption([row('paused'), row('authenticated'), row('cancelled')])).toMatchObject({ type: 'cancellable', status: 'authenticated' });
    expect(disconnectBillingOption([row('pending'), row('halted')])).toEqual({ type: 'not_cancellable', status: 'halted' });
  });
});
