import 'server-only';
import type { NotificationKind } from '@/server/domain/types';
import type { Deps } from '@/server/ports';
import type { NotificationRow, NotificationSendPlan } from './types';

// The renderer registry: for each kind, how to rebuild a `sending` reservation's send plan from the
// row alone (the stored draft, the lead message, `weekly_reports.metrics` or a template), so a lost
// send can be resumed by the sweeper or by a later job (PLAN §8.3 step 7, §8.4 step 2, D-45).
// `magic_link` is never registered: its hashed token cannot be re-rendered, so the sweeper marks
// such rows failed. Each milestone registers the kinds whose emails it adds (see NOTIFICATION_KINDS).

/**
 * Rebuilds the plan for `row`, or returns null when it can no longer be sent (its content was
 * purged, say): the row is then marked failed.
 */
export type NotificationResumer = (deps: Deps, row: NotificationRow) => Promise<NotificationSendPlan | null>;

export interface NotificationRegistry {
  /** Registering a kind twice is a wiring bug and throws. */
  register(kind: NotificationKind, resumer: NotificationResumer): void;
  resumer(kind: NotificationKind): NotificationResumer | undefined;
}

export function createNotificationRegistry(): NotificationRegistry {
  const resumers = new Map<NotificationKind, NotificationResumer>();
  return {
    register(kind, resumer) {
      if (kind === 'magic_link') throw new Error('notification_magic_link_not_resumable');
      if (resumers.has(kind)) throw new Error('notification_resumer_already_registered');
      resumers.set(kind, resumer);
    },
    resumer: (kind) => resumers.get(kind),
  };
}

/** The process-wide registry used by sendReserved and the sweeper. */
export const defaultNotificationRegistry: NotificationRegistry = createNotificationRegistry();
