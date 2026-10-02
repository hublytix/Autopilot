import 'server-only';
import { createElement } from 'react';
import { WeeklyReport, weeklyReportSubject } from '@/emails/WeeklyReport';
import type { WeeklyMetrics } from '@/server/domain/weekly-metrics';
import { renderEmail } from '@/server/email/render';
import type { Deps } from '@/server/ports';
import { NotificationPredicates } from '@/server/services/notifications/predicates';
import type { NotificationFailureHook, NotificationRegistry, NotificationResumer } from '@/server/services/notifications/renderers';
import type { NotificationSendPlan, RenderedMail } from '@/server/services/notifications/types';
import { parseReportKey } from './keys';
import { weeklyReportProps } from './present';
import { loadReport, loadReportAccount, markReportFailed, markReportSent, type ReportAccount, type ReportRow } from './repository';

// The `weekly_report` email (PLAN §8.4, §9.8 step 5): key `report:{acct}:{week_start}`, predicates
// "account and connection active", rendered from the stored `weekly_reports.metrics` only, so the
// job's send and the sweeper's resume are the same email. To the verified notify addresses (the
// owner's sign-in address when none is verified); Reply-To the owner's own address, D-27's rule for
// owner emails (never a lead's address or our support inbox). No buttons: the dashboard link signs in.
// `onSent` marks the report `sent` in the transaction that marks the email sent. A reservation that
// ends `failed` unsent (expired, predicates, not resumable, permanent) marks the report `failed`.

export const DASHBOARD_PATH = '/dashboard';

export interface WeeklyReportEmailInput {
  readonly account: Pick<ReportAccount, 'accountId' | 'to' | 'replyTo'>;
  readonly report: Pick<ReportRow, 'id' | 'timezone'>;
  readonly metrics: WeeklyMetrics;
}

/** The send plan; null when the account has nobody to email. */
export function weeklyReportPlan(deps: Pick<Deps, 'env'>, input: WeeklyReportEmailInput): NotificationSendPlan | null {
  const { account, report, metrics } = input;
  if (account.to.length === 0) return null;
  const productName = deps.env.PRODUCT_NAME;
  return {
    predicates: NotificationPredicates.weeklyReport(account.accountId),
    render: async (): Promise<RenderedMail> => {
      const props = weeklyReportProps(metrics, { productName, timezone: report.timezone, dashboardUrl: `${deps.env.APP_URL}${DASHBOARD_PATH}` });
      const { html, text } = await renderEmail(createElement(WeeklyReport, props));
      return {
        to: account.to,
        replyTo: account.replyTo ?? undefined,
        subject: weeklyReportSubject(productName, props.weekLabel),
        html,
        text,
        tags: [{ name: 'kind', value: 'weekly_report' }],
      };
    },
    onSent: async (tx) => {
      await markReportSent(tx, report.id);
    },
  };
}

/** Rebuilds a `weekly_report` reservation's plan from its key and the stored metrics (the sweeper's resume). */
export const resumeWeeklyReport: NotificationResumer = async (deps, row) => {
  const ref = parseReportKey(row.dedupeKey);
  if (ref === null) return null;
  const report = await loadReport(deps.db, ref);
  if (report === null || report.metrics === null) return null;
  const account = await loadReportAccount(deps.db, ref.accountId);
  if (account === null) return null;
  return weeklyReportPlan(deps, { account, report, metrics: report.metrics });
};

/** The report's email will never go out: the report is `failed` (never over `sent`), in the failing transaction. */
export const weeklyReportEmailFailed: NotificationFailureHook = {
  inTx: async (tx, row) => {
    const ref = parseReportKey(row.dedupeKey);
    if (ref !== null) await markReportFailed(tx, ref);
  },
};

/** The resumer and the failure hook; safe to call more than once. */
export function registerWeeklyReportNotifications(registries: { readonly notifications: NotificationRegistry }): void {
  const { notifications } = registries;
  if (notifications.resumer('weekly_report') === undefined) notifications.register('weekly_report', resumeWeeklyReport);
  notifications.onFailed('weekly_report', weeklyReportEmailFailed);
}
