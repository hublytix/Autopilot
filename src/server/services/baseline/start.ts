import 'server-only';
import { insertJob, publishJobs, type JobRow } from '@/server/jobs';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { accountLocalDate } from '@/server/services/accounts';
import type { OwnerScope } from '@/server/services/auth';

// Starting the baseline (PLAN §7.5 /onboarding/baseline, §8.2): the baseline step starts the
// `baseline` job when the account is connected, has at least one selected form (the baseline reads
// those forms) and has no baseline and no live or finished baseline job yet. The key is PLAN's
// `baseline:{acct}:{local date}` plus the start's number for the account (D-62): a job skipped
// (connection revoked mid-run) or cancelled (the revoke transition) must not block a new start the
// same day after the owner reconnects. The account row lock makes the number race-free. The job is
// published after commit.

export function baselineDedupeKey(accountId: string, localDate: string, attempt: number): string {
  return `baseline:${accountId}:${localDate}:${attempt}`;
}

export type StartBaselineResult =
  | 'started'
  /** A baseline exists, or a job for it was already started (today's may have ended without one). */
  | 'already_started'
  /** No form is selected yet. */
  | 'no_forms'
  /** The HubSpot connection is not active. */
  | 'not_connected';

export async function ensureBaselineStarted(scope: OwnerScope, deps: Deps): Promise<StartBaselineResult> {
  const now = deps.clock.now();
  const accountId = scope.accountId;
  const outcome = await deps.db.tx(async (tx): Promise<{ result: StartBaselineResult; job: JobRow | null }> => {
    // The account lock serialises two tabs starting it at once.
    const account = await tx.maybeOne<{ timezone: string | null; connection_status: string | null; forms: number; earlier: number; started: boolean }>(
      `select a.timezone, c.status as connection_status,
              (select count(*)::int from selected_forms f where f.account_id = a.id and f.selected) as forms,
              (select count(*)::int from scheduled_jobs j where j.account_id = a.id and j.kind = 'baseline') as earlier,
              (exists (select 1 from baselines b where b.account_id = a.id)
               or exists (select 1 from scheduled_jobs j where j.account_id = a.id and j.kind = 'baseline'
                                                          and j.status in ('scheduled', 'running', 'done'))) as started
         from accounts a left join hubspot_connections c on c.account_id = a.id
        where a.id = $1
        for no key update of a`,
      [accountId],
    );
    if (account === null || account.connection_status !== 'active') return { result: 'not_connected', job: null };
    if (account.forms === 0) return { result: 'no_forms', job: null };
    if (account.started) return { result: 'already_started', job: null };
    const job = await insertJob(tx, {
      kind: 'baseline',
      accountId,
      dedupeKey: baselineDedupeKey(accountId, accountLocalDate(now, account.timezone), account.earlier + 1),
      runAt: now,
      now,
    });
    return { result: job === null ? 'already_started' : 'started', job };
  });
  if (outcome.job !== null) {
    await publishJobs(deps, [outcome.job]);
    log.info('baseline started', { event: 'baseline.requested', accountId, jobId: outcome.job.id });
  }
  return outcome.result;
}
