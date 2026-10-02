import 'server-only';
import { z } from 'zod';
import { defangLeadText } from '@/server/domain/defang';
import {
  DRAFT_KINDS,
  isDraftFlag,
  type Classification,
  type DraftFlag,
  type DraftKind,
  type LeadDisplayStatus,
  type LoggingMode,
  type StopReason,
} from '@/server/domain/types';
import type { Db } from '@/server/db';
import type { Deps } from '@/server/ports';
import type { OwnerScope } from '@/server/services/auth/owner-scope';
import { loadFollowUpNotes } from '@/server/services/followups/notes';
import { connectionActive, emailScopeGranted, loadAccountContext, type AccountContext } from './account';
import { formatInZone } from './format';
import {
  leadSelect,
  leadNameOf,
  leadRecordUrl,
  leadStatusOf,
  notProcessedReasonOf,
  parseLeadId,
  parseLeadRecord,
  type LeadNameView,
  type LeadRecord,
  type NotProcessedReason,
} from './leads';

// /dashboard/leads/[id]'s read model (PLAN §7.5, D-31, D-32, D-42, D-47): the lead's timeline,
// its drafts until they are purged, the lead's message (defanged, "unverified") until it is purged,
// the follow-up notes, and which controls apply. Read by the OwnerScope's account id and the lead
// id together, so another account's lead is simply not found (a 404, PLAN §10.8). Database reads
// only; the page's HubSpot refresh is refresh.ts. Timestamps are the database's logical times
// (Clock-bound, or HubSpot's for confirmed sends and replies); none comes from `audit_log.at`.

/** The longest message shown (D-64's display limit, in characters). */
export const MESSAGE_DISPLAY_MAX_CHARS = 4000;
/** The company line's limit (D-64: a cleaned, defanged one-liner). */
export const ONE_LINE_MAX_CHARS = 200;

export type TimelineEvent =
  | { readonly kind: 'received'; readonly at: string }
  /** `overridden`: the owner said "This is a real lead" afterwards (D-42). */
  | { readonly kind: 'classified'; readonly at: string; readonly classification: Classification | null; readonly overridden: boolean }
  /** The first email to the owner, with the draft (or a starter draft that needs their touch). */
  | { readonly kind: 'emailed'; readonly at: string; readonly needsTouch: boolean }
  /** The send link was opened: a click, never a confirmed send (law 3, D-26). */
  | { readonly kind: 'send_link_opened'; readonly at: string }
  /** An email to the lead logged in HubSpot (HubSpot's time, D-08). */
  | { readonly kind: 'send_confirmed'; readonly at: string }
  /** The lead's reply logged in HubSpot (HubSpot's time); `resumed`: the owner resumed follow-ups after it (D-42). */
  | { readonly kind: 'lead_replied'; readonly at: string; readonly resumed: boolean }
  | { readonly kind: 'followups_resumed'; readonly at: string }
  | { readonly kind: 'followup_emailed'; readonly at: string; readonly n: 1 | 2 }
  | { readonly kind: 'dismissed'; readonly at: string };

export type DraftView =
  | { readonly kind: DraftKind; readonly state: 'available'; readonly subject: string; readonly body: string; readonly flags: readonly DraftFlag[]; readonly needsTouch: boolean }
  /** Purged with the lead's content (D-49): "This draft has expired". */
  | { readonly kind: DraftKind; readonly state: 'expired' };

export type MessageView =
  | { readonly state: 'available'; readonly text: string; readonly truncated: boolean }
  /** The form had no message. */
  | { readonly state: 'empty' }
  | { readonly state: 'expired'; readonly reason: 'purged' | 'privacy_deleted' };

/** "This is a real lead" (filtered leads only): shown, or why it cannot be used now. */
export type RealLeadControl = 'available' | 'content_gone' | 'account_not_active' | null;
/** "Resume follow-ups" (leads the lead replied to): shown, or why it cannot be used now; null hides it (D-42, D-71). */
export type ResumeControl = 'available' | 'account_not_active' | 'followups_off' | null;

