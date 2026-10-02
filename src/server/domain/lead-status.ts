import 'server-only';
import {
  isDraftableClassification,
  type Classification,
  type LeadDisplayStatus,
  type LeadProcessingState,
  type StopReason,
} from './types';

// The one status the owner sees for a lead (D-32, brief §5.11). Pure; the result is never stored.
// The first rule that matches wins:
//
//   1. dismissed       dismissed_at is set
//   2. replied         replied_at is set (the lead's reply, confirmed in HubSpot: law 3, D-37)
//   3. filtered        a filtered class, not overridden ("This is a real lead", D-42)
//   4. not_processed   processing_state is failed, skipped or deferred
//   5. no_reply        follow-ups finished or off, at least 2 days since the last email to the owner
//                      about this lead, HubSpot logs the lead's replies for this account (logging_mode
//                      log_all with the email scope), and HubSpot was read in full (every logged email)
//                      after the owner email before that one: the check that let the last email go
//                      out, or a later one. Without such a check nobody looked, and without reply
//                      logging nothing could be seen, so the claim "none logged" is not made ("not
//                      enough data", law 3, D-37, D-73, D-77) and the lead keeps its send status.
//   6. send_confirmed  send_confirmed_at is set (an EMAIL logged in HubSpot)
//   7. send_clicked    first_send_clicked_at is set (a click is never a confirmed send: law 3, D-26)
//   8. drafted         the owner was emailed the draft (processing_state notified)
//   9. processing      anything else (new, processing, or an override still being re-processed)

/** The lead fields deriveLeadStatus reads, plus the account's current follow-up setting. */
export interface LeadStatusInput {
  readonly processingState: LeadProcessingState;
  readonly classification: Classification | null;
  readonly classificationOverride: Classification | null;
  readonly processRev: number;
  readonly stopReason: StopReason | null;
  readonly dismissedAt: Date | null;
  readonly repliedAt: Date | null;
  readonly firstNotifiedAt: Date | null;
  readonly fu1NotifiedAt: Date | null;
  readonly fu2NotifiedAt: Date | null;
  readonly firstSendClickedAt: Date | null;
  readonly sendConfirmedAt: Date | null;
  /** `leads.signals_checked_at`: the last read of HubSpot that saw every logged email of the contact. */
  readonly signalsCheckedAt: Date | null;
  /** `settings.followups_enabled` now: with follow-ups off, none is coming for this lead. */
  readonly followupsEnabled: boolean;
  /**
   * HubSpot logs the lead's replies for this account: `logging_mode` log_all and the email scope
   * granted (D-37's reply rule). Without it "No reply from lead (none logged)" is never claimed.
   */
  readonly repliesLogged: boolean;
}

/** "No reply" needs this long since the last email to the owner about the lead (D-32). */
export const NO_REPLY_AFTER_MS = 2 * 24 * 60 * 60 * 1000;

/** What the owner reads for each status (D-32 labels; D-37: an unqualified "replied" is the lead's). */
export const LEAD_STATUS_LABELS: Readonly<Record<LeadDisplayStatus, string>> = {
  dismissed: 'Dismissed',
  replied: 'Replied',
  filtered: 'Filtered',
  not_processed: 'Not processed',
  no_reply: 'No reply from lead (none logged)',
  send_confirmed: 'Send confirmed in HubSpot',
  send_clicked: 'Send link opened',
  drafted: 'Drafted',
  processing: 'Processing',
};

const NOT_PROCESSED_STATES: ReadonlySet<LeadProcessingState> = new Set<LeadProcessingState>(['failed', 'skipped', 'deferred']);

/** The owner said "This is a real lead" (D-42); the same reading as lead_process (D-55). */
function isOverridden(lead: LeadStatusInput): boolean {
  return lead.processRev > 0 || lead.classificationOverride !== null;
}

function isFiltered(lead: LeadStatusInput): boolean {
  return !isOverridden(lead) && lead.classification !== null && !isDraftableClassification(lead.classification);
}

/** The emails to the owner about this lead (the first notification and the follow-ups), oldest first. */
function ownerEmails(lead: LeadStatusInput): Date[] {
  return [lead.firstNotifiedAt, lead.fu1NotifiedAt, lead.fu2NotifiedAt]
    .filter((at): at is Date => at !== null)
    .sort((a, b) => a.getTime() - b.getTime());
}

/**
 * HubSpot's logged emails were all read after the owner email before the last one: the check a
 * follow-up job made before its email went out, or any later one (a refresh). A lead with one email
 * needs a check after it.
 */
function repliesChecked(lead: LeadStatusInput, emails: readonly Date[]): boolean {
  const since = emails.length >= 2 ? emails[emails.length - 2] : emails[0];
  return since !== undefined && lead.signalsCheckedAt !== null && lead.signalsCheckedAt.getTime() >= since.getTime();
}

/** No follow-up is coming: both were emailed, follow-ups stopped for this lead, or they are off. */
function followUpsFinishedOrOff(lead: LeadStatusInput): boolean {
  return lead.fu2NotifiedAt !== null || lead.stopReason !== null || !lead.followupsEnabled;
}

function isNoReply(lead: LeadStatusInput, now: Date): boolean {
  const emails = ownerEmails(lead);
  const last = emails.at(-1);
  return (
    lead.repliesLogged &&
    last !== undefined &&
    followUpsFinishedOrOff(lead) &&
    now.getTime() - last.getTime() >= NO_REPLY_AFTER_MS &&
    repliesChecked(lead, emails)
  );
}

/** D-32, rules 1–9 in order. */
export function deriveLeadStatus(lead: LeadStatusInput, now: Date): LeadDisplayStatus {
  if (lead.dismissedAt !== null) return 'dismissed';
  if (lead.repliedAt !== null) return 'replied';
  if (isFiltered(lead)) return 'filtered';
  if (NOT_PROCESSED_STATES.has(lead.processingState)) return 'not_processed';
  if (isNoReply(lead, now)) return 'no_reply';
  if (lead.sendConfirmedAt !== null) return 'send_confirmed';
  if (lead.firstSendClickedAt !== null) return 'send_clicked';
  if (lead.processingState === 'notified' || lead.firstNotifiedAt !== null) return 'drafted';
  return 'processing';
}

export function leadStatusLabel(status: LeadDisplayStatus): string {
  return LEAD_STATUS_LABELS[status];
}
