import 'server-only';
import { z } from 'zod';
import { BASELINE_REASONS, baselineReason } from './baseline';
import {
  isDraftableClassification,
  LOGGING_MODES,
  type BaselineStatus,
  type Classification,
  type LoggingMode,
  type StopReason,
} from './types';

// The Monday report's numbers (PLAN §9.8 step 4, D-17, D-37, D-38, D-74, D-77). Pure: the job
// refreshes the signals first, loads the rows and calls computeWeeklyMetrics; the result is stored in
// `weekly_reports.metrics` (ids, instants and numbers only, never content) before the email is
// reserved, so a resumed send re-renders exactly what was computed.
//
// Every event time is read up to the period end only (half-open, `at < end`), so a lead notified,
// clicked, confirmed or dismissed after Monday 08:00 changes nothing, whenever the job runs (D-17).
//
// Cohort: non-test leads SUBMITTED in the period [start, end).
//   leadsIn                     every cohort lead
//   filtered                    a filtered class (spam, vendor pitch, …) not overridden by the owner
//   draftsEmailed               first_notified_at before the end
//   sendsConfirmed              send_confirmed_at before the end
//   sendLinkOpenedNotConfirmed  first_send_clicked_at before the end, no send confirmed before it
//   medianTimeToFirstReply      submitted_at → send_confirmed_at over the leads confirmed before the
//                               end (whole seconds, clamped at 0); n ≥ 3, else "Not enough data"; an
//                               even n takes the mean of the two middle values
//   waiting                     notified and not dismissed before the end, no send confirmed before
//                               it, read in full by this report's refresh, and not deleted at the
//                               contact's request (oldest first, the first 20 with their HubSpot
//                               record links, "and N more")
//   unchecked                   cohort leads this report's refresh could not read in full (HubSpot's
//                               403 or cut-off email paging, an error on the lead, the budget spent):
//                               never claimed as waiting ("N leads couldn't be checked in HubSpot")
// Events: non-test leads, any submission time, by the event's own time in the period.
//   repliesFromLeads            replied_at in the period
//   followUpsDrafted            fu1_notified_at in the period + fu2_notified_at in the period
// Comparison with the baseline (D-38's population): cohort leads whose effective class is lead or
//   unclear (or overridden: "This is a real lead"), not dismissed before the end and not deleted at
//   the contact's request (they can no longer be checked). Over that population: the median wait
//   (n ≥ 3), and "% with no logged reply from you" = those read in full without a send confirmed
//   before the end, over the population; "Not enough data" while any of them is unchecked.
// Honesty (D-37, law 3): a count over 0 is always shown. A 0 becomes "Not enough data" (null) for
//   replies when logging_mode ≠ log_all, the email scope is missing or a refreshed lead is unchecked,
//   and for sends when logging_mode ∈ {none, unknown}, the email scope is missing or a cohort lead
//   is unchecked. When sends cannot be confirmed, the waiting list is replaced by "We can't confirm
//   your sends in HubSpot for your account" (null), and the "% with no logged reply from you" is "Not
//   enough data" unless it is 0% (every lead in the population has a confirmed send). A percentage is
//   0 or 100 only when exactly none or all are counted (else 1..99). The baseline side keeps the
//   baseline's reason: too many submissions or no leads → "Not enough data", no logged email or not
//   readable → "Not enough logged history" (the onboarding page's words); none stored → "Not enough data".

/** The median needs at least this many leads with a confirmed send (D-37, as D-38). */
export const MIN_MEDIAN_SAMPLES = 3;
/** Record links listed for the waiting leads; the rest are "and N more" (D-37). */
export const MAX_WAITING_LISTED = 20;
/** `hubspot/scopes.ts` EMAIL_READ_SCOPE: reading logged email metadata (D-03). */
export const EMAIL_SCOPE = 'sales-email-read';
export const WEEKLY_METRICS_VERSION = 1;

