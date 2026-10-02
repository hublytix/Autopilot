import 'server-only';
import type { JobKind } from '@/server/domain/types';
import type { JobFailurePath, JobHandler } from './types';

// Job handlers and failure paths, keyed by kind. Services register theirs (see handlers.ts, the one
// wiring point); the dispatcher, the failure callback and the sweeper look them up. Tests build
// their own registry with createJobRegistry().

export interface JobRegistry {
  /** Registers the handler for `kind`; registering a kind twice is a wiring bug and throws. */
  register(kind: JobKind, handler: JobHandler): void;
  /** Registers `kind`'s failure behaviour (the alert is raised for every kind regardless). */
  registerFailurePath(kind: JobKind, path: JobFailurePath): void;
  handler(kind: JobKind): JobHandler | undefined;
  failurePath(kind: JobKind): JobFailurePath | undefined;
}

export function createJobRegistry(): JobRegistry {
  const handlers = new Map<JobKind, JobHandler>();
  const failurePaths = new Map<JobKind, JobFailurePath>();
  return {
    register(kind, handler) {
      if (handlers.has(kind)) throw new Error('job_handler_already_registered');
      handlers.set(kind, handler);
    },
    registerFailurePath(kind, path) {
      if (failurePaths.has(kind)) throw new Error('job_failure_path_already_registered');
      failurePaths.set(kind, path);
    },
    handler: (kind) => handlers.get(kind),
    failurePath: (kind) => failurePaths.get(kind),
  };
}

/** The process-wide registry the routes, the dev ticker and the sweeper use. */
export const defaultJobRegistry: JobRegistry = createJobRegistry();
