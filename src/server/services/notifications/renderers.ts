import 'server-only';
import type { NotificationKind } from '@/server/domain/types';
import type { Db } from '@/server/db';
import type { CancelledJobs } from '@/server/jobs/cancel';
import type { Deps } from '@/server/ports';
import type { NotificationRow, NotificationSendPlan } from './types';

// The renderer registry: for each kind, how to rebuild a `sending` reservation's send plan from the
// row alone (the stored draft, the lead message, `weekly_reports.metrics` or a template), so a lost
// send can be resumed by the sweeper or by a later job (PLAN §8.3 step 7, §8.4 step 2, D-45).
// `magic_link` is never registered: its hashed token cannot be re-rendered, so the sweeper marks
// such rows failed. Each milestone registers the kinds whose emails it adds (see NOTIFICATION_KINDS).
//
// Failure hooks: what else must happen when a `sending` reservation becomes `failed` without its
// email going out (D-72, D-73): the sweeper gives up on it 23 h after it was first reserved
// (`expired`), or a resume (the sweeper's, or a sendReserved) finds its predicates failing
// (`predicates`), cannot rebuild it (`not_resumable`) or gets a permanent send error (`permanent`).
// The owner never got that email, so a lead must not keep waiting for it: an initial email → the
// lead `skipped` (predicates) or `failed` ("Not processed"); a follow-up email → the lead-page note
// or the stop, and the end of the stream. reserveAndSend runs none: its caller (a job) acts on the
// result itself.

/**
 * Rebuilds the plan for `row`, or returns null when it can no longer be sent (its content was
 * purged, say): the row is then marked failed.
 */
export type NotificationResumer = (deps: Deps, row: NotificationRow) => Promise<NotificationSendPlan | null>;

export type NotificationFailureReason = 'expired' | 'predicates' | 'not_resumable' | 'permanent';

export interface NotificationFailure {
  readonly reason: NotificationFailureReason;
  /** `$now`. */
  readonly now: Date;
}

/** Runs when a `sending` reservation of the kinds it was registered for becomes `failed` unsent. */
export interface NotificationFailureHook {
  /**
   * Inside the transaction that marks the row `failed` (database statements only, no network I/O):
   * an error rolls the failure back, so the row stays `sending` and the next sweep tries again.
   * Returns the jobs it cancelled; their QStash messages are cancelled after commit.
   */
  readonly inTx: (tx: Db, row: NotificationRow, failure: NotificationFailure) => Promise<CancelledJobs | void>;
}

export interface NotificationRegistry {
  /** Registering a kind twice is a wiring bug and throws. */
  register(kind: NotificationKind, resumer: NotificationResumer): void;
  resumer(kind: NotificationKind): NotificationResumer | undefined;
  /** Adds a failure hook for `kind`; adding the same hook again is a no-op. */
  onFailed(kind: NotificationKind, hook: NotificationFailureHook): void;
  failureHooks(kind: NotificationKind): readonly NotificationFailureHook[];
}

export function createNotificationRegistry(): NotificationRegistry {
  const resumers = new Map<NotificationKind, NotificationResumer>();
  const failure = new Map<NotificationKind, Set<NotificationFailureHook>>();
  return {
    register(kind, resumer) {
      if (kind === 'magic_link') throw new Error('notification_magic_link_not_resumable');
      if (resumers.has(kind)) throw new Error('notification_resumer_already_registered');
      resumers.set(kind, resumer);
    },
    resumer: (kind) => resumers.get(kind),
    onFailed(kind, hook) {
      const hooks = failure.get(kind) ?? new Set<NotificationFailureHook>();
      hooks.add(hook);
      failure.set(kind, hooks);
    },
    failureHooks: (kind) => [...(failure.get(kind) ?? [])],
  };
}

/** The process-wide registry used by sendReserved and the sweeper. */
export const defaultNotificationRegistry: NotificationRegistry = createNotificationRegistry();
