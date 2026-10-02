import 'server-only';

// Follow-ups (brief §5.6, PLAN §8.2, §8.5, §9.5, D-08, D-09, D-33, D-34, D-44). Import from here
// (handlers.ts imports './job' directly, as lead_process's own registration does).
// - schedule.ts: the two job rows of the "notified" transaction;
// - job.ts: the `followup` handler and its registration; failure.ts: its failure path (a lead-page
//   note) and the hook for a follow-up email that fails outside the job; end.ts: what a job that sends nothing leaves behind;
// - notes.ts: the lead-page notes (M6 reads them); supersede.ts: D-44's dynamic stop.
export { cancelRemainingFollowUpsInTx, endFollowUpInTx, LEAD_STOPS, STREAM_ENDED_STOP } from './end';
export type { EndFollowUpInput, EndFollowUpResult } from './end';
export { followUpEmailFailedInTx, followUpFailurePath, followUpReservationExpired } from './failure';
export type { FollowUpEmailFailedInput, FollowUpFailureOptions } from './failure';
export { followUpEmailFailed, followUpHandler, registerFollowUpJob } from './job';
export type { FollowUpJobOptions } from './job';
export { asFollowUpNumber, followUpLabel, followUpRefOf } from './job-ref';
export type { FollowUpRef } from './job-ref';
export { FU2_RECHECK_MS, fu2WaitsForFu1, loadFollowUpLead, quietHoursRetarget } from './lead';
export type { FollowUpLead } from './lead';
export { FOLLOW_UP_FAILED_ACTIONS, loadFollowUpNotes, recordFollowUpFailedNote } from './notes';
export type { FollowUpNote, FollowUpNoteInput } from './notes';
export { followUpDedupeKey, scheduleFollowUpsInTx } from './schedule';
export { DEFAULT_FOLLOW_UP_QUIET_HOURS, inPortalZone, quietHoursOf } from './settings';
export type { QuietHoursColumns } from './settings';
export type { FollowUpScheduleResult, ScheduleFollowUpsInput } from './schedule';
export { isSuperseded, supersededSql } from './supersede';
