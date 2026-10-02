import 'server-only';
import { isRevoked } from '@/server/domain/errors';
import { JobOutcomes, type JobHandler } from '@/server/jobs';
import type { Sleep } from '@/server/services/hubspot';
import { pollPortal } from './poll-portal';

// The `portal_poll` job (PLAN §8.2): inserted by the webhook route (debounced, now and +90 s) and
// delivered by QStash. It polls the account as `webhook`, so the leads it finds record that trigger.
// A busy lease (another poll is running) or an account that is no longer active ends the job
// `skipped`: the running poll, or the next cron poll, covers the same submissions. A revoked
// connection is skipped too (the revoke path already ran); other errors retry through QStash.

export interface PortalPollJobOptions {
  /** For the portal limiter; default real timers (tests advance their FakeClock). */
  sleep?: Sleep | undefined;
}

export function createPortalPollJobHandler(options: PortalPollJobOptions = {}): JobHandler {
  return async (deps, job) => {
    if (job.accountId === null) return JobOutcomes.skipped();
    try {
      const result = await pollPortal(deps, job.accountId, 'webhook', { sleep: options.sleep });
      return result.status === 'polled' ? JobOutcomes.done() : JobOutcomes.skipped();
    } catch (error) {
      if (isRevoked(error)) return JobOutcomes.skipped();
      throw error;
    }
  };
}

export const portalPollJobHandler: JobHandler = createPortalPollJobHandler();