export interface LeadDetailView {
  readonly id: string;
  readonly isTest: boolean;
  readonly name: LeadNameView;
  /** Defanged one-liner while the content is stored. */
  readonly company: string | null;
  readonly status: LeadDisplayStatus;
  readonly statusLabel: string;
  readonly notProcessed: NotProcessedReason | null;
  readonly receivedAt: string;
  readonly recordUrl: string | null;
  readonly timeline: readonly TimelineEvent[];
  /** Why follow-ups stopped, when they did. */
  readonly stopReason: StopReason | null;
  /** Follow-ups still scheduled for the current stream, in order. */
  readonly upcomingFollowUps: readonly { readonly n: 1 | 2; readonly at: string }[];
  /** Follow-ups that could not be drafted or emailed (the follow-up failure path's notes, D-70). */
  readonly failedFollowUps: readonly (1 | 2)[];
  readonly drafts: readonly DraftView[];
  readonly message: MessageView;
  readonly controls: {
    readonly realLead: RealLeadControl;
    readonly resumeFollowUps: ResumeControl;
    readonly dismiss: boolean;
  };
  readonly signals: {
    /** The last read of HubSpot that saw every logged email ("Tue 6 Oct, 10:15"), or null. */
    readonly checkedAt: string | null;
    /** The HubSpot connection is active (a read can happen at all). */
    readonly connectionActive: boolean;
    /** The grant includes `sales-email-read` (whatever the connection's state). */
    readonly emailScope: boolean;
    readonly loggingMode: LoggingMode;
  };
  readonly zone: string;
}

interface Timed {
  readonly ms: number;
  readonly order: number;
  readonly event: TimelineEvent;
}

const draftRow = z.object({
  kind: z.enum(DRAFT_KINDS),
  subject: z.string().nullable(),
  body: z.string().nullable(),
  flags: z.array(z.string()),
  needs_touch: z.boolean(),
  purged_at: z.date().nullable(),
  expired: z.boolean(),
});

/**
 * The drafts until they are purged (D-49). A draft counts as expired once it was purged, once its
 * `purge_at` has passed (the hourly purge may not have run yet), or once the lead's content is gone
 * (a purge that removed the message but not, or not yet, the drafts): the token pages' rule too.
 */
async function loadDrafts(db: Db, accountId: string, lead: LeadRecord, now: Date): Promise<DraftView[]> {
  const rows = await db.query(
    `select kind, subject, body, flags, needs_touch, purged_at, (purge_at <= $3) as expired from drafts where lead_id = $1 and account_id = $2`,
    [lead.id, accountId, now],
  );
  const drafts: DraftView[] = [];
  for (const raw of rows) {
    const row = draftRow.parse(raw);
    if (row.purged_at !== null || row.expired || !lead.hasContent) {
      drafts.push({ kind: row.kind, state: 'expired' });
    } else if (row.subject !== null && row.body !== null) {
      drafts.push({ kind: row.kind, state: 'available', subject: row.subject, body: row.body, flags: row.flags.filter(isDraftFlag), needsTouch: row.needs_touch });
    }
    // An empty row that is not purged, of a lead whose content is still stored, is the daily cap's slot (D-63): nothing drafted yet.
  }
  return drafts.sort((a, b) => DRAFT_KINDS.indexOf(a.kind) - DRAFT_KINDS.indexOf(b.kind));
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  const chars = Array.from(text);
  return chars.length <= max ? { text, truncated: false } : { text: `${chars.slice(0, max).join('')}…`, truncated: true };
}

const contentRow = z.object({ message: z.string().nullable(), company: z.string().nullable() });

