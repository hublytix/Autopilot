import 'server-only';
import { z } from 'zod';
import { deriveLeadStatus, leadStatusLabel, type LeadStatusInput } from '@/server/domain/lead-status';
import { safeFirstName } from '@/server/domain/subject';
import {
  isClassification,
  isStopReason,
  LEAD_PROCESSING_STATES,
  type Classification,
  type LeadDisplayStatus,
  type LeadProcessingState,
  type StopReason,
} from '@/server/domain/types';
import { hubspotContactRecordUrl } from '@/server/services/leads/record-link';
import { repliesLogged, type AccountContext } from './account';

// One lead as the dashboard reads it (PLAN §7.5, D-31, D-32): the lead row's ids, states and
// timeline, plus whether its content (`lead_messages`) is still stored and, while it is, the first
// name. The one status shown is deriveLeadStatus's (D-32), with `signals_checked_at` so "No reply
// from lead (none logged)" is only claimed after a complete read of HubSpot (D-73). Ids come from
// the database, never from the request, except the lead page's id, which is checked as a uuid first
// and always read together with the owner's account id.

export const LEAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A lead id from a URL or a form, or null when it is not a uuid (such a lead cannot exist: a 404). */
export function parseLeadId(value: unknown): string | null {
  return typeof value === 'string' && LEAD_ID_PATTERN.test(value) ? value.toLowerCase() : null;
}

/**
 * The lead columns both the list and the lead page read (`l` = leads, `m` = lead_messages). `now` is
 * the query's `$now` placeholder: content past its `purge_at` counts as gone even while the hourly
 * retention purge (PLAN §9.10) has not deleted it yet, so the dashboard never shows it (law 4, D-49).
 */
export function leadSelect(now: string): string {
  return `l.id, l.hubspot_contact_id, l.is_test, l.processing_state, l.classification, l.classification_override,
       l.process_rev, l.stop_reason, l.needs_touch, l.received_at, l.classified_at, l.dismissed_at, l.replied_at,
       l.first_notified_at, l.fu1_notified_at, l.fu2_notified_at, l.first_send_clicked_at, l.send_confirmed_at,
       l.signals_checked_at, l.replies_ignored_before, l.followup_stream,
       case when m.purge_at > ${now} then m.first_name end as first_name,
       (m.lead_id is not null and m.purge_at > ${now}) as has_content`;
}

const leadRow = z.object({
  id: z.string(),
  hubspot_contact_id: z.string().nullable(),
  is_test: z.boolean(),
  processing_state: z.enum(LEAD_PROCESSING_STATES),
  classification: z.string().nullable(),
  classification_override: z.string().nullable(),
  process_rev: z.number().int(),
  stop_reason: z.string().nullable(),
  needs_touch: z.boolean(),
  received_at: z.date(),
  classified_at: z.date().nullable(),
  dismissed_at: z.date().nullable(),
  replied_at: z.date().nullable(),
  first_notified_at: z.date().nullable(),
  fu1_notified_at: z.date().nullable(),
  fu2_notified_at: z.date().nullable(),
  first_send_clicked_at: z.date().nullable(),
  send_confirmed_at: z.date().nullable(),
  signals_checked_at: z.date().nullable(),
  replies_ignored_before: z.date().nullable(),
  followup_stream: z.number().int(),
  first_name: z.string().nullable(),
  has_content: z.boolean(),
});

export interface LeadRecord {
  readonly id: string;
  readonly hubspotContactId: string | null;
  readonly isTest: boolean;
  readonly processingState: LeadProcessingState;
  readonly classification: Classification | null;
  readonly classificationOverride: Classification | null;
  readonly processRev: number;
  readonly stopReason: StopReason | null;
  readonly needsTouch: boolean;
  readonly receivedAt: Date;
  readonly classifiedAt: Date | null;
  readonly dismissedAt: Date | null;
  readonly repliedAt: Date | null;
  readonly firstNotifiedAt: Date | null;
  readonly fu1NotifiedAt: Date | null;
  readonly fu2NotifiedAt: Date | null;
  readonly firstSendClickedAt: Date | null;
  readonly sendConfirmedAt: Date | null;
  readonly signalsCheckedAt: Date | null;
  readonly repliesIgnoredBefore: Date | null;
  readonly followupStream: number;
  /** `lead_messages.first_name` while the content is stored (D-31); null after the purge. */
  readonly firstName: string | null;
  /** The lead's content (`lead_messages`) is still stored and not past its `purge_at`. */
  readonly hasContent: boolean;
}

