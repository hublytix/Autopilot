import 'server-only';
import { FOLLOW_UP_NUMBERS } from './followup-schedule';
import type { AccountProcessingState, ConnectionStatus, StopReason } from './types';

// The follow-up hard stops (brief §5.6, PLAN §6.2 stop table, D-06, D-08, D-09, D-14, D-44). Pure.
//
// A follow-up job evaluates them on the database state when it starts (PLAN §9.5 step 2), and again
// once the contact has been read from HubSpot (step 3: 404, opt-out, bounce); the per-kind
// reservation SQL re-checks the database ones right before the send (§8.4), so a dismiss, pause or
// disconnect during drafting is still respected.
//
// A stored `leads.stop_reason` is a stop whatever the live facts say (only "Resume follow-ups"
// clears one, and only `replied`, D-42). When several stops hold, the first in STOP_PRECEDENCE is
// the one reported (and the one a caller stores): facts about the lead itself first, then the
// account, then the follow-up count.
//
//   1. test_lead         is_test (follow-up jobs are never created for one; defensive, D-14)
//   2. privacy_deletion  the contact was privacy-deleted (D-06; stored by the privacy_delete job)
//   3. dismissed         dismissed_at is set
//   4. replied           replied_at is set (D-08)
//   5. contact_deleted   the contact GET returned 404 (D-09)
//   6. opted_out         hs_email_optout == "true" (D-09)
//   7. bounced           a hard-bounce reason, or hs_email_bad_address == "true" (D-09)
//   8. superseded        a newer non-test lead of the same contact was already notified (D-44)
//   9. account_inactive  the account is not active (paused, inactive, revoked, disconnected,
//                        onboarding) or its connection is not active
//  10. followups_off     settings.followups_enabled is false
//  11. max_followups     more than 2 follow-ups (the job's n is not 1 or 2)

/** The order in which stops are reported when several hold (see above). */
export const STOP_PRECEDENCE = [
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
] as const satisfies readonly StopReason[];

/** A stop with a rule here; a stored reason outside the list still stops (reported last). */
export type RankedStopReason = (typeof STOP_PRECEDENCE)[number];

/** The stops only a HubSpot read can show (PLAN §9.5 step 3). */
/**
 * Stored when a lead's follow-up stream ends without its emails (a failed or unschedulable follow-up,
 * or one that could no longer be drafted, D-70, D-73): its follow-ups are used up, which is what
 * `max_followups` says (no more than two). A dedicated value would need the check constraint,
 * STOP_REASONS and STOP_PRECEDENCE; this one is already all three.
 */
export const STREAM_ENDED_STOP = 'max_followups' satisfies StopReason;

export const CONTACT_STOP_REASONS = ['contact_deleted', 'opted_out', 'bounced'] as const satisfies readonly StopReason[];
export type ContactStopReason = (typeof CONTACT_STOP_REASONS)[number];

/** What the contact read showed (domain/signals.ts reads the properties). */
export interface ContactStopFacts {
  /** `GET contacts/{id}` returned 404 (archived or privacy-deleted). */
  readonly deleted: boolean;
  readonly optedOut: boolean;
  readonly bounced: boolean;
}

export interface StopState {
  readonly isTest: boolean;
  /** `leads.stop_reason` as stored. */
  readonly stopReason: StopReason | null;
  readonly dismissedAt: Date | null;
  readonly repliedAt: Date | null;
  readonly accountState: AccountProcessingState;
  /** The account's HubSpot connection; null when there is none. */
  readonly connectionStatus: ConnectionStatus | null;
  /** `settings.followups_enabled` now. */
  readonly followupsEnabled: boolean;
  /** The follow-up about to be sent (the job's n). */
  readonly followUpNumber: number;
  /** D-44, computed in SQL (services/signals/stop-state.ts). */
  readonly superseded: boolean;
  /** The contact read; null before it (PLAN §9.5 step 2). */
  readonly contact: ContactStopFacts | null;
}

export interface StopDecision {
  /** The stop to report, or null when the follow-up may go ahead. */
  readonly stop: StopReason | null;
}

function isFollowUpNumber(n: number): boolean {
  return (FOLLOW_UP_NUMBERS as readonly number[]).includes(n);
}

function holds(state: StopState, reason: RankedStopReason): boolean {
  if (state.stopReason === reason) return true;
  switch (reason) {
    case 'test_lead':
      return state.isTest;
    case 'privacy_deletion':
      return false;
    case 'dismissed':
      return state.dismissedAt !== null;
    case 'replied':
      return state.repliedAt !== null;
    case 'contact_deleted':
      return state.contact?.deleted === true;
    case 'opted_out':
      return state.contact?.optedOut === true;
    case 'bounced':
      return state.contact?.bounced === true;
    case 'superseded':
      return state.superseded;
    case 'account_inactive':
      return state.accountState !== 'active' || state.connectionStatus !== 'active';
    case 'followups_off':
      return !state.followupsEnabled;
    case 'max_followups':
      return !isFollowUpNumber(state.followUpNumber);
  }
}

/** Every stop that holds, in STOP_PRECEDENCE order (a stored reason outside the list comes last). */
export function activeStops(state: StopState): StopReason[] {
  const active: StopReason[] = STOP_PRECEDENCE.filter((reason) => holds(state, reason));
  if (state.stopReason !== null && !active.includes(state.stopReason)) active.push(state.stopReason);
  return active;
}

/** PLAN §6.2: the first stop that holds, or null. */
export function evaluateStops(state: StopState): StopDecision {
  return { stop: activeStops(state)[0] ?? null };
}

/**
 * The stop a contact read shows on its own (applySignals): `replied` when the lead's reply is
 * recorded, else the contact's own stop (deleted, opted out, bounced), in STOP_PRECEDENCE order.
 */
export function signalStop(facts: { readonly replied: boolean; readonly contact: ContactStopFacts | null }): StopReason | null {
  if (facts.replied) return 'replied';
  const contact = facts.contact;
  if (contact === null) return null;
  if (contact.deleted) return 'contact_deleted';
  if (contact.optedOut) return 'opted_out';
  if (contact.bounced) return 'bounced';
  return null;
}
