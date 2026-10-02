import 'server-only';

// Server Action bodies for the dashboard (PLAN §3 actions/, §7.5). Pages import each action from
// its own 'use server' module (lead, account, brief); the bodies and result codes live in ./controls.
export { DASHBOARD_PATH, DASHBOARD_RESULT_CODES, LEAD_RESULT_CODES, leadPagePath, runLeadControl, runPauseControl } from './controls';
export type { DashboardResultCode, LeadControl, LeadResultCode } from './controls';
