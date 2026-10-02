import 'server-only';
import { contactStopFacts, evaluateSignals, type Signals } from '@/server/domain/signals';
import { signalStop, type ContactStopFacts } from '@/server/domain/stops';
import { isStopReason, type StopReason } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { forAccount, type PortalHubSpotClient, type Sleep } from '@/server/services/hubspot';
import type { NotificationRegistry } from '@/server/services/notifications';
import { markReplied, resumePendingReplyEmail, type ReplyEmailOutcome } from './mark-replied';
import { readContactSignals } from './read';

// applySignals (PLAN §9.5 steps 3-4, D-08, D-09): reads the lead's contact from HubSpot and records
// what it confirms, for a follow-up job (`followup_job`) or a lead-page refresh (`refresh`):
// - `send_confirmed_at` = LEAST(stored, the earliest confirmed send) (HubSpot's time, never moved
//   later) and, only when every logged email of the contact was read (`emailsAvailable`; or the
//   contact is gone), `signals_checked_at` = $now: a blind read (no email scope, HubSpot's 403, the
//   association paging cut short) is never recorded as a check, and the result says so, so nobody
//   claims "no reply is logged" without having looked (law 3, D-73);
// - the lead's window ends where the owner was first emailed about a newer lead of the same contact
//   (D-44's rule): a send or reply after that belongs to the newer lead (D-73);
// - a reply → markReplied (one transaction; the email only while follow-ups were still scheduled);
//   when the reply was already recorded, a reply_detected email still `sending` from an earlier
//   attempt is sent (PLAN §9.5 step 1);
// - the contact's stops (404 → contact_deleted, opted out, bounced) are returned, not stored: the
//   follow-up job stores the stop it acts on.
// Never for a test lead: every statement has `AND NOT is_test`, so one is simply not found and
// HubSpot is not called (D-08, D-14). A privacy-deleted lead is not read either (D-06).

export type SignalsCaller = 'followup_job' | 'refresh';

export interface ApplySignalsOptions {
  readonly caller: SignalsCaller;
  /**
   * Follow-ups were still scheduled for the lead when the caller started, so a reply found now
   * gets the reply_detected email. Default: true for a follow-up job, false for a refresh (which
   * still emails when it cancels a pending follow-up).
   */
  readonly followUpStillScheduled?: boolean | undefined;
  /** The calling follow-up job: markReplied leaves it to finish. */
  readonly jobId?: string | undefined;
  /** Only a lead of this account (an owner's refresh). */
  readonly accountId?: string | undefined;
  /** Counts refresh failures inline (D-11: the lead-page refresh). */
  readonly inline?: boolean | undefined;
  readonly client?: PortalHubSpotClient | undefined;
  readonly sleep?: Sleep | undefined;
  readonly signal?: AbortSignal | undefined;
  /** The registry holding the reply_detected resumer (default: the process registry). */
  readonly notifications?: NotificationRegistry | undefined;
}

export interface ApplySignalsResult {
  /** `checked`: HubSpot was read; `skipped`: not found (or a test lead), privacy-deleted, or without a contact. */
  readonly outcome: 'checked' | 'skipped';
  /** replied, contact_deleted, opted_out or bounced (privacy_deletion when skipped for it); null when none. */
  readonly stop: StopReason | null;
  /** The lead's reply is recorded (by this call or earlier). */
  readonly replied: boolean;
  /** This call recorded it (it won markReplied). */
  readonly markedReplied: boolean;
  readonly confirmedSendAt: Date | null;
  readonly replyEmail: ReplyEmailOutcome;
  /** The lead's contact id after this call (the merged record's after a merge). */
  readonly contactId: string | null;
  /**
   * Every email logged on the contact was read (or the contact is gone), so "no reply is logged" is
   * a fact. False when the emails could not all be read: say "not enough data" instead (law 3).
   */
  readonly emailsAvailable: boolean;
}

interface SignalLeadRow {
  id: string;
  account_id: string;
  hubspot_contact_id: string | null;
  first_notified_at: Date | null;
  replies_ignored_before: Date | null;
  replied_at: Date | null;
  send_confirmed_at: Date | null;
  stop_reason: string | null;
  followup_stream: number;
  submitted_email: string | null;
  /** When the owner was first emailed about a newer non-test lead of the same contact (D-44): the end of this lead's window. */
  window_until: Date | null;
}

async function loadSignalLead(db: Db, leadId: string, accountId: string | undefined): Promise<SignalLeadRow | null> {
  return db.maybeOne<SignalLeadRow>(
    `select l.id, l.account_id, l.hubspot_contact_id, l.first_notified_at, l.replies_ignored_before, l.replied_at,
            l.send_confirmed_at, l.stop_reason, l.followup_stream, m.email as submitted_email,
            (select min(newer_lead.first_notified_at) from leads newer_lead
              where newer_lead.account_id = l.account_id and newer_lead.hubspot_contact_id = l.hubspot_contact_id
                and newer_lead.id <> l.id and not newer_lead.is_test and newer_lead.submitted_at > l.submitted_at
                and newer_lead.first_notified_at is not null) as window_until
       from leads l
       left join lead_messages m on m.lead_id = l.id and m.account_id = l.account_id
      where l.id = $1 and ($2::uuid is null or l.account_id = $2::uuid) and not l.is_test`,
    [leadId, accountId ?? null],
  );
}

