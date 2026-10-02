import 'server-only';

// The owner's controls (PLAN §6.1, §6.2, §9.6, D-42): Pause all / Resume, "This is a real lead",
// "Resume follow-ups" and "Not a real lead". Owner-facing functions take the OwnerScope from
// requireOwner; dismissLead takes ids for the action link. M6/M7 add the dashboard and settings
// controls that call them. Import from here.
export { dismissLead, dismissLeadForOwner, dismissLeadInTx } from './dismiss';
export type { DismissedInTx, DismissLeadOptions, DismissLeadOutcome, DismissVia, LeadRef } from './dismiss';
export { pauseAll, resumeAll } from './pause';
export type { PauseResult } from './pause';
export { markRealLead } from './real-lead';
export type { MarkRealLeadRefusal, MarkRealLeadResult } from './real-lead';
export { resumeFollowUps } from './resume-followups';
export type { ResumeFollowUpsRefusal, ResumeFollowUpsResult } from './resume-followups';
