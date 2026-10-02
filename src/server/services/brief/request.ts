import 'server-only';
import { insertJob, publishJobs, type JobRow } from '@/server/jobs';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import type { OwnerScope } from '@/server/services/auth';
import { BRIEF_JOB_LIVE_SQL, briefGenerationAllowance } from './repository';
import { BRIEF_JOBS_PER_DAY, BRIEF_RATE_WINDOW_MS } from './limits';
import { normaliseSiteUrl } from './site-url';

// Starting a brief generation (PLAN §7.5 /onboarding/brief and /dashboard/brief, §8.2, §9.7, D-36):
// the owner's website address is checked, then one transaction locks the account row, refuses a
// sixth request in 24 hours or a second one while another can still run, inserts the `brief_jobs`
// row (`queued`, `created_at = $now`), records the address on `briefs.source_url` and inserts the
// `brief_generate` job (`brief:{acct}:{brief_job_id}`, payload ids only). The job is published
// after commit; a failed publish is left to the sweeper.

export type BriefRequestRefusal = 'site_url_invalid' | 'site_url_not_allowed' | 'in_progress' | 'daily_limit' | 'account_not_found';

export type BriefRequestResult = { ok: true; briefJobId: string } | { ok: false; reason: BriefRequestRefusal };

export function briefGenerateDedupeKey(accountId: string, briefJobId: string): string {
  return `brief:${accountId}:${briefJobId}`;
}

export async function requestBriefGeneration(scope: OwnerScope, deps: Deps, input: { websiteUrl: string }): Promise<BriefRequestResult> {
  const site = normaliseSiteUrl(input.websiteUrl);
  if (!site.ok) return { ok: false, reason: site.reason };
  const now = deps.clock.now();
  const accountId = scope.accountId;

  const outcome = await deps.db.tx(async (tx): Promise<{ ok: true; briefJobId: string; job: JobRow | null } | { ok: false; reason: BriefRequestRefusal }> => {
    // Serialises requests for one account, so the two limits below hold under concurrency.
    const account = await tx.maybeOne(`select id from accounts where id = $1 for no key update`, [accountId]);
    if (account === null) return { ok: false, reason: 'account_not_found' };
    const inserted = await tx.maybeOne<{ id: string }>(
      `insert into brief_jobs (account_id, status, attempts, created_at)
       select $1, 'queued', 0, $2
        where (select count(*) from brief_jobs where account_id = $1 and created_at > $3) < $4
          and not exists (select 1 from brief_jobs b where b.account_id = $1 and b.status in ('queued', 'running') and ${BRIEF_JOB_LIVE_SQL})
       returning id`,
      [accountId, now, new Date(now.getTime() - BRIEF_RATE_WINDOW_MS), BRIEF_JOBS_PER_DAY],
    );
    if (inserted === null) {
      const allowance = await briefGenerationAllowance(tx, accountId, now);
      return { ok: false, reason: allowance.inProgress ? 'in_progress' : 'daily_limit' };
    }
    await tx.query(
      `insert into briefs (account_id, source_url) values ($1, $2)
       on conflict (account_id) do update set source_url = excluded.source_url`,
      [accountId, site.url],
    );
    const job = await insertJob(tx, {
      kind: 'brief_generate',
      accountId,
      dedupeKey: briefGenerateDedupeKey(accountId, inserted.id),
      payload: { briefJobId: inserted.id },
      runAt: now,
      now,
    });
    return { ok: true, briefJobId: inserted.id, job };
  });

  if (!outcome.ok) {
    log.info('brief generation refused', { event: 'brief.request_refused', accountId, reason: outcome.reason });
    return outcome;
  }
  await publishJobs(deps, [outcome.job]);
  log.info('brief generation queued', { event: 'brief.requested', accountId, briefJobId: outcome.briefJobId });
  return { ok: true, briefJobId: outcome.briefJobId };
}