/** The lead fields the report reads (one `leads` row). */
export interface WeeklyMetricsLead {
  readonly id: string;
  readonly isTest: boolean;
  readonly hubspotContactId: string | null;
  readonly submittedAt: Date;
  readonly classification: Classification | null;
  readonly classificationOverride: Classification | null;
  readonly processRev: number;
  readonly stopReason: StopReason | null;
  readonly firstNotifiedAt: Date | null;
  readonly firstSendClickedAt: Date | null;
  readonly sendConfirmedAt: Date | null;
  readonly repliedAt: Date | null;
  readonly dismissedAt: Date | null;
  readonly fu1NotifiedAt: Date | null;
  readonly fu2NotifiedAt: Date | null;
}

/** The account's newest `baselines` row (D-38), or null when none was ever stored. */
export interface WeeklyMetricsBaseline {
  readonly status: BaselineStatus;
  /** Submissions the baseline read (above 500: "Not enough data"). */
  readonly submissionsRead: number;
  readonly leadsCounted: number;
  readonly medianSecondsToFirstOutbound: number | null;
  readonly withoutOutboundCount: number | null;
  readonly percentAvailable: boolean;
}

export interface WeeklyMetricsPeriod {
  /** Inclusive. */
  readonly start: Date;
  /** Exclusive. */
  readonly end: Date;
}

/** The contact's HubSpot record URL, or null when it cannot be built. */
export type RecordUrlOf = (contactId: string | null) => string | null;

/** What this report's refresh could not read in full (PLAN §9.8 step 3, D-77). */
export interface WeeklyMetricsChecks {
  /** Lead ids whose emails HubSpot did not let the refresh read in full this run. */
  readonly unchecked: ReadonlySet<string>;
}

const ALL_CHECKED: WeeklyMetricsChecks = { unchecked: new Set<string>() };

const isoInstant = z.iso.datetime();
const count = z.number().int().nonnegative();
const seconds = z.number().nonnegative();
const percent = z.number().int().min(0).max(100);

export const waitingLeadSchema = z.object({
  leadId: z.string(),
  submittedAt: isoInstant,
  recordUrl: z.string().nullable(),
});

/** `weekly_reports.metrics`. A null value is shown as "Not enough data" unless noted. */
export const weeklyMetricsSchema = z.object({
  version: z.literal(WEEKLY_METRICS_VERSION),
  period: z.object({ start: isoInstant, end: isoInstant }),
  /** What the honesty rules read (D-37). */
  basis: z.object({
    loggingMode: z.enum(LOGGING_MODES),
    emailScope: z.boolean(),
    /** Sends can be confirmed: logging_mode log_all or sends_only, with the email scope. */
    sendsLogged: z.boolean(),
    /** Replies can be confirmed: logging_mode log_all, with the email scope. */
    repliesLogged: z.boolean(),
  }),
  cohort: z.object({
    leadsIn: count,
    filtered: count,
    draftsEmailed: count,
    sendsConfirmed: count.nullable(),
    sendLinkOpenedNotConfirmed: count,
    /** `seconds` null: fewer than MIN_MEDIAN_SAMPLES confirmed sends. */
    medianTimeToFirstReply: z.object({ seconds: seconds.nullable(), samples: count }),
    /** Null: "We can't confirm your sends in HubSpot for your account". */
    waiting: z
      .object({
        count,
        leads: z.array(waitingLeadSchema).max(MAX_WAITING_LISTED),
        /** "and N more". */
        more: count,
      })
      .nullable(),
    /** Cohort leads the report's refresh could not read in full: never counted as waiting. */
    unchecked: count,
  }),
  events: z.object({
    repliesFromLeads: count.nullable(),
    followUpsDrafted: count,
  }),
  comparison: z.object({
    /**
     * `ok`, `none` (no baseline was stored: "Not enough data"), or the stored baseline's reason
     * (domain/baseline.ts): too_many_submissions / no_leads → "Not enough data", no_logged_email /
     * not_readable → "Not enough logged history".
     */
    baseline: z.enum(['ok', 'none', ...BASELINE_REASONS]),
    baselineMedianSeconds: seconds.nullable(),
    baselinePercentWithoutReply: percent.nullable(),
    /** The median wait over the comparison population (n ≥ 3), not the whole cohort. */
    medianSeconds: seconds.nullable(),
    percentWithoutReply: percent.nullable(),
    /** The comparison population and those in it read in full with no send confirmed before the end. */
    population: count,
    withoutReply: count,
  }),
});

