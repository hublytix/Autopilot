import 'server-only';
import type { JobKind } from '@/server/domain/types';
import type { Deps } from '@/server/ports';
import { jobRunHeaders, runJob } from './dispatcher';
import { handleFailureCallback } from './failure';
import { ensureJobHandlersRegistered } from './handlers';
import type { JobRegistry } from './registry';

// Fake mode, the simulation and tests deliver jobs without HTTP: the FakeScheduler calls these in
// place of `/api/jobs/run` and `/api/jobs/failed`, with the same results the routes would return.
// Shapes match FakeDispatch / FakeOnFailure structurally (jobs never import adapters).

export interface SchedulerDelivery {
  messageId: string;
  jobId: string;
  kind: JobKind;
  retried: number;
}

export interface SchedulerFailure {
  messageId: string;
  jobId: string;
}

export interface SchedulerBridge {
  dispatch(delivery: SchedulerDelivery): Promise<{ status: number; headers: Headers }>;
  onFailure(failure: SchedulerFailure): Promise<void>;
}

/**
 * `getDeps` is read at delivery time, so the bridge can be handed to the FakeScheduler before the
 * Deps that contain that scheduler exist. Without `registry`, every registered handler is used
 * (ensureJobHandlersRegistered).
 */
export function createSchedulerBridge(getDeps: () => Deps, registry?: JobRegistry): SchedulerBridge {
  const registryOf = (): JobRegistry => registry ?? ensureJobHandlersRegistered().jobs;
  return {
    async dispatch(delivery) {
      const result = await runJob(getDeps(), { jobId: delivery.jobId, messageId: delivery.messageId, retried: delivery.retried }, registryOf());
      return { status: result.status, headers: jobRunHeaders(result) };
    },
    async onFailure(failure) {
      await handleFailureCallback(getDeps(), { jobId: failure.jobId, sourceMessageId: failure.messageId }, registryOf());
    },
  };
}
