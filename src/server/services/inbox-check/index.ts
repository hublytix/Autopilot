import 'server-only';

// The onboarding inbox-logging check (PLAN §8.2, §8.4, §9.7, D-14): history counts, the two-leg
// live test (test lead, inbox_test email, inbox_check job), skip, and retention. Import from here.
export {
  CHECK_INTERVAL_MS,
  CLOCK_SKEW_MS,
  INBOX_CHECK_ABANDON_MS,
  INBOX_CHECKS_PER_DAY,
  INITIAL_REPLY_WINDOW_MS,
  LEG_WINDOW_MS,
  MAX_CHECK_RUNS,
  TEST_LEAD_CONTENT_TTL_MS,
} from './constants';
export { actionLinkUrl, inboxTestKey, inboxTestPlan, inboxTestPredicate, ONBOARDING_INBOX_PATH, resumeInboxTest } from './email';
export type { InboxTestPlan } from './email';
export { HISTORY_WINDOW_MS, readEmailHistory } from './history';
export type { EmailHistory, ReadEmailHistoryInput } from './history';
export {
  createInboxCheckJobHandler,
  inboxCheckFailurePath,
  inboxCheckJobHandler,
  readTestContactEmails,
  registerInboxCheck,
} from './job';
export type { InboxCheckJobOptions } from './job';
export { checkIdOfInboxTestKey, checkIdOfJob, inboxCheckDedupeKey, runNumberOfJob } from './keys';
export { advanceLegs, findLegEvidence, loggingModeFor } from './legs';
export type { AdvanceOptions, LegEvidence, LegsOutcome, LegsState } from './legs';
export {
  clearExpiredTestAddresses,
  closeAbandonedInboxChecks,
  getInboxCheck,
  latestInboxCheck,
} from './repository';
export type { InboxCheckRow } from './repository';
export { runInboxCheckRetention, skipInboxCheck } from './skip';
export type { InboxCheckRetentionSummary, SkipInboxCheckResult } from './skip';
export { parseTestAddress, startInboxCheck } from './start';
export type { StartInboxCheckInput, StartInboxCheckOptions, StartInboxCheckResult } from './start';
export { testDraft, testLeadMessage } from './test-lead';