export type WeeklyMetrics = z.infer<typeof weeklyMetricsSchema>;
export type WeeklyWaitingLead = z.infer<typeof waitingLeadSchema>;

/** Parses stored metrics; null when they are missing or not this version's shape. */
export function parseWeeklyMetrics(raw: unknown): WeeklyMetrics | null {
  const parsed = weeklyMetricsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The median of `values`, or null for an empty list. Even length: the mean of the two middle values. */
export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? upper) + upper) / 2;
}

/**
 * A whole percent; null without a population. 0 and 100 only when exactly none or all are counted:
 * otherwise clamped to 1..99, so 1 of 201 never reads "0%" and 199 of 200 never "100%" (law 3).
 */
export function wholePercent(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  if (part <= 0) return 0;
  if (part >= whole) return 100;
  return Math.min(99, Math.max(1, Math.round((part / whole) * 100)));
}

/** The owner said "This is a real lead" (D-42); the reading deriveLeadStatus and lead_process use. */
function isOverridden(lead: WeeklyMetricsLead): boolean {
  return lead.processRev > 0 || lead.classificationOverride !== null;
}

function isFiltered(lead: WeeklyMetricsLead): boolean {
  return !isOverridden(lead) && lead.classification !== null && !isDraftableClassification(lead.classification);
}

/** Effective class lead/unclear, or overridden (D-37's comparison population, D-38's baseline population). */
function isLeadClass(lead: WeeklyMetricsLead): boolean {
  return isOverridden(lead) || (lead.classification !== null && isDraftableClassification(lead.classification));
}

function within(at: Date | null, period: WeeklyMetricsPeriod): boolean {
  return at !== null && at.getTime() >= period.start.getTime() && at.getTime() < period.end.getTime();
}

/** The event happened before the (exclusive) period end. */
function before(at: Date | null, end: Date): boolean {
  return at !== null && at.getTime() < end.getTime();
}

function confirmedBefore(lead: WeeklyMetricsLead, end: Date): boolean {
  return before(lead.sendConfirmedAt, end);
}

/** Submission → confirmed send, in whole seconds, never negative (D-74 choice 2). */
function waitSeconds(lead: WeeklyMetricsLead): number {
  return Math.max(0, Math.round(((lead.sendConfirmedAt?.getTime() ?? 0) - lead.submittedAt.getTime()) / 1000));
}

function medianWait(leads: readonly WeeklyMetricsLead[]): number | null {
  return leads.length >= MIN_MEDIAN_SAMPLES ? medianOf(leads.map(waitSeconds)) : null;
}

