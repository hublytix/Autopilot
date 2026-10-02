import 'server-only';
import { errorCode } from '@/server/domain/errors';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { LeaseNames, withLease } from '@/server/services/leases';
import { retryAuthUserDeletions, type AuthUserDeletionSummary } from '@/server/services/auth/auth-user-deletion';
import { reconcileBillingTombstones, type TombstoneReconcileSummary } from '@/server/services/purge';
import { runDailyRetention, type DailyRetentionSummary } from '@/server/services/retention';
import { scheduleAccountDailyJobs, type ScheduleDailySummary } from './schedule';

// The daily cron (`/api/cron/daily`, `17 3 * * *` UTC; PLAN §7.3, §8.1), under its own lease so a
// Vercel Cron GET and a QStash schedule POST never overlap:
// 1. the DB-local retention steps (PLAN §9.10 steps 1-4, the catch-all and the step 7 prunes);
// 2. one `account_daily` job per account (§9.1 step 4, §9.10 step 5): database writes plus one
//    publish each, so it comes before anything that waits on Razorpay (D-82): a slow Razorpay can
//    never cost every account its day (introspection, reconcile, purge);
// 3. the billing-tombstone reconcile (§9.10 step 6; needs no account), within a time budget
//    (TOMBSTONE_RECONCILE_BUDGET_MS, well inside the route's 300 s): rows it doesn't reach keep
//    their place (least recently checked first) for tomorrow;
// 4. the retry of auth users whose deletion is still owed (services/auth, D-82), within what is
//    left of that budget.
// Each part runs even when an earlier one failed. The summary holds counts only.

export const DAILY_CRON_LEASE = LeaseNames.dailyCron;
/** Longer than the route's maxDuration (300 s). */
export const DAILY_CRON_LEASE_MS = 6 * 60 * 1000;
/** The Razorpay and auth-provider parts stop starting new calls after this long (each call is bounded at 8 s). */
export const DAILY_NETWORK_BUDGET_MS = 120 * 1000;

export interface DailyCronSummary {
  /** `busy`: another run holds the lease, so this one did nothing. */
  readonly status: 'ran' | 'busy';
  readonly retention: DailyRetentionSummary | null;
  readonly tombstones: TombstoneReconcileSummary | null;
  readonly jobs: ScheduleDailySummary | null;
  readonly authUsers: AuthUserDeletionSummary | null;
  /** The parts that failed. */
  readonly errors: number;
}

async function part<T>(name: string, run: () => Promise<T>, onError: () => void): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    onError();
    log.error('daily cron part failed', { event: 'cron.daily.error', kind: name, code: errorCode(error) }, error);
    return null;
  }
}

export async function runDailyCron(deps: Deps): Promise<DailyCronSummary> {
  const run = await withLease(deps.db, { name: DAILY_CRON_LEASE, ttlMs: DAILY_CRON_LEASE_MS, now: deps.clock.now() }, async () => {
    let errors = 0;
    const failed = (): void => {
      errors += 1;
    };
    const retention = await part('retention', () => runDailyRetention(deps), failed);
    const jobs = await part('jobs', () => scheduleAccountDailyJobs(deps), failed);
    const deadline = new Date(deps.clock.now().getTime() + DAILY_NETWORK_BUDGET_MS);
    const tombstones = await part('tombstones', () => reconcileBillingTombstones(deps, { deadline }), failed);
    const authUsers = await part('auth_users', () => retryAuthUserDeletions(deps, { deadline }), failed);
    return { status: 'ran' as const, retention, tombstones, jobs, authUsers, errors };
  });
  if (!run.acquired) {
    log.info('daily cron skipped: lease held', { event: 'cron.daily.busy' });
    return { status: 'busy', retention: null, tombstones: null, jobs: null, authUsers: null, errors: 0 };
  }
  log.info('daily cron finished', { event: 'cron.daily', count: run.value.jobs?.created ?? 0, total: run.value.jobs?.accounts ?? 0 });
  return run.value;
}
