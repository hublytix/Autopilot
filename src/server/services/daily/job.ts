import 'server-only';
import { errorCode, isRetryable, isRevoked, TransientError } from '@/server/domain/errors';
import { JobOutcomes, type JobHandler, type JobOutcome, type Registration } from '@/server/jobs';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { isDailyLimit, type Sleep } from '@/server/services/hubspot';
import type { NotificationRegistry } from '@/server/services/notifications/renderers';
import { disconnectOrphan, purgeAccountIfDue, type OrphanOutcome, type PurgeOutcome } from '@/server/services/purge';
import { refreshAccountDetails, type DetailsOutcome } from './details';
import { probeConnection, type IntrospectOutcome } from './introspect';
import { reconcileAccountSubscriptions, type ReconcileSummary } from './reconcile';
import { reencryptConnectionTokens, type ReencryptOutcome } from './reencrypt';
import { refreshFinishedLeadSignals, type SignalRefreshSummary } from './signals';

// The `account_daily` job (PLAN §8.2 `daily:{acct}:{localDate}`, §9.1 step 4, §9.10 step 5), one per
// account a day from the daily cron. In PLAN order:
// 1. introspect the refresh token of an active connection, whatever the pause or billing state
//    (`active:false` → the revoked path, D-10);
// 2. refresh the account details and timezone (D-12);
// 3. reconcile the non-terminal Razorpay subscriptions (D-19);
// 4. re-encrypt tokens whose kid is not current (D-51);
// 5. an orphan install is uninstalled and disconnected, then any account due is purged (D-48);
// 6. the signal refresh for leads whose follow-ups are finished or off (D-08), unless an earlier
//    step failed (the job is then retried, and the refresh would only repeat its reads).
// Every step is idempotent and guards its own writes, so a retry re-runs them safely. A step's
// error does not stop the later ones; at the end a retryable error makes the delivery transient
// (QStash backs off; the failure callback alerts after the last delivery) and any other error fails
// the job (the failure path alerts). A revoked connection or HubSpot's daily limit is not an error
// here: the revoked path has run, and tomorrow's job reads HubSpot again. The job does not check
// its own claim: the revoke and disconnect transitions cancel account jobs, this one included, and
// the steps after them must still run (the purge in particular).

export interface AccountDailyHooks {
  /** The per-portal limiter's wait (default real timers; the simulation advances its FakeClock). */
  readonly sleep?: Sleep | undefined;
  /** The registry holding the reply_detected resumer (default: the process registry). */
  readonly notifications?: NotificationRegistry | undefined;
}

export type StepName = 'introspect' | 'details' | 'reconcile' | 'reencrypt' | 'purge' | 'signals';

export interface AccountDailyResult {
  readonly status: 'ran' | 'not_found';
  readonly introspect: IntrospectOutcome | null;
  readonly details: DetailsOutcome | null;
  readonly reconcile: ReconcileSummary | null;
  readonly reencrypt: ReencryptOutcome | null;
  readonly orphan: OrphanOutcome | null;
  readonly purge: PurgeOutcome | null;
  readonly signals: SignalRefreshSummary | null;
  /** Steps that failed, with their error codes. */
  readonly failures: readonly { readonly step: StepName; readonly code: string; readonly retryable: boolean }[];
  /** The first retryable error's Retry-After, if any. */
  readonly retryAfterMs?: number | undefined;
}

type Failures = { step: StepName; code: string; retryable: boolean; retryAfterMs?: number | undefined }[];

/** Runs one step; an error is recorded (or ignored when it is not a failure of this job) and null returned. */
async function step<T>(name: StepName, accountId: string, failures: Failures, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    // The revoked path has run (and cancelled the account's jobs); the daily limit holds HubSpot
    // reads until the portal's midnight. Tomorrow's job reads again.
    if (isRevoked(error) || isDailyLimit(error)) {
      log.info('daily step skipped', { event: 'daily.step_skipped', accountId, kind: name, code: errorCode(error) });
      return null;
    }
    const retryable = isRetryable(error);
    failures.push({ step: name, code: errorCode(error), retryable, retryAfterMs: error instanceof TransientError ? error.retryAfterMs : undefined });
    log.warn('daily step failed', { event: 'daily.step_failed', accountId, kind: name, code: errorCode(error) }, error);
    return null;
  }
}

export async function runAccountDaily(
  deps: Deps,
  accountId: string,
  hooks: AccountDailyHooks = {},
  options: { jobId?: string | undefined } = {},
): Promise<AccountDailyResult> {
  const exists = await deps.db.maybeOne(`select id from accounts where id = $1`, [accountId]);
  if (exists === null) {
    return { status: 'not_found', introspect: null, details: null, reconcile: null, reencrypt: null, orphan: null, purge: null, signals: null, failures: [] };
  }
  const failures: Failures = [];
  const introspect = await step('introspect', accountId, failures, () => probeConnection(deps, accountId));
  const details = await step('details', accountId, failures, () => refreshAccountDetails(deps, accountId, { sleep: hooks.sleep }));
  const reconcile = await step('reconcile', accountId, failures, () => reconcileAccountSubscriptions(deps, accountId));
  const reencrypt = await step('reencrypt', accountId, failures, () => reencryptConnectionTokens(deps, accountId));
  let orphan: OrphanOutcome | null = null;
  const purge = await step('purge', accountId, failures, async () => {
    orphan = await disconnectOrphan(deps, accountId, { sleep: hooks.sleep });
    return purgeAccountIfDue(deps, accountId, { exceptJobId: options.jobId });
  });
  const purged = purge?.status === 'purged' || purge?.status === 'not_found';
  const signals =
    purged || failures.length > 0
      ? null
      : await step('signals', accountId, [], () => refreshFinishedLeadSignals(deps, accountId, { sleep: hooks.sleep, notifications: hooks.notifications }));
  const retryAfterMs = failures.find((failure) => failure.retryable)?.retryAfterMs;
  log.info('account daily run finished', {
    event: 'daily.account',
    accountId,
    status: purge?.status ?? null,
    outcome: introspect,
    count: signals?.checked ?? 0,
    codes: failures.map((failure) => failure.code),
  });
  return {
    status: 'ran',
    introspect,
    details,
    reconcile,
    reencrypt,
    orphan,
    purge,
    signals,
    failures: failures.map(({ step: name, code, retryable }) => ({ step: name, code, retryable })),
    retryAfterMs,
  };
}

/** The outcome a delivery reports for a run (see the header). */
export function accountDailyOutcome(result: AccountDailyResult): JobOutcome {
  if (result.status === 'not_found') return JobOutcomes.skipped();
  const retryable = result.failures.find((failure) => failure.retryable);
  if (retryable !== undefined) return { type: 'transient', code: retryable.code, retryAfterMs: result.retryAfterMs };
  const permanent = result.failures[0];
  if (permanent !== undefined) return { type: 'permanent', code: permanent.code };
  return JobOutcomes.done();
}

export function createAccountDailyHandler(hooks: AccountDailyHooks = {}): JobHandler {
  return async (deps, job) => {
    if (job.accountId === null) return { type: 'permanent', code: 'account_daily_bad_payload' };
    return accountDailyOutcome(await runAccountDaily(deps, job.accountId, hooks, { jobId: job.id }));
  };
}

/** Registers `account_daily` (added to REGISTRATIONS in src/server/jobs/handlers.ts). */
export const registerAccountDailyJob: Registration = ({ jobs, notifications, limiterSleep }) => {
  jobs.register('account_daily', createAccountDailyHandler({ sleep: limiterSleep, notifications }));
};
