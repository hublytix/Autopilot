import 'server-only';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { catchUpOrphanedContent, contentRetentionDue, runContentRetention, type ContentRetentionSummary } from './content';
import { pruneExpiredRows, type PruneSummary } from './prune';

// The two ways retention runs (PLAN §9.10, D-49):
// - the retention guard, called by the 5-minute poll cron after the sweeper: one cheap existence
//   check, and the content steps 1-4 only when something is due, so lead content and drafts never
//   outlive their purge time by more than a few minutes (D-49's "30 d + 1 h" bound);
// - the daily run (`/api/cron/daily`): the same steps, the catch-all for orphaned drafts and keys,
//   and the step 7 prunes.

export type RetentionGuardResult = { readonly ran: false } | ({ readonly ran: true } & ContentRetentionSummary);

/** The poll cron's guard. Counts only; `{ran: false}` when nothing was due. */
export async function runRetentionGuardSteps(deps: Pick<Deps, 'db' | 'clock'>): Promise<RetentionGuardResult> {
  if (!(await contentRetentionDue(deps.db, deps.clock.now()))) return { ran: false };
  const summary = await runContentRetention(deps);
  log.info('retention guard ran', {
    event: 'retention.guard',
    count: summary.leadMessagesDeleted,
    total: summary.draftsPurged,
  });
  return { ran: true, ...summary };
}

export interface DailyRetentionSummary extends ContentRetentionSummary, PruneSummary {
  readonly orphanedDraftsPurged: number;
  readonly orphanedKeysCleared: number;
}

/** The daily cron's DB-local steps: 1-4, the catch-all and 7. */
export async function runDailyRetention(deps: Pick<Deps, 'db' | 'clock' | 'env'>): Promise<DailyRetentionSummary> {
  const content = await runContentRetention(deps);
  const now = deps.clock.now();
  const orphaned = await catchUpOrphanedContent(deps.db, now);
  const pruned = await pruneExpiredRows(deps.db, deps.env, now);
  const summary: DailyRetentionSummary = {
    ...content,
    ...pruned,
    orphanedDraftsPurged: orphaned.draftsPurged,
    orphanedKeysCleared: orphaned.submissionKeysCleared,
  };
  log.info('daily retention ran', { event: 'retention.daily', count: summary.leadMessagesDeleted, total: summary.draftsPurged });
  return summary;
}
