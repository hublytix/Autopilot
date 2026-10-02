import 'server-only';
import { z } from 'zod';
import {
  ACCOUNT_PROCESSING_STATES,
  CLASSIFICATIONS,
  CONNECTION_STATUSES,
  LOGGING_MODES,
  STOP_REASONS,
  WEEKLY_REPORT_STATUSES,
  type AccountProcessingState,
  type ConnectionStatus,
  type LoggingMode,
  type WeeklyReportStatus,
} from '@/server/domain/types';
import { parseWeeklyMetrics, type WeeklyMetrics, type WeeklyMetricsLead, type WeeklyMetricsPeriod } from '@/server/domain/weekly-metrics';
import type { Db } from '@/server/db';
import type { ReportRef } from './keys';

// `weekly_reports` rows and what the Monday report reads (PLAN §5, §9.8). Ids, instants and numbers
// only: the metrics never hold content (law 4), and nothing read here is logged.

export interface ReportRow {
  readonly id: string;
  readonly accountId: string;
  readonly weekStart: string;
  /** The zone the period was computed in (D-17). */
  readonly timezone: string;
  readonly period: WeeklyMetricsPeriod;
  /** Null until the job stores them (or when stored metrics are of another shape). */
  readonly metrics: WeeklyMetrics | null;
  readonly status: WeeklyReportStatus;
  readonly attempts: number;
}

const reportRow = z.object({
  id: z.string(),
  account_id: z.string(),
  week_start: z.string(),
  timezone: z.string(),
  period_start: z.date(),
  period_end: z.date(),
  metrics: z.unknown(),
  status: z.enum(WEEKLY_REPORT_STATUSES),
  attempts: z.number(),
});

export async function loadReport(db: Db, ref: ReportRef): Promise<ReportRow | null> {
  const raw = await db.maybeOne(
    `select id, account_id, week_start::text as week_start, timezone, period_start, period_end, metrics, status, attempts
       from weekly_reports where account_id = $1 and week_start = $2::date`,
    [ref.accountId, ref.weekStart],
  );
  if (raw === null) return null;
  const row = reportRow.parse(raw);
  return {
    id: row.id,
    accountId: row.account_id,
    weekStart: row.week_start,
    timezone: row.timezone,
    period: { start: row.period_start, end: row.period_end },
    metrics: row.metrics === null ? null : parseWeeklyMetrics(row.metrics),
    status: row.status,
    attempts: row.attempts,
  };
}

/** Stores the metrics before the email is reserved (PLAN §9.8 step 5); false once the report was sent. */
export async function storeMetrics(db: Db, reportId: string, metrics: WeeklyMetrics): Promise<boolean> {
  const rows = await db.query(`update weekly_reports set metrics = $2::jsonb where id = $1 and status <> 'sent' returning id`, [reportId, metrics]);
  return rows.length === 1;
}

export async function markReportSent(db: Db, reportId: string): Promise<void> {
  await db.query(`update weekly_reports set status = 'sent' where id = $1 and status <> 'sent'`, [reportId]);
}

/** The failure path (PLAN §8.3 step 6): `failed`, never over `sent`. */
export async function markReportFailed(db: Db, ref: ReportRef): Promise<boolean> {
  const rows = await db.query(
    `update weekly_reports set status = 'failed'
      where account_id = $1 and week_start = $2::date and status <> 'sent' and status <> 'failed' returning id`,
    [ref.accountId, ref.weekStart],
  );
  return rows.length === 1;
}

// ---------------------------------------------------------------------------------------------
// The account
// ---------------------------------------------------------------------------------------------

export interface ReportAccount {
  readonly accountId: string;
  readonly processingState: AccountProcessingState;
  readonly onboardingCompletedAt: Date | null;
  readonly connectionStatus: ConnectionStatus | null;
  /** The connection's granted scopes (D-03: the email scope decides what can be confirmed). */
  readonly scopes: readonly string[];
  readonly loggingMode: LoggingMode;
  readonly portalId: string | null;
  readonly uiDomain: string | null;
  /** The verified notify addresses; the owner's sign-in address when none is verified (D-46). */
  readonly to: readonly string[];
  /** The owner's own sign-in address (D-27), never a lead's or a support inbox. */
  readonly replyTo: string | null;
}

const accountRow = z.object({
  id: z.string(),
  processing_state: z.enum(ACCOUNT_PROCESSING_STATES),
  onboarding_completed_at: z.date().nullable(),
  connection_status: z.enum(CONNECTION_STATUSES).nullable(),
  scopes: z.array(z.string()).nullable(),
  logging_mode: z.enum(LOGGING_MODES),
  portal_id: z.string().nullable(),
  ui_domain: z.string().nullable(),
  verified: z.array(z.string()).nullable(),
  owner_email: z.string().nullable(),
});

function uniqueAddresses(addresses: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of addresses) {
    const address = raw.trim();
    if (address === '' || seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    out.push(address);
  }
  return out;
}