export function parseLeadRecord(raw: unknown): LeadRecord {
  const row = leadRow.parse(raw);
  return {
    id: row.id,
    hubspotContactId: row.hubspot_contact_id,
    isTest: row.is_test,
    processingState: row.processing_state,
    classification: isClassification(row.classification) ? row.classification : null,
    classificationOverride: isClassification(row.classification_override) ? row.classification_override : null,
    processRev: row.process_rev,
    stopReason: isStopReason(row.stop_reason) ? row.stop_reason : null,
    needsTouch: row.needs_touch,
    receivedAt: row.received_at,
    classifiedAt: row.classified_at,
    dismissedAt: row.dismissed_at,
    repliedAt: row.replied_at,
    firstNotifiedAt: row.first_notified_at,
    fu1NotifiedAt: row.fu1_notified_at,
    fu2NotifiedAt: row.fu2_notified_at,
    firstSendClickedAt: row.first_send_clicked_at,
    sendConfirmedAt: row.send_confirmed_at,
    signalsCheckedAt: row.signals_checked_at,
    repliesIgnoredBefore: row.replies_ignored_before,
    followupStream: row.followup_stream,
    firstName: row.has_content ? row.first_name : null,
    hasContent: row.has_content,
  };
}

export function statusInputOf(lead: LeadRecord, account: { followupsEnabled: boolean; repliesLogged: boolean }): LeadStatusInput {
  return {
    processingState: lead.processingState,
    classification: lead.classification,
    classificationOverride: lead.classificationOverride,
    processRev: lead.processRev,
    stopReason: lead.stopReason,
    dismissedAt: lead.dismissedAt,
    repliedAt: lead.repliedAt,
    firstNotifiedAt: lead.firstNotifiedAt,
    fu1NotifiedAt: lead.fu1NotifiedAt,
    fu2NotifiedAt: lead.fu2NotifiedAt,
    firstSendClickedAt: lead.firstSendClickedAt,
    sendConfirmedAt: lead.sendConfirmedAt,
    signalsCheckedAt: lead.signalsCheckedAt,
    followupsEnabled: account.followupsEnabled,
    repliesLogged: account.repliesLogged,
  };
}

export interface LeadStatusView {
  readonly status: LeadDisplayStatus;
  /** D-32's label ("Not processed", "No reply from lead (none logged)", …). */
  readonly label: string;
}

/** The one status the owner sees (D-32, with D-73's complete-read rule and D-77's reply-logging rule). */
export function leadStatusOf(lead: LeadRecord, context: Pick<AccountContext, 'followupsEnabled' | 'loggingMode' | 'connection'>, now: Date): LeadStatusView {
  const status = deriveLeadStatus(statusInputOf(lead, { followupsEnabled: context.followupsEnabled, repliesLogged: repliesLogged(context) }), now);
  return { status, label: leadStatusLabel(status) };
}

/**
 * Who the lead is, as far as the dashboard may say (D-31, D-47): the first name while the content is
 * stored and the name is safe to show; otherwise the HubSpot contact id, with why the details are gone.
 */
export type LeadNameView =
  | { readonly kind: 'name'; readonly name: string }
  /** Stored content, but no usable first name. */
  | { readonly kind: 'contact'; readonly contactId: string | null; readonly removed: null }
  /** The content was purged 30 days after the submission, or deleted at the contact's request. */
  | { readonly kind: 'contact'; readonly contactId: string | null; readonly removed: 'purged' | 'privacy_deleted' };

export function leadNameOf(lead: LeadRecord): LeadNameView {
  if (!lead.hasContent) {
    return { kind: 'contact', contactId: lead.hubspotContactId, removed: lead.stopReason === 'privacy_deletion' ? 'privacy_deleted' : 'purged' };
  }
  const name = safeFirstName(lead.firstName);
  return name === null ? { kind: 'contact', contactId: lead.hubspotContactId, removed: null } : { kind: 'name', name };
}

/** The contact's record in HubSpot (only a HubSpot host and numeric ids, D-64). */
export function leadRecordUrl(lead: LeadRecord, context: Pick<AccountContext, 'portalId' | 'connection'>): string | null {
  return hubspotContactRecordUrl(context.connection.uiDomain, context.portalId, lead.hubspotContactId);
}

/** Why a lead shows "Not processed" (D-32 rule 4), for the plain-words note next to it. */
export type NotProcessedReason = 'daily_cap' | 'failed' | 'skipped';

export function notProcessedReasonOf(lead: LeadRecord, status: LeadDisplayStatus): NotProcessedReason | null {
  if (status !== 'not_processed') return null;
  if (lead.processingState === 'deferred') return 'daily_cap';
  if (lead.processingState === 'failed') return 'failed';
  if (lead.processingState === 'skipped') return 'skipped';
  return null;
}