async function loadContent(db: Db, accountId: string, lead: LeadRecord, now: Date): Promise<{ message: MessageView; company: string | null }> {
  const raw = lead.hasContent
    ? await db.maybeOne(`select message, company from lead_messages where lead_id = $1 and account_id = $2 and purge_at > $3`, [lead.id, accountId, now])
    : null;
  if (raw === null) return { message: { state: 'expired', reason: lead.stopReason === 'privacy_deletion' ? 'privacy_deleted' : 'purged' }, company: null };
  const row = contentRow.parse(raw);
  const company = row.company === null ? '' : defangLeadText(row.company).replace(/\s+/gu, ' ').trim();
  const text = row.message === null ? '' : defangLeadText(row.message).trim();
  return {
    message: text === '' ? { state: 'empty' } : { state: 'available', ...truncate(text, MESSAGE_DISPLAY_MAX_CHARS) },
    company: company === '' ? null : truncate(company, ONE_LINE_MAX_CHARS).text,
  };
}

const upcomingRow = z.object({ seq: z.number().int(), run_at: z.date(), target_at: z.string().nullable() });

async function loadUpcoming(db: Db, accountId: string, lead: LeadRecord, context: AccountContext, now: Date): Promise<{ n: 1 | 2; at: string }[]> {
  const rows = await db.query(
    `select seq, run_at, payload ->> 'targetAt' as target_at from scheduled_jobs
      where lead_id = $1 and account_id = $2 and kind = 'followup' and status in ('scheduled', 'running')
        and payload ->> 'followupStream' = $3
      order by seq`,
    [lead.id, accountId, String(lead.followupStream)],
  );
  const out: { n: 1 | 2; at: string }[] = [];
  for (const raw of rows) {
    const row = upcomingRow.parse(raw);
    if (row.seq !== 1 && row.seq !== 2) continue;
    const target = row.target_at === null ? null : new Date(row.target_at);
    const at = target !== null && !Number.isNaN(target.getTime()) ? target : row.run_at;
    out.push({ n: row.seq, at: formatInZone(at, context.zone, now) });
  }
  return out;
}

const resumedRow = z.object({ replied_at: z.string().nullable() });

/** The replies the owner set aside with "Resume follow-ups" (audit meta `repliedAt`, HubSpot's times). */
async function loadResumedReplies(db: Db, accountId: string, leadId: string): Promise<Date[]> {
  const rows = await db.query(
    `select meta ->> 'repliedAt' as replied_at from audit_log
      where account_id = $1 and action = 'lead.followups_resumed' and meta ->> 'leadId' = $2
      order by id`,
    [accountId, leadId],
  );
  const out: Date[] = [];
  for (const raw of rows) {
    const value = resumedRow.parse(raw).replied_at;
    const at = value === null ? null : new Date(value);
    if (at !== null && !Number.isNaN(at.getTime())) out.push(at);
  }
  return out;
}

function timeline(lead: LeadRecord, resumedReplies: readonly Date[], context: AccountContext, now: Date): TimelineEvent[] {
  const items: Timed[] = [];
  const add = (at: Date | null, order: number, event: (text: string) => TimelineEvent): void => {
    if (at !== null) items.push({ ms: at.getTime(), order, event: event(formatInZone(at, context.zone, now)) });
  };
  add(lead.receivedAt, 0, (at) => ({ kind: 'received', at }));
  add(lead.classifiedAt, 1, (at) => ({
    kind: 'classified',
    at,
    classification: lead.classification,
    overridden: lead.processRev > 0 || lead.classificationOverride !== null,
  }));
  add(lead.firstNotifiedAt, 2, (at) => ({ kind: 'emailed', at, needsTouch: lead.needsTouch }));
  add(lead.firstSendClickedAt, 3, (at) => ({ kind: 'send_link_opened', at }));
  add(lead.sendConfirmedAt, 4, (at) => ({ kind: 'send_confirmed', at }));
  for (const repliedAt of resumedReplies) add(repliedAt, 5, (at) => ({ kind: 'lead_replied', at, resumed: true }));
  add(lead.repliesIgnoredBefore, 6, (at) => ({ kind: 'followups_resumed', at }));
  add(lead.fu1NotifiedAt, 7, (at) => ({ kind: 'followup_emailed', at, n: 1 }));
  add(lead.fu2NotifiedAt, 8, (at) => ({ kind: 'followup_emailed', at, n: 2 }));
  add(lead.repliedAt, 9, (at) => ({ kind: 'lead_replied', at, resumed: false }));
  add(lead.dismissedAt, 10, (at) => ({ kind: 'dismissed', at }));
  return items.sort((a, b) => a.ms - b.ms || a.order - b.order).map((item) => item.event);
}

