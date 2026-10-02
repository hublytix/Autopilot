import 'server-only';

// The Monday report (PLAN §8.2, §9.8, D-17, D-37): the hourly due-check, the `weekly_report` job,
// its email (resumer and failure hook) and the metrics' presentation. Import from here; the pure
// rules live in domain/report-due.ts and domain/weekly-metrics.ts.
export { DASHBOARD_PATH, registerWeeklyReportNotifications, resumeWeeklyReport, weeklyReportEmailFailed, weeklyReportPlan } from './email';
export type { WeeklyReportEmailInput } from './email';
export { createWeeklyReportHandler, registerWeeklyReportJob, reportRefOf, weeklyReportFailurePath } from './job';
export type { WeeklyReportJobOptions } from './job';
export { isWeekStart, parseReportKey, reportEmailKey, reportJobKey } from './keys';
export type { ReportRef } from './keys';
export { formatWait, weekLabelOf, weeklyReportProps } from './present';
export type { WeeklyReportPresentation } from './present';
export { REPORT_REFRESH_BUDGET_MS, refreshReportSignals } from './refresh';
export type { RefreshReportInput, RefreshReportResult } from './refresh';
export { isReportable, loadMetricLeads, loadReport, loadReportAccount, markReportFailed, markReportSent, storeMetrics } from './repository';
export type { ReportAccount, ReportRow } from './repository';
export { REPORT_INTAKE_GRACE_MS, reportRunAt, reportStaggerMs, scheduleWeeklyReports } from './schedule';
export type { WeeklyReportScheduleSummary } from './schedule';
