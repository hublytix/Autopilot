import { describe, expect, it } from 'vitest';
import type { SubscriptionSnapshot } from './entitlement';
import { computeProcessingState, type ProcessingStateAccount } from './processing-state';
import { CONNECTION_STATUSES, type ConnectionStatus } from './types';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const DAY = 86_400_000;

function account(overrides: Partial<ProcessingStateAccount> = {}): ProcessingStateAccount {
  return {
    pausedAt: null,
    onboardingCompletedAt: new Date(NOW.getTime() - 20 * DAY),
    trialEndsAt: new Date(NOW.getTime() - DAY),
    ...overrides,
  };
}

const ACTIVE_SUB: SubscriptionSnapshot = { id: 's', status: 'active', graceUntil: null, createdAt: new Date(NOW.getTime() - 5 * DAY) };
const HALTED_SUB: SubscriptionSnapshot = { ...ACTIVE_SUB, status: 'halted' };

describe('computeProcessingState (PLAN §6.1)', () => {
  it('is active for an onboarded, unpaused, entitled account with an active connection', () => {
    expect(computeProcessingState(account(), { status: 'active' }, ACTIVE_SUB, NOW)).toBe('active');
  });

  it('is inactive when the account is not entitled', () => {
    expect(computeProcessingState(account(), { status: 'active' }, HALTED_SUB, NOW)).toBe('inactive');
    expect(computeProcessingState(account(), { status: 'active' }, null, NOW)).toBe('inactive');
  });

  it('is active during the trial without any subscription', () => {
    expect(computeProcessingState(account({ trialEndsAt: new Date(NOW.getTime() + DAY) }), { status: 'active' }, null, NOW)).toBe('active');
  });

  it('is paused when paused_at is set, even when not entitled (rule 4 before rule 5)', () => {
    const paused = account({ pausedAt: new Date(NOW.getTime() - DAY) });
    expect(computeProcessingState(paused, { status: 'active' }, ACTIVE_SUB, NOW)).toBe('paused');
    expect(computeProcessingState(paused, { status: 'active' }, HALTED_SUB, NOW)).toBe('paused');
  });

  it('is onboarding until onboarding_completed_at is set, even when paused or not entitled', () => {
    const onboarding = account({ onboardingCompletedAt: null, pausedAt: new Date(NOW.getTime() - DAY) });
    expect(computeProcessingState(onboarding, { status: 'active' }, HALTED_SUB, NOW)).toBe('onboarding');
  });

  it('is revoked whatever the account says, while the connection is revoked', () => {
    const anything = account({ onboardingCompletedAt: null, pausedAt: new Date(NOW.getTime() - DAY) });
    expect(computeProcessingState(anything, { status: 'revoked' }, HALTED_SUB, NOW)).toBe('revoked');
    expect(computeProcessingState(account(), { status: 'revoked' }, ACTIVE_SUB, NOW)).toBe('revoked');
  });

  it('is disconnected for a disconnected connection, or none at all', () => {
    expect(computeProcessingState(account(), { status: 'disconnected' }, ACTIVE_SUB, NOW)).toBe('disconnected');
    expect(computeProcessingState(account(), null, ACTIVE_SUB, NOW)).toBe('disconnected');
  });

  it('applies the six rules in order over every combination', () => {
    const pausedValues = [null, new Date(NOW.getTime() - DAY)];
    const onboardingValues = [null, new Date(NOW.getTime() - DAY)];
    const subs = [ACTIVE_SUB, HALTED_SUB];
    for (const status of CONNECTION_STATUSES as readonly ConnectionStatus[]) {
      for (const pausedAt of pausedValues) {
        for (const onboardingCompletedAt of onboardingValues) {
          for (const subscription of subs) {
            const state = computeProcessingState(account({ pausedAt, onboardingCompletedAt }), { status }, subscription, NOW);
            const expected =
              status === 'disconnected'
                ? 'disconnected'
                : status === 'revoked'
                  ? 'revoked'
                  : onboardingCompletedAt === null
                    ? 'onboarding'
                    : pausedAt !== null
                      ? 'paused'
                      : subscription === HALTED_SUB
                        ? 'inactive'
                        : 'active';
            expect(state).toBe(expected);
          }
        }
      }
    }
  });
});
