import { describe, expect, it } from 'vitest';
import type { EmailEngagement } from '@/server/ports';
import { advanceLegs, findLegEvidence, loggingModeFor, type LegsState } from './legs';

// The inbox check's pure leg rules (PLAN §9.7, D-14).

const T0 = new Date('2026-10-06T13:03:15.000Z');
const MINUTE = 60_000;
const TEST = 'owner.personal@example.net';
const OWNER = 'owner@brightside-plumbing.example';

function at(ms: number): Date {
  return new Date(T0.getTime() + ms);
}

function email(partial: Partial<EmailEngagement> & Pick<EmailEngagement, 'direction'>): EmailEngagement {
  return { id: '1', timestamp: at(MINUTE), toEmails: [], ...partial };
}

const STATE: LegsState = { send: 'pending', reply: 'pending', sendDeadlineAt: at(10 * MINUTE), replyDeadlineAt: at(20 * MINUTE) };

describe('findLegEvidence', () => {
  it('sees an EMAIL to the test address and an INCOMING_EMAIL from it, whatever the case', () => {
    const evidence = findLegEvidence(
      [
        email({ direction: 'EMAIL', fromEmail: OWNER, toEmails: ['Owner.Personal@Example.net'] }),
        email({ direction: 'INCOMING_EMAIL', fromEmail: 'OWNER.PERSONAL@example.net', toEmails: [OWNER] }),
      ],
      TEST,
      T0,
    );
    expect(evidence).toEqual({ sendSeen: true, replySeen: true });
  });

  it('ignores other addresses, other directions and emails from before the check (beyond the 60 s skew)', () => {
    const evidence = findLegEvidence(
      [
        email({ direction: 'EMAIL', toEmails: ['someone@example.com'] }),
        email({ direction: 'INCOMING_EMAIL', fromEmail: 'someone@example.com' }),
        email({ direction: 'FORWARDED_EMAIL', fromEmail: TEST }),
        email({ direction: 'EMAIL', fromEmail: TEST, toEmails: [OWNER] }),
        email({ direction: 'EMAIL', toEmails: [TEST], timestamp: at(-61_000) }),
        email({ direction: 'INCOMING_EMAIL', fromEmail: TEST, timestamp: at(-61_000) }),
        email({ direction: null, toEmails: [TEST], fromEmail: TEST }),
      ],
      TEST,
      T0,
    );
    expect(evidence).toEqual({ sendSeen: false, replySeen: false });
  });

  it('accepts an email up to 60 s before the check started (clock skew)', () => {
    expect(findLegEvidence([email({ direction: 'EMAIL', toEmails: [TEST], timestamp: at(-60_000) })], TEST, T0)).toEqual({
      sendSeen: true,
      replySeen: false,
    });
  });
});

describe('advanceLegs', () => {
  it('passes a leg as soon as it is seen and moves the reply deadline to 10 min after the send was seen', () => {
    const outcome = advanceLegs(STATE, { sendSeen: true, replySeen: false }, at(MINUTE));
    expect(outcome).toEqual({
      send: 'passed',
      reply: 'pending',
      replyDeadlineAt: at(11 * MINUTE),
      sendResolved: true,
      replyResolved: false,
      finished: false,
      loggingMode: null,
    });
  });

  it('never extends the reply deadline', () => {
    const outcome = advanceLegs(STATE, { sendSeen: true, replySeen: false }, at(15 * MINUTE));
    expect(outcome.replyDeadlineAt).toEqual(at(20 * MINUTE));
  });

  it('fails the send leg at its deadline and keeps waiting for the reply until its own', () => {
    const atSendDeadline = advanceLegs(STATE, { sendSeen: false, replySeen: false }, at(10 * MINUTE));
    expect(atSendDeadline).toMatchObject({ send: 'failed', reply: 'pending', finished: false });
    const atReplyDeadline = advanceLegs({ ...STATE, send: 'failed' }, { sendSeen: false, replySeen: false }, at(20 * MINUTE));
    expect(atReplyDeadline).toMatchObject({ send: 'failed', reply: 'failed', sendResolved: false, replyResolved: true, finished: true, loggingMode: 'none' });
  });

  it('still passes a leg seen after its deadline (logged late, run delayed)', () => {
    expect(advanceLegs(STATE, { sendSeen: true, replySeen: true }, at(30 * MINUTE))).toMatchObject({
      send: 'passed',
      reply: 'passed',
      loggingMode: 'log_all',
    });
  });

  it('resolves every pending leg when forced', () => {
    expect(advanceLegs({ ...STATE, send: 'passed' }, { sendSeen: false, replySeen: false }, at(MINUTE), { forceResolve: true })).toMatchObject({
      send: 'passed',
      reply: 'failed',
      loggingMode: 'sends_only',
    });
  });

  it('leaves resolved legs alone', () => {
    const outcome = advanceLegs({ ...STATE, send: 'passed', reply: 'failed' }, { sendSeen: false, replySeen: true }, at(MINUTE));
    expect(outcome).toMatchObject({ send: 'passed', reply: 'failed', sendResolved: false, replyResolved: false });
  });
});

describe('loggingModeFor', () => {
  it.each([
    ['passed', 'passed', 'log_all'],
    ['passed', 'failed', 'sends_only'],
    ['failed', 'failed', 'none'],
    ['failed', 'passed', 'none'],
    ['pending', 'passed', null],
    ['passed', 'pending', null],
    ['skipped', 'passed', null],
    ['passed', 'skipped', null],
  ] as const)('send %s, reply %s → %s', (send, reply, mode) => {
    expect(loggingModeFor(send, reply)).toBe(mode);
  });
});
