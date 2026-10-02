import 'server-only';

// Leads after intake (PLAN §9.3, §8.4): the lead_process job and the lead emails. Import from here
// (src/server/jobs/handlers.ts and intake import './process' directly, which is fine too).
//
// For M5: the follow-up job sends with `followUpNotificationPlan` (+ reserveAndSend with its kind and
// key), markReplied reserves `reply_detected` with `replyDetectedKey` + NotificationPredicates.replyDetected
// in its transaction and calls sendReserved after commit (the resumer is registered with
// lead_process; `ensureLeadNotificationsRegistered()` puts it in the default registry). The
// follow-up job rows of the "notified" transaction come from services/followups/schedule.ts.
export { leadProcessDedupeKey, leadProcessHandler, leadProcessFailurePath, needsTouchWhyOf, registerLeadProcessJob } from './process';
export type { ClassifiedLead } from './process';
export { initialNotificationPlan, markInitialNotified, sendInitialNotification } from './initial-notification';
export type { InitialNotificationInput, InitialNotificationKind, InitialNotificationResult, InitialPlanProblem } from './initial-notification';
export { followUpNotificationPlan, markFollowUpNotified } from './follow-up-notification';
export type { FollowUpKind, FollowUpNotification, FollowUpNotificationInput } from './follow-up-notification';
export { formatReplyTime, replyDetectedKey, replyDetectedNotificationPlan } from './reply-detected-notification';
export { ensureLeadNotificationsRegistered, parseLeadNotificationKey, registerLeadNotifications } from './notifications';
export type { LeadNotificationKey } from './notifications';
export { displayLine, displayMessage, leadCardOf, loadLeadEmailSource } from './email-source';
export type { LeadEmailDraft, LeadEmailSource } from './email-source';
export { hubspotContactRecordUrl } from './record-link';
export { LEAD_EMAIL_BUTTONS, leadActionUrls } from './action-urls';
