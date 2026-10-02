import 'server-only';
import { errorCode } from '@/server/domain/errors';
import { cancelScheduledMessages, type CancelledJobs } from '@/server/jobs/cancel';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { sendReserved } from '@/server/services/notifications/send';
import { ensureAccountNotificationsRegistered } from './emails';

// The network half of a state transition (PLAN §6.1, D-28): a transaction reserves owner emails and
// marks jobs cancelled; only after it commits are the reserved emails sent and the QStash messages
// cancelled. Nothing here throws: a lost send is resumed by the sweeper (PLAN §8.3 step 7), and an
// uncancelled message finds its job cancelled.

export interface PostCommitWork {
  /** `notifications_sent.dedupe_key`s reserved in the transaction. */
  readonly sends: readonly string[];
  /** Jobs marked cancelled in the transaction, whose QStash messages to cancel. */
  readonly cancelled: readonly CancelledJobs[];
}

export const NO_POST_COMMIT_WORK: PostCommitWork = { sends: [], cancelled: [] };

export function mergePostCommitWork(...works: readonly PostCommitWork[]): PostCommitWork {
  return {
    sends: works.flatMap((work) => work.sends),
    cancelled: works.flatMap((work) => work.cancelled),
  };
}

/** Runs after the transaction that produced `work` has committed. Never throws. */
export async function runPostCommitWork(deps: Deps, work: PostCommitWork): Promise<void> {
  for (const cancelled of work.cancelled) await cancelScheduledMessages(deps, cancelled);
  if (work.sends.length === 0) return;
  ensureAccountNotificationsRegistered();
  for (const dedupeKey of work.sends) {
    try {
      await sendReserved(deps, dedupeKey);
    } catch (error) {
      // Still `sending`: the sweeper resumes it (PLAN §8.3 step 7).
      log.warn('reserved email not sent yet', { event: 'notification.post_commit_deferred', code: errorCode(error) }, error);
    }
  }
}
