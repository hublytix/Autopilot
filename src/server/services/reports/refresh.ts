import 'server-only';
import { errorCode, isAppError, isRetryable, isRevoked } from '@/server/domain/errors';
import type { WeeklyMetricsPeriod } from '@/server/domain/weekly-metrics';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { forAccount, type PortalHubSpotClient, type Sleep } from '@/server/services/hubspot';
import type { NotificationRegistry } from '@/server/services/notifications/renderers';
import { applySignals } from '@/server/services/signals';
import { listRefreshLeads } from './repository';

// PLAN §9.8 step 3, D-17: before the numbers, the signals of the cohort and of the leads with events
// in the period — then of the earlier leads still without a reply (D-77) — are refreshed from HubSpot
// (applySignals, caller `refresh`: AND NOT is_test in every statement, one portal client for the run,
// so its limiter paces the calls), so the order in which jobs ran can't change the report. A refresh
// writes only what HubSpot confirms (D-08), and finding a reply records it as a refresh does anywhere
// (markReplied; the reply email only when it cancelled a scheduled follow-up).
// - a revoked connection ends the run: no report (the account is no longer reportable);
// - a retryable HubSpot error propagates: the job is retried (a daily-limit wait re-targets it);
// - any other error on one lead is logged (codes only) and that lead keeps what is stored, which
//   HubSpot already confirmed (law 3: a report may count less, never more);
// - once the budget is spent the remaining leads keep what is stored, likewise.
// Every lead not read in full this run — an error, the budget, or a read that could not see every
// logged email (`emailsAvailable: false`: a 403, the association paging cut short) — is returned in
// `unchecked`, and the metrics never claim "nothing logged in HubSpot" for it (law 3, D-77).

/** Inside the run route's 300 s maxDuration, leaving time to compute, store and send. */
export const REPORT_REFRESH_BUDGET_MS = 180_000;

export interface RefreshReportInput {
  readonly accountId: string;
  readonly period: WeeklyMetricsPeriod;
  /** Epoch ms after which no further lead is read. */
  readonly deadlineMs: number;
  readonly sleep?: Sleep | undefined;
  readonly notifications?: NotificationRegistry | undefined;
  readonly client?: PortalHubSpotClient | undefined;
}

export type RefreshReportResult =
  | {
      readonly type: 'refreshed';
      /** Leads read in full. */
      readonly refreshed: number;
      /** Leads whose read failed (logged by code). */
      readonly failed: number;
      /** Leads left unread when the budget was spent. */
      readonly unread: number;
      /** Every lead not read in full: failed, unread, or read without every logged email. */
      readonly unchecked: readonly string[];
    }
  | { readonly type: 'revoked'; readonly code: string };

export async function refreshReportSignals(deps: Deps, input: RefreshReportInput): Promise<RefreshReportResult> {
  const leadIds = await listRefreshLeads(deps.db, input.accountId, input.period);
  const client = input.client ?? forAccount(deps, input.accountId, { sleep: input.sleep });
  let refreshed = 0;
  let failed = 0;
  const unchecked: string[] = [];
  for (const [index, leadId] of leadIds.entries()) {
    if (deps.clock.now().getTime() >= input.deadlineMs) {
      const rest = leadIds.slice(index);
      log.warn('weekly report refresh budget spent', { event: 'weekly_report.refresh_budget', accountId: input.accountId, count: refreshed, remaining: rest.length });
      return { type: 'refreshed', refreshed, failed, unread: rest.length, unchecked: [...unchecked, ...rest] };
    }
    try {
      const result = await applySignals(deps, leadId, { caller: 'refresh', accountId: input.accountId, client, sleep: input.sleep, notifications: input.notifications });
      if (result.emailsAvailable) refreshed += 1;
      else unchecked.push(leadId);
    } catch (error) {
      if (isRevoked(error)) return { type: 'revoked', code: error.code };
      if (isRetryable(error)) throw error;
      if (!isAppError(error)) throw error;
      failed += 1;
      unchecked.push(leadId);
      log.warn('weekly report lead refresh failed', { event: 'weekly_report.refresh_failed', accountId: input.accountId, leadId, code: errorCode(error) });
    }
  }
  return { type: 'refreshed', refreshed, failed, unread: 0, unchecked };
}
