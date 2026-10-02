import 'server-only';

// The job system (PLAN §8.2, §8.3, D-11, D-15), as services use it: insertJob inside their own
// transaction and publishJobs after commit, cancelJobs, the outcome and registry types.
//
// The entry points are imported from their own modules, not from here, so that handlers.ts (which
// imports the services that own each kind) never forms an import cycle with a service importing
// this index: `./handlers` (ensureJobHandlersRegistered), `./bridge` (fake scheduler),
// `./sweeper` (the poll cron), and `./dispatcher` / `./failure` (the routes).
export { onAlert, raiseAlert } from './alert';
export type { AlertListener, RaisedAlert } from './alert';
export { ACCOUNT_CANCEL_EXCEPT_KINDS, cancelJobs, cancelJobsInTx, cancelScheduledMessages, CancelFilterRequiredError } from './cancel';
export type { CancelJobsFilter, CancelledJobs, JobCancelReason } from './cancel';
export { assertJobOwned, claimJob } from './claim';
export type { Registration, Registries } from './handlers';
export { dedupeIdFor, insertJob, InvalidDedupeKeyError, publishJob, publishJobs, RepublishDeduplicatedError } from './outbox';
export type { InsertJobInput, PublishJobsSummary, PublishOutcome } from './outbox';
export { createJobRegistry, defaultJobRegistry } from './registry';
export type { JobRegistry } from './registry';
export { republishJob } from './republish';
export type { RepublishGuard, RepublishResult } from './republish';
export { getJob, targetAtOf } from './rows';
export {
  isJobLeaseLost,
  JOB_FAILED_PATH,
  JOB_LEASE_MS,
  JOB_LONG_WAIT_MS,
  JOB_MAX_ATTEMPTS,
  JOB_RETRIES,
  JOB_RETRY_DELAY_EXPRESSION,
  JOB_RUN_PATH,
  JobLeaseLostError,
  JobOutcomes,
} from './types';
export type { JobContext, JobFailureInfo, JobFailurePath, JobFailureReason, JobHandler, JobOutcome, JobPayload, JobRow } from './types';