export async function loadReportAccount(db: Db, accountId: string): Promise<ReportAccount | null> {
  const raw = await db.maybeOne(
    `select a.id, a.processing_state, a.onboarding_completed_at, c.status as connection_status, c.scopes, a.logging_mode,
            a.hubspot_portal_id as portal_id, c.ui_domain, s.notify_emails_verified as verified, u.email as owner_email
       from accounts a
       left join hubspot_connections c on c.account_id = a.id
       left join settings s on s.account_id = a.id
       left join users u on u.account_id = a.id and u.auth_user_id = a.owner_user_id
      where a.id = $1`,
    [accountId],
  );
  if (raw === null) return null;
  const row = accountRow.parse(raw);
  const ownerEmail = row.owner_email?.trim() ?? '';
  const verified = uniqueAddresses(row.verified ?? []);
  return {
    accountId: row.id,
    processingState: row.processing_state,
    onboardingCompletedAt: row.onboarding_completed_at,
    connectionStatus: row.connection_status,
    scopes: row.scopes ?? [],
    loggingMode: row.logging_mode,
    portalId: row.portal_id,
    uiDomain: row.ui_domain,
    to: verified.length > 0 ? verified : ownerEmail === '' ? [] : [ownerEmail],
    replyTo: ownerEmail === '' ? null : ownerEmail,
  };
}

/** D-17's "who gets one": onboarding complete, `active`, with an active connection. */
export function isReportable(account: ReportAccount): boolean {
  return account.processingState === 'active' && account.onboardingCompletedAt !== null && account.connectionStatus === 'active';
}

// ---------------------------------------------------------------------------------------------
// The leads
// ---------------------------------------------------------------------------------------------

/** Submitted in the period, or with a reply or a follow-up email in it ($2 = start, $3 = end). */
const IN_PERIOD_EVENT = `((l.submitted_at >= $2 and l.submitted_at < $3)
     or (l.replied_at >= $2 and l.replied_at < $3)
     or (l.fu1_notified_at >= $2 and l.fu1_notified_at < $3)
     or (l.fu2_notified_at >= $2 and l.fu2_notified_at < $3))`;

/** The account's non-test leads submitted in the period, or with a reply or a follow-up email in it. */
const IN_PERIOD = `l.account_id = $1 and not l.is_test and ${IN_PERIOD_EVENT}`;

/**
 * Replies are also looked for on the leads the owner was emailed about in the 30 days before the
 * period end (the content window) that have no reply recorded and were not dismissed (D-77): a lead
 * from an earlier week whose follow-ups had ended is otherwise never read again, and "Replies from
 * leads" would say 0 for a reply HubSpot logged this week (law 3).
 */
export const REPLY_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The leads whose signals the report refreshes first (PLAN §9.8 step 3), in this order: the cohort
 * and the leads with events in the period, then the earlier leads still without a reply (D-77) —
 * among those HubSpot can say something about (the owner was emailed about them: a send or a reply
 * counts only after that, D-08; a contact to read; no privacy deletion).
 */
export async function listRefreshLeads(db: Db, accountId: string, period: WeeklyMetricsPeriod): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    `select l.id from leads l
      where l.account_id = $1 and not l.is_test
        and l.first_notified_at is not null and l.hubspot_contact_id is not null
        and l.stop_reason is distinct from 'privacy_deletion'
        and (${IN_PERIOD_EVENT}
          or (l.replied_at is null and l.dismissed_at is null and l.first_notified_at >= $4 and l.first_notified_at < $3))
      order by case when ${IN_PERIOD_EVENT} then 0 else 1 end, l.submitted_at, l.id`,
    [accountId, period.start, period.end, new Date(period.end.getTime() - REPLY_LOOKBACK_MS)],
  );
  return rows.map((row) => row.id);
}

const leadRow = z.object({
  id: z.string(),
  is_test: z.boolean(),
  hubspot_contact_id: z.string().nullable(),
  submitted_at: z.date(),
  classification: z.enum(CLASSIFICATIONS).nullable(),
  classification_override: z.enum(CLASSIFICATIONS).nullable(),
  process_rev: z.number(),
  stop_reason: z.enum(STOP_REASONS).nullable(),
  first_notified_at: z.date().nullable(),
  first_send_clicked_at: z.date().nullable(),
  send_confirmed_at: z.date().nullable(),
  replied_at: z.date().nullable(),
  dismissed_at: z.date().nullable(),
  fu1_notified_at: z.date().nullable(),
  fu2_notified_at: z.date().nullable(),
});

/** computeWeeklyMetrics' rows: the cohort and the leads with events in the period. */
export async function loadMetricLeads(db: Db, accountId: string, period: WeeklyMetricsPeriod): Promise<WeeklyMetricsLead[]> {
  const rows = await db.query(
    `select l.id, l.is_test, l.hubspot_contact_id, l.submitted_at, l.classification, l.classification_override, l.process_rev,
            l.stop_reason, l.first_notified_at, l.first_send_clicked_at, l.send_confirmed_at, l.replied_at, l.dismissed_at,
            l.fu1_notified_at, l.fu2_notified_at
       from leads l
      where ${IN_PERIOD}
      order by l.submitted_at, l.id`,
    [accountId, period.start, period.end],
  );
  return rows.map((raw) => {
    const row = leadRow.parse(raw);
    return {
      id: row.id,
      isTest: row.is_test,
      hubspotContactId: row.hubspot_contact_id,
      submittedAt: row.submitted_at,
      classification: row.classification,
      classificationOverride: row.classification_override,
      processRev: row.process_rev,
      stopReason: row.stop_reason,
      firstNotifiedAt: row.first_notified_at,
      firstSendClickedAt: row.first_send_clicked_at,
      sendConfirmedAt: row.send_confirmed_at,
      repliedAt: row.replied_at,
      dismissedAt: row.dismissed_at,
      fu1NotifiedAt: row.fu1_notified_at,
      fu2NotifiedAt: row.fu2_notified_at,
    };
  });
}