function byAge(a: WeeklyMetricsLead, b: WeeklyMetricsLead): number {
  return a.submittedAt.getTime() - b.submittedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** A count, or null ("Not enough data") when it is 0 and the data could not have shown it. */
function honest(value: number, supported: boolean): number | null {
  return value > 0 || supported ? value : null;
}

function baselineSide(baseline: WeeklyMetricsBaseline | null): Pick<
  WeeklyMetrics['comparison'],
  'baseline' | 'baselineMedianSeconds' | 'baselinePercentWithoutReply'
> {
  if (baseline === null) return { baseline: 'none', baselineMedianSeconds: null, baselinePercentWithoutReply: null };
  const reason = baselineReason(baseline);
  if (reason !== null) return { baseline: reason, baselineMedianSeconds: null, baselinePercentWithoutReply: null };
  return {
    baseline: 'ok',
    baselineMedianSeconds: baseline.medianSecondsToFirstOutbound,
    baselinePercentWithoutReply:
      baseline.percentAvailable && baseline.withoutOutboundCount !== null ? wholePercent(baseline.withoutOutboundCount, baseline.leadsCounted) : null,
  };
}

/**
 * PLAN §9.8 step 4. `rows` may hold any of the account's leads (test leads are ignored); the
 * cohort and the events are selected here by `period`. `checks` names the leads this report's
 * refresh could not read in full (none by default).
 */
export function computeWeeklyMetrics(
  rows: readonly WeeklyMetricsLead[],
  baseline: WeeklyMetricsBaseline | null,
  loggingMode: LoggingMode,
  scopes: readonly string[],
  period: WeeklyMetricsPeriod,
  recordUrl: RecordUrlOf,
  checks: WeeklyMetricsChecks = ALL_CHECKED,
): WeeklyMetrics {
  const end = period.end;
  const emailScope = scopes.includes(EMAIL_SCOPE);
  const sendsLogged = emailScope && (loggingMode === 'log_all' || loggingMode === 'sends_only');
  const repliesLogged = emailScope && loggingMode === 'log_all';
  const unchecked = (lead: WeeklyMetricsLead): boolean => checks.unchecked.has(lead.id);
  const dismissed = (lead: WeeklyMetricsLead): boolean => before(lead.dismissedAt, end);
  const privacyDeleted = (lead: WeeklyMetricsLead): boolean => lead.stopReason === 'privacy_deletion';

  const leads = rows.filter((lead) => !lead.isTest);
  const cohort = leads.filter((lead) => within(lead.submittedAt, period));
  const confirmed = cohort.filter((lead) => confirmedBefore(lead, end));
  const cohortUnchecked = cohort.filter(unchecked).length;

  const waitingLeads = cohort
    .filter((lead) => before(lead.firstNotifiedAt, end) && !dismissed(lead) && !confirmedBefore(lead, end))
    .filter((lead) => !privacyDeleted(lead) && !unchecked(lead))
    .sort(byAge);

  const population = cohort.filter((lead) => isLeadClass(lead) && !dismissed(lead) && !privacyDeleted(lead));
  const withoutReply = population.filter((lead) => !confirmedBefore(lead, end) && !unchecked(lead)).length;
  const populationChecked = !population.some(unchecked);

  const replies = leads.filter((lead) => within(lead.repliedAt, period)).length;
  const followUps = leads.filter((lead) => within(lead.fu1NotifiedAt, period)).length + leads.filter((lead) => within(lead.fu2NotifiedAt, period)).length;

  return {
    version: WEEKLY_METRICS_VERSION,
    period: { start: period.start.toISOString(), end: end.toISOString() },
    basis: { loggingMode, emailScope, sendsLogged, repliesLogged },
    cohort: {
      leadsIn: cohort.length,
      filtered: cohort.filter(isFiltered).length,
      draftsEmailed: cohort.filter((lead) => before(lead.firstNotifiedAt, end)).length,
      sendsConfirmed: honest(confirmed.length, sendsLogged && cohortUnchecked === 0),
      sendLinkOpenedNotConfirmed: cohort.filter((lead) => before(lead.firstSendClickedAt, end) && !confirmedBefore(lead, end)).length,
      medianTimeToFirstReply: { seconds: medianWait(confirmed), samples: confirmed.length },
      waiting: sendsLogged
        ? {
            count: waitingLeads.length,
            leads: waitingLeads.slice(0, MAX_WAITING_LISTED).map((lead) => ({
              leadId: lead.id,
              submittedAt: lead.submittedAt.toISOString(),
              recordUrl: recordUrl(lead.hubspotContactId),
            })),
            more: Math.max(0, waitingLeads.length - MAX_WAITING_LISTED),
          }
        : null,
      unchecked: cohortUnchecked,
    },
    events: {
      repliesFromLeads: honest(replies, repliesLogged && checks.unchecked.size === 0),
      followUpsDrafted: followUps,
    },
    comparison: {
      ...baselineSide(baseline),
      medianSeconds: medianWait(population.filter((lead) => confirmedBefore(lead, end))),
      percentWithoutReply: populationChecked && (sendsLogged || withoutReply === 0) ? wholePercent(withoutReply, population.length) : null,
      population: population.length,
      withoutReply,
    },
  };
}
