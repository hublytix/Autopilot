import 'server-only';

// The dashboard's read models (PLAN §7.5, M6): /dashboard (status card, banners, recent leads),
// /dashboard/leads/[id] (timeline, drafts, message, controls, and the signal refresh on view) and
// /dashboard/brief (editor + version history). Every read takes the OwnerScope from requireOwner and
// reads that account only (PLAN §10.8). The pages turn the codes here into plain words.
export { connectionActive, loadAccountContext } from './account';
export type { AccountContext } from './account';
export { BRIEF_HISTORY_LIMIT, dashboardBriefView } from './brief';
export type { BriefVersionRow, DashboardBriefView } from './brief';
export { daysUntil, displayZone, formatDateInZone, formatInZone } from './format';
export { leadDetailView, MESSAGE_DISPLAY_MAX_CHARS } from './lead-detail';
export type { DraftView, LeadDetailView, MessageView, RealLeadControl, ResumeControl, TimelineEvent } from './lead-detail';
export { leadNameOf, leadStatusOf, parseLeadId } from './leads';
export type { LeadNameView, LeadRecord, NotProcessedReason } from './leads';
export { dashboardView, RECENT_LEADS_LIMIT, RECENT_WINDOW_MS, TRIAL_ENDING_DAYS } from './overview';
export type { AccountStatusState, DashboardBanner, DashboardBannerType, DashboardView, DashboardViewOptions, RecentLeadView, StatusCardView } from './overview';
export { ACCOUNT_REFRESH_BUDGET, claimRefreshSlot, REFRESH_BUDGET_MS, REFRESH_INTERVAL_MS, refreshLeadSignals } from './refresh';
export type { LeadRefreshOptions, LeadRefreshOutcome } from './refresh';
