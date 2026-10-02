import { describe, expect, it } from 'vitest';
import { activeStops, evaluateStops, signalStop, STOP_PRECEDENCE, type RankedStopReason, type StopState } from './stops';
import { STOP_REASONS } from './types';

// PLAN §6.2's stop table (D-06, D-08, D-09, D-14, D-44), row by row, with every pair of rows to
// pin the precedence.

const T = new Date('2026-10-08T15:00:00.000Z');

const CLEAR: StopState = {
  isTest: false,
  stopReason: null,
  dismissedAt: null,
  repliedAt: null,
  accountState: 'active',
  connectionStatus: 'active',
  followupsEnabled: true,
  followUpNumber: 1,
  superseded: false,
  contact: { deleted: false, optedOut: false, bounced: false },
};

const NO_CONTACT = { deleted: false, optedOut: false, bounced: false } as const;

/** One live fact per row of the table, applied to a state. */
const ROWS: Readonly<Record<RankedStopReason, (state: StopState) => StopState>> = {
  test_lead: (s) => ({ ...s, isTest: true }),
  // The privacy_delete job stores it (D-06); there is no other live fact for it.
  privacy_deletion: (s) => ({ ...s, stopReason: 'privacy_deletion' }),
  dismissed: (s) => ({ ...s, dismissedAt: T }),
  replied: (s) => ({ ...s, repliedAt: T }),
  contact_deleted: (s) => ({ ...s, contact: { ...(s.contact ?? NO_CONTACT), deleted: true } }),
  opted_out: (s) => ({ ...s, contact: { ...(s.contact ?? NO_CONTACT), optedOut: true } }),
  bounced: (s) => ({ ...s, contact: { ...(s.contact ?? NO_CONTACT), bounced: true } }),
  superseded: (s) => ({ ...s, superseded: true }),
  account_inactive: (s) => ({ ...s, accountState: 'paused' }),
  followups_off: (s) => ({ ...s, followupsEnabled: false }),
  max_followups: (s) => ({ ...s, followUpNumber: 3 }),
};

describe('evaluateStops: one row at a time', () => {
  it('lets a follow-up go ahead when nothing holds (before and after the contact read)', () => {
    expect(evaluateStops(CLEAR)).toEqual({ stop: null });
    expect(evaluateStops({ ...CLEAR, contact: null })).toEqual({ stop: null });
    expect(evaluateStops({ ...CLEAR, followUpNumber: 2 })).toEqual({ stop: null });
  });

  it.each(STOP_PRECEDENCE.map((reason) => [reason]))('stops with %s when only its fact holds', (reason) => {
    expect(evaluateStops(ROWS[reason](CLEAR))).toEqual({ stop: reason });
  });

  it.each(STOP_REASONS.map((reason) => [reason]))('stops with a stored %s whatever the live facts say', (reason) => {
    expect(evaluateStops({ ...CLEAR, stopReason: reason })).toEqual({ stop: reason });
  });

  it.each(['paused', 'inactive', 'revoked', 'disconnected', 'onboarding'] as const)('treats an account that is %s as not active', (accountState) => {
    expect(evaluateStops({ ...CLEAR, accountState })).toEqual({ stop: 'account_inactive' });
  });

  it.each(['revoked', 'disconnected', null] as const)('treats a connection that is %s as not active, even before the account state follows', (status) => {
    expect(evaluateStops({ ...CLEAR, connectionStatus: status })).toEqual({ stop: 'account_inactive' });
  });

  it.each([0, 3, 4, -1, 1.5])('stops follow-up number %s: there are at most 2 follow-ups', (n) => {
    expect(evaluateStops({ ...CLEAR, followUpNumber: n })).toEqual({ stop: 'max_followups' });
  });

  it('needs the contact read for the contact rows: before it, only database facts stop', () => {
    expect(evaluateStops({ ...CLEAR, contact: null, superseded: true })).toEqual({ stop: 'superseded' });
    expect(evaluateStops({ ...CLEAR, contact: { deleted: false, optedOut: true, bounced: true } })).toEqual({ stop: 'opted_out' });
  });
});

describe('evaluateStops: precedence', () => {
  it('covers every stop reason exactly once', () => {
    expect([...STOP_PRECEDENCE].sort()).toEqual([...STOP_REASONS].sort());
    expect(new Set(STOP_PRECEDENCE).size).toBe(STOP_PRECEDENCE.length);
  });

  it('puts the lead\'s own facts before the account and the follow-up count', () => {
    expect(STOP_PRECEDENCE).toEqual([
      'test_lead',
      'privacy_deletion',
      'dismissed',
      'replied',
      'contact_deleted',
      'opted_out',
      'bounced',
      'superseded',
      'account_inactive',
      'followups_off',
      'max_followups',
    ]);
  });

  const pairs = STOP_PRECEDENCE.flatMap((first, i) => STOP_PRECEDENCE.slice(i + 1).map((second) => [first, second] as const));

  it.each(pairs)('reports %s over %s when both hold (live facts)', (first, second) => {
    // privacy_deletion is stored-only, so it cannot be combined with another stored reason here.
    const state = ROWS[second](ROWS[first](CLEAR));
    expect(evaluateStops(state)).toEqual({ stop: first });
    expect(activeStops(state).slice(0, 2)).toEqual([first, second]);
  });

  it.each(pairs.filter(([first]) => first !== 'privacy_deletion'))('reports a live %s over a stored %s', (first, second) => {
    expect(evaluateStops(ROWS[first]({ ...CLEAR, stopReason: second }))).toEqual({ stop: first });
  });

  it('reports every stop that holds, in order, when all of them do', () => {
    const all = STOP_PRECEDENCE.reduce((state, reason) => ROWS[reason](state), CLEAR);
    expect(activeStops(all)).toEqual([...STOP_PRECEDENCE]);
    expect(evaluateStops(all)).toEqual({ stop: 'test_lead' });
  });

  it('lists a stored reason once even when its live fact also holds', () => {
    expect(activeStops({ ...CLEAR, stopReason: 'dismissed', dismissedAt: T })).toEqual(['dismissed']);
  });
});

describe('signalStop', () => {
  it('reports the reply first, then the contact\'s own stops in table order', () => {
    expect(signalStop({ replied: false, contact: null })).toBeNull();
    expect(signalStop({ replied: false, contact: NO_CONTACT })).toBeNull();
    expect(signalStop({ replied: true, contact: { deleted: true, optedOut: true, bounced: true } })).toBe('replied');
    expect(signalStop({ replied: false, contact: { deleted: true, optedOut: true, bounced: true } })).toBe('contact_deleted');
    expect(signalStop({ replied: false, contact: { deleted: false, optedOut: true, bounced: true } })).toBe('opted_out');
    expect(signalStop({ replied: false, contact: { deleted: false, optedOut: false, bounced: true } })).toBe('bounced');
  });
});