function realLeadControl(lead: LeadRecord, status: LeadDisplayStatus, context: AccountContext): RealLeadControl {
  if (status !== 'filtered' || lead.processingState !== 'filtered' || lead.isTest || lead.dismissedAt !== null || lead.stopReason === 'privacy_deletion') return null;
  if (!lead.hasContent) return 'content_gone';
  return context.processingState === 'active' ? 'available' : 'account_not_active';
}

/** Offered for a lead that replied and that Resume would actually resume (not a refusal such as `stopped` or `not_notified`, D-71). */
function resumeControl(lead: LeadRecord, context: AccountContext): ResumeControl {
  const replied = lead.repliedAt !== null || lead.stopReason === 'replied';
  if (!replied || lead.isTest || lead.dismissedAt !== null || lead.firstNotifiedAt === null) return null;
  if (lead.stopReason !== null && lead.stopReason !== 'replied') return null;
  if (context.processingState !== 'active') return 'account_not_active';
  return context.followupsEnabled ? 'available' : 'followups_off';
}

/** The lead page's model, or null when the id is not a lead of the owner's account (the page answers 404). */
export async function leadDetailView(scope: OwnerScope, deps: Pick<Deps, 'db' | 'clock'>, leadIdInput: string): Promise<LeadDetailView | null> {
  const leadId = parseLeadId(leadIdInput);
  if (leadId === null) return null;
  const { db } = deps;
  const accountId = scope.accountId;
  const now = deps.clock.now();
  const raw = await db.maybeOne(
    `select ${leadSelect('$3')}
       from leads l left join lead_messages m on m.lead_id = l.id and m.account_id = l.account_id
      where l.id = $1 and l.account_id = $2`,
    [leadId, accountId, now],
  );
  if (raw === null) return null;
  const lead = parseLeadRecord(raw);
  const context = await loadAccountContext(db, accountId);
  const { status, label } = leadStatusOf(lead, context, now);
  const { message, company } = await loadContent(db, accountId, lead, now);
  const notes = await loadFollowUpNotes(db, { accountId, leadId });
  return {
    id: lead.id,
    isTest: lead.isTest,
    name: leadNameOf(lead),
    company,
    status,
    statusLabel: label,
    notProcessed: notProcessedReasonOf(lead, status),
    receivedAt: formatInZone(lead.receivedAt, context.zone, now),
    recordUrl: lead.isTest ? null : leadRecordUrl(lead, context),
    timeline: timeline(lead, await loadResumedReplies(db, accountId, leadId), context, now),
    stopReason: lead.stopReason,
    upcomingFollowUps: await loadUpcoming(db, accountId, lead, context, now),
    failedFollowUps: [...new Set(notes.filter((note) => note.followupStream === lead.followupStream).map((note) => note.n))].sort((a, b) => a - b),
    drafts: await loadDrafts(db, accountId, lead, now),
    message,
    controls: {
      realLead: realLeadControl(lead, status, context),
      resumeFollowUps: resumeControl(lead, context),
      dismiss: lead.dismissedAt === null,
    },
    signals: {
      checkedAt: lead.signalsCheckedAt === null ? null : formatInZone(lead.signalsCheckedAt, context.zone, now),
      connectionActive: connectionActive(context),
      emailScope: emailScopeGranted(context),
      loggingMode: context.loggingMode,
    },
    zone: context.zone,
  };
}
