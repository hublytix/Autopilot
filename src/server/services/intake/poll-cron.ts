import 'server-only';
import { z } from 'zod';
import { errorCode, isAppError, isRevoked } from '@/server/domain/errors';
import type { SweepSummary } from '@/server/jobs/sweeper';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { applyProcessingState } from '@/server/services/accounts';
import { ACCESS_TOKEN_SKEW_MS, dailyLimitActive, isDailyLimit, refreshBackoffActive, type Sleep } from '@/server/services/hubspot';
import { LeaseNames, withLease } from '@/server/services/leases';
import { pollPortal } from './poll-portal';

// The 5-minute poll cron (PLAN §7.3, §8.1, D-11, D-16), under the global lease 'poll' (TTL 6 min,
// longer than the route's maxDuration):
// 1. applyProcessingState for every account still in the database (purged ones are gone), so time-
//    based transitions (trial end, grace end) happen without any other trigger;
// 2. pollPortal(…, 'cron') for each active account with an active connection, least recently polled
//    first, within a ~240 s total budget. A portal is skipped while its token needs a refresh and
//    `$now < next_refresh_attempt_at` (D-11's inline backoff), and until its next local midnight
//    once HubSpot answered with its daily limit (`daily_limit_until`, D-11);
// 3. the job sweeper (PLAN §8.3 step 7);
// 4. the retention guard (D-49).
// The sweeper and the retention guard are passed in by the route: services never import the job
// entry points (import cycle with the handler registry).

export const POLL_CRON_LEASE_MS = 6 * 60 * 1000;
export const POLL_CRON_BUDGET_MS = 240 * 1000;

export type RetentionGuardSummary = Readonly<Record<string, number | boolean>>;

export interface PollCronOptions {
  sweep: (deps: Deps) => Promise<SweepSummary>;
  retentionGuard: (deps: Deps) => Promise<RetentionGuardSummary>;
  /** The whole run's budget (states and polls); default POLL_CRON_BUDGET_MS. */
  budgetMs?: number | undefined;
  /** For the portal limiter; default real timers. */
  sleep?: Sleep | undefined;
}

export interface PollCronSummary {
  /** `busy`: another run holds the global lease, so this one did nothing. */
  status: 'ran' | 'busy';
  accounts: number;
  stateChanges: number;
  stateErrors: number;
  /** Active accounts eligible for a poll. */
  pollable: number;
  polled: number;
  pollBusy: number;
  pollNotActive: number;
  skippedRefreshBackoff: number;
  /** Held until the portal's next local midnight after a daily-limit 429 (D-11). */
  skippedDailyLimit: number;
  deferredByBudget: number;
  revoked: number;
  pollErrors: number;
  leadsCreated: number;
  sweep: SweepSummary | null;
  sweepFailed: boolean;
  retentionGuard: RetentionGuardSummary | null;
  retentionGuardFailed: boolean;
}

function emptySummary(status: PollCronSummary['status']): PollCronSummary {
  return {
    status,
    accounts: 0,
    stateChanges: 0,
    stateErrors: 0,
    pollable: 0,
    polled: 0,
    pollBusy: 0,
    pollNotActive: 0,
    skippedRefreshBackoff: 0,
    skippedDailyLimit: 0,
    deferredByBudget: 0,
    revoked: 0,
    pollErrors: 0,
    leadsCreated: 0,
    sweep: null,
    sweepFailed: false,
    retentionGuard: null,
    retentionGuardFailed: false,
  };
}

const pollableSchema = z.object({
  id: z.string(),
  access_expires_at: z.date().nullable(),
  next_refresh_attempt_at: z.date().nullable(),
  daily_limit_until: z.date().nullable(),
});

type Pollable = z.infer<typeof pollableSchema>;

/** D-11: skip only while the token needs a refresh AND the inline backoff holds it back. */
function inRefreshBackoff(row: Pollable, now: Date): boolean {
  const needsRefresh = row.access_expires_at === null || row.access_expires_at.getTime() - ACCESS_TOKEN_SKEW_MS <= now.getTime();
  return needsRefresh && refreshBackoffActive(row, now);
}

