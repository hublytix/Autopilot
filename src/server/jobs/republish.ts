import 'server-only';
import type { Deps } from '@/server/ports';
import { publishJob, type PublishOutcome } from './outbox';
import { JOB_COLUMNS, toJobRow } from './rows';
import type { JobRow } from './types';

// Re-publish (PLAN §8.3 step 5, D-15): a hop, a quiet-hours re-target, a long wait or the sweeper.
// One compare-and-set moves the row back to `scheduled` with the new `run_at`, `lease_until` null
// and `hops + 1` (also recording the target in `payload.targetAt` and clearing `external_id`, so a
// failure callback for the old message can no longer fail the job and a lost publish is visible to
// the sweeper). Then the message is published with the dedupe id `{key}:h{hops}`; QStash answering
// `deduplicated: true` to that fresh id is an error.

export type RepublishGuard =
  /** Before a claim (hop check, sweeper): the row still has these hops and nobody holds a live lease. */
  | { readonly type: 'hops'; readonly hops: number }
  /** After a claim (re-target): this attempt still holds the job. */
  | { readonly type: 'attempt'; readonly attemptId: string };

export interface RepublishResult {
  /** The row after the compare-and-set. */
  job: JobRow;
  publish: PublishOutcome;
}

/**
 * Moves the job to `runAt` and publishes it. Returns null when the guard no longer holds (another
 * delivery or the sweeper got there first). Throws when the publish fails (the row is then left
 * `scheduled` without `external_id`, for the sweeper) or comes back deduplicated.
 */
export async function republishJob(deps: Deps, job: Pick<JobRow, 'id'>, runAt: Date, guard: RepublishGuard): Promise<RepublishResult | null> {
  const now = deps.clock.now();
  const guardSql =
    guard.type === 'hops'
      ? `hops = $4 and (status = 'scheduled' or (status = 'running' and lease_until < $5))`
      : `attempt_id = $4 and status = 'running'`;
  const params: unknown[] = [job.id, runAt, runAt.toISOString(), guard.type === 'hops' ? guard.hops : guard.attemptId];
  if (guard.type === 'hops') params.push(now);
  const raw = await deps.db.maybeOne(
    `update scheduled_jobs
        set status = 'scheduled', run_at = $2, lease_until = null, hops = hops + 1,
            external_id = null, published_at = null,
            payload = payload || jsonb_build_object('targetAt', $3::text)
      where id = $1 and ${guardSql}
      returning ${JOB_COLUMNS}`,
    params,
  );
  if (raw === null) return null;
  const moved = toJobRow(raw);
  const publish = await publishJob(deps, moved, 'republish');
  return { job: moved, publish };
}