/** Writes the check (its time only when it read everything); returns the stored times after it, or null when the lead is gone. */
async function recordCheck(
  db: Db,
  lead: SignalLeadRow,
  input: { confirmedSendAt: Date | null; complete: boolean; now: Date },
): Promise<{ send_confirmed_at: Date | null; replied_at: Date | null } | null> {
  return db.maybeOne(
    `update leads set send_confirmed_at = least(send_confirmed_at, $3::timestamptz),
                      signals_checked_at = case when $5::boolean then $4::timestamptz else signals_checked_at end
      where id = $1 and account_id = $2 and not is_test
      returning send_confirmed_at, replied_at`,
    [lead.id, lead.account_id, input.confirmedSendAt, input.now, input.complete],
  );
}

function skipped(lead: SignalLeadRow | null, stop: StopReason | null): ApplySignalsResult {
  return {
    outcome: 'skipped',
    stop,
    replied: lead !== null && lead.replied_at !== null,
    markedReplied: false,
    confirmedSendAt: lead?.send_confirmed_at ?? null,
    replyEmail: 'none',
    contactId: lead?.hubspot_contact_id ?? null,
    emailsAvailable: false,
  };
}

const DELETED: ContactStopFacts = { deleted: true, optedOut: false, bounced: false };

/** PLAN §9.5 steps 3-4 for one lead. HubSpot errors propagate (the job retries). */
export async function applySignals(deps: Deps, leadId: string, options: ApplySignalsOptions): Promise<ApplySignalsResult> {
  const lead = await loadSignalLead(deps.db, leadId, options.accountId);
  if (lead === null) return skipped(null, null);
  if (lead.stop_reason === 'privacy_deletion') return skipped(lead, 'privacy_deletion');
  if (lead.hubspot_contact_id === null) return skipped(lead, isStopReason(lead.stop_reason) ? lead.stop_reason : null);

  const client = options.client ?? forAccount(deps, lead.account_id, { sleep: options.sleep, inline: options.inline });
  const read = await readContactSignals(
    deps,
    lead.account_id,
    { id: lead.id, hubspotContactId: lead.hubspot_contact_id },
    { client, signal: options.signal },
  );

  let signals: Signals | null = null;
  let contact: ContactStopFacts = DELETED;
  if (read.type === 'found') {
    contact = contactStopFacts(read.properties);
    if (lead.first_notified_at !== null) {
      signals = evaluateSignals({
        properties: read.properties,
        emails: read.emails,
        firstNotifiedAt: lead.first_notified_at,
        repliesIgnoredBefore: lead.replies_ignored_before,
        extraAddresses: [lead.submitted_email],
        until: lead.window_until,
      });
      // A send to the lead that bounced is a bounce stop too (D-09, D-73).
      contact = signals.contact;
    }
  }
  const emailsAvailable = read.type === 'deleted' || (read.emailsAvailable && read.emailsComplete);

  const checked = await recordCheck(deps.db, lead, { confirmedSendAt: signals?.confirmedSendAt ?? null, complete: emailsAvailable, now: deps.clock.now() });
  if (checked === null) return skipped(null, null);

  let repliedAt = checked.replied_at;
  let markedReplied = false;
  let replyEmail: ReplyEmailOutcome = 'none';
  const replyAt = signals?.replyAt ?? null;
  if (replyAt !== null) {
    const marked = await markReplied(
      deps,
      {
        accountId: lead.account_id,
        leadId: lead.id,
        repliedAt: replyAt,
        followUpStillScheduled: options.followUpStillScheduled ?? options.caller === 'followup_job',
        exceptJobId: options.jobId,
      },
      { notifications: options.notifications },
    );
    markedReplied = marked.won;
    repliedAt = marked.repliedAt;
    replyEmail = marked.replyEmail;
  }
  if (!markedReplied && repliedAt !== null) {
    replyEmail = await resumePendingReplyEmail(deps, { leadId: lead.id, followupStream: lead.followup_stream }, { notifications: options.notifications });
  }

  const replied = repliedAt !== null;
  const stop = signalStop({ replied, contact });
  log.info('lead signals checked', {
    event: 'signals.checked',
    accountId: lead.account_id,
    leadId: lead.id,
    kind: options.caller,
    status: stop,
    reason: signals?.replySource ?? null,
    outcome: emailsAvailable ? read.type : 'emails_unavailable',
  });
  return {
    outcome: 'checked',
    stop,
    replied,
    markedReplied,
    confirmedSendAt: checked.send_confirmed_at,
    replyEmail,
    contactId: read.contactId,
    emailsAvailable,
  };
}