async function applyStates(deps: Deps, summary: PollCronSummary): Promise<void> {
  const accounts = await deps.db.query<{ id: string }>(`select id from accounts order by created_at, id`);
  summary.accounts = accounts.length;
  for (const { id } of accounts) {
    try {
      const applied = await applyProcessingState(deps, id);
      if (applied?.transitioned === true) summary.stateChanges += 1;
    } catch (error) {
      summary.stateErrors += 1;
      log.warn('processing state not applied', { event: 'cron.poll.state_error', accountId: id, code: errorCode(error) }, error);
    }
  }
}

/** Polls until `deadline` (the run's start + the budget). */
async function pollAccounts(deps: Deps, options: PollCronOptions, deadline: number, summary: PollCronSummary): Promise<void> {
  const rows = await deps.db.query(
    `select a.id, c.access_expires_at, c.next_refresh_attempt_at, c.daily_limit_until
       from accounts a join hubspot_connections c on c.account_id = a.id
      where a.processing_state = 'active' and c.status = 'active'
      order by c.last_polled_at nulls first, a.id`,
  );
  const pollable = rows.map((raw) => pollableSchema.parse(raw));
  summary.pollable = pollable.length;
  // Bounds every HubSpot call by what is left of the budget.
  const remainingMs = deadline - deps.clock.now().getTime();
  const signal = remainingMs > 0 ? AbortSignal.timeout(remainingMs) : undefined;

  for (const [index, row] of pollable.entries()) {
    const now = deps.clock.now();
    if (now.getTime() >= deadline) {
      summary.deferredByBudget = pollable.length - index;
      log.warn('poll budget spent', { event: 'cron.poll.budget', remaining: summary.deferredByBudget });
      return;
    }
    if (dailyLimitActive(row, now)) {
      summary.skippedDailyLimit += 1;
      continue;
    }
    if (inRefreshBackoff(row, now)) {
      summary.skippedRefreshBackoff += 1;
      continue;
    }
    try {
      const result = await pollPortal(deps, row.id, 'cron', { inline: true, sleep: options.sleep, signal });
      if (result.status === 'polled') {
        summary.polled += 1;
        summary.leadsCreated += result.counts.leadsCreated;
      } else if (result.status === 'busy') {
        summary.pollBusy += 1;
      } else {
        summary.pollNotActive += 1;
      }
    } catch (error) {
      if (isRevoked(error)) {
        summary.revoked += 1;
      } else if (isAppError(error) && error.code === 'hubspot_refresh_backoff') {
        summary.skippedRefreshBackoff += 1;
      } else if (isDailyLimit(error)) {
        // The portal client recorded the hold: later runs skip the portal until its local midnight.
        summary.skippedDailyLimit += 1;
      } else {
        summary.pollErrors += 1;
        log.warn('portal poll failed', { event: 'cron.poll.error', accountId: row.id, code: errorCode(error) }, error);
      }
    }
  }
}

/** One run of the poll cron. Returns counts only. */
export async function runPollCron(deps: Deps, options: PollCronOptions): Promise<PollCronSummary> {
  const startedAt = deps.clock.now();
  const deadline = startedAt.getTime() + (options.budgetMs ?? POLL_CRON_BUDGET_MS);
  const run = await withLease(deps.db, { name: LeaseNames.pollCron, ttlMs: POLL_CRON_LEASE_MS, now: startedAt }, async () => {
    const summary = emptySummary('ran');
    await applyStates(deps, summary);
    await pollAccounts(deps, options, deadline, summary);
    try {
      summary.sweep = await options.sweep(deps);
    } catch (error) {
      summary.sweepFailed = true;
      log.error('sweeper failed', { event: 'cron.poll.sweep_error', code: errorCode(error) }, error);
    }
    try {
      summary.retentionGuard = await options.retentionGuard(deps);
    } catch (error) {
      summary.retentionGuardFailed = true;
      log.error('retention guard failed', { event: 'cron.poll.retention_error', code: errorCode(error) }, error);
    }
    return summary;
  });
  if (!run.acquired) {
    log.info('poll cron skipped: lease held', { event: 'cron.poll.busy' });
    return emptySummary('busy');
  }
  const summary = run.value;
  log.info('poll cron finished', {
    event: 'cron.poll',
    total: summary.accounts,
    count: summary.polled,
    skipped: summary.skippedRefreshBackoff + summary.skippedDailyLimit + summary.deferredByBudget + summary.pollBusy,
  });
  return summary;
}
