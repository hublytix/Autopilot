import 'server-only';

// Lead intake (PLAN §9.2, D-05, D-06, D-07, D-14, D-16, D-31): the HubSpot webhook's processing,
// pollPortal, the portal_poll job and the poll cron.
export { insertLead, insertLeadInTx, LEAD_CONTENT_RETENTION_MS } from './insert-lead';
// The lead_process dedupe key is owned by the lead_process service; re-exported for intake callers.
export { leadProcessDedupeKey } from '@/server/services/leads/process';
export type { InsertedLead, NewLead } from './insert-lead';
export { createPortalPollJobHandler, portalPollJobHandler } from './jobs';
export type { PortalPollJobOptions } from './jobs';
export { POLL_CRON_BUDGET_MS, POLL_CRON_LEASE_MS, runPollCron } from './poll-cron';
export type { PollCronOptions, PollCronSummary, RetentionGuardSummary } from './poll-cron';
export {
  ACCOUNT_POLL_LEASE_MS,
  INTAKE_CONTACT_PROPERTIES,
  MAX_SUBMISSION_PAGES,
  POLL_OVERLAP_MS,
  pollPortal,
  SUBMISSIONS_PAGE_SIZE,
} from './poll-portal';
export type { PollCounts, PollPortalOptions, PollPortalResult, PollTrigger } from './poll-portal';
export { emailHmac, fillFromContact, normalizeEmail, submissionContent, submissionKey } from './submission';
export type { LeadContent } from './submission';
export { isTestAddressSubmission, loadInboxCheckWindows, TEST_ADDRESS_WINDOW_AFTER_MS, TEST_ADDRESS_WINDOW_BEFORE_MS } from './test-address';
export type { InboxCheckWindow } from './test-address';
export {
  HUBSPOT_WEBHOOK_MAX_EVENTS,
  hubSpotWebhookEventSchema,
  parseWebhookBody,
  pollMinuteKey,
  processHubSpotWebhook,
  SECOND_POLL_DELAY_MS,
  webhookDedupeKey,
} from './webhook';
export type { HubSpotWebhookEvent, ParsedWebhookBody, ProcessWebhookInput, WebhookEventOutcome, WebhookSummary } from './webhook';
