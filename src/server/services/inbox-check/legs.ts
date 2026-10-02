import 'server-only';
import type { EmailEngagement } from '@/server/ports';
import type { InboxLegStatus, LoggingMode } from '@/server/domain/types';
import { CLOCK_SKEW_MS, LEG_WINDOW_MS } from './constants';

// The two legs of the inbox check, decided from email metadata only (PLAN §9.7 steps 3-5, D-14):
// - send leg: an `EMAIL` to the test address, logged after the check started;
// - reply leg: an `INCOMING_EMAIL` from the test address, logged after the check started.
// A leg passes as soon as its email is seen and fails once its deadline passes without it. The
// reply leg's window starts with the owner's send: when the send leg passes, the reply deadline
// moves to 10 minutes from then (never later than the deadline it already had).
// When both legs are resolved, the account's logging mode follows: both → log_all; the send
// only → sends_only; otherwise → none (a reply seen without a logged send cannot confirm sends,
// and "none" never overstates: D-37 shows "Not enough data" rather than a 0).
// Pure: no I/O, no clock reads.

export interface LegEvidence {
  readonly sendSeen: boolean;
  readonly replySeen: boolean;
}

/** What the test contact's logged emails show, for a check created at `checkCreatedAt`. */
export function findLegEvidence(emails: readonly EmailEngagement[], testAddress: string, checkCreatedAt: Date): LegEvidence {
  const address = testAddress.trim().toLowerCase();
  const since = checkCreatedAt.getTime() - CLOCK_SKEW_MS;
  let sendSeen = false;
  let replySeen = false;
  for (const email of emails) {
    if (email.timestamp.getTime() < since) continue;
    if (email.direction === 'EMAIL' && email.toEmails.some((to) => to.toLowerCase() === address)) sendSeen = true;
    if (email.direction === 'INCOMING_EMAIL' && email.fromEmail?.toLowerCase() === address) replySeen = true;
  }
  return { sendSeen, replySeen };
}

export interface LegsState {
  readonly send: InboxLegStatus;
  readonly reply: InboxLegStatus;
  readonly sendDeadlineAt: Date;
  readonly replyDeadlineAt: Date;
}

export interface LegsOutcome {
  readonly send: InboxLegStatus;
  readonly reply: InboxLegStatus;
  readonly replyDeadlineAt: Date;
  /** The leg changed in this step (its resolved_at is `now`). */
  readonly sendResolved: boolean;
  readonly replyResolved: boolean;
  /** Both legs are passed or failed: the check closes and the logging mode is set. */
  readonly finished: boolean;
  readonly loggingMode: LoggingMode | null;
}

export interface AdvanceOptions {
  /** Resolve every pending leg now (the run cap, or the failure path). */
  readonly forceResolve?: boolean | undefined;
}

/** The logging mode two resolved legs imply; null while a leg is pending or was skipped. */
export function loggingModeFor(send: InboxLegStatus, reply: InboxLegStatus): LoggingMode | null {
  const resolved = (leg: InboxLegStatus): boolean => leg === 'passed' || leg === 'failed';
  if (!resolved(send) || !resolved(reply)) return null;
  if (send === 'passed') return reply === 'passed' ? 'log_all' : 'sends_only';
  return 'none';
}

/** One run's decision: the legs after seeing `evidence` at `now`. */
export function advanceLegs(state: LegsState, evidence: LegEvidence, now: Date, options: AdvanceOptions = {}): LegsOutcome {
  const at = now.getTime();
  const force = options.forceResolve === true;

  let send = state.send;
  if (send === 'pending') {
    if (evidence.sendSeen) send = 'passed';
    else if (force || at >= state.sendDeadlineAt.getTime()) send = 'failed';
  }
  const sendResolved = send !== state.send;

  let replyDeadlineAt = state.replyDeadlineAt;
  if (sendResolved && send === 'passed') {
    replyDeadlineAt = new Date(Math.min(replyDeadlineAt.getTime(), at + LEG_WINDOW_MS));
  }

  let reply = state.reply;
  if (reply === 'pending') {
    if (evidence.replySeen) reply = 'passed';
    else if (force || at >= replyDeadlineAt.getTime()) reply = 'failed';
  }
  const replyResolved = reply !== state.reply;

  const loggingMode = loggingModeFor(send, reply);
  return { send, reply, replyDeadlineAt, sendResolved, replyResolved, finished: loggingMode !== null, loggingMode };
}
