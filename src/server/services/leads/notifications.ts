import 'server-only';
import { JOB_LEASE_MS } from '@/server/jobs/types';
import { log } from '@/server/obs/log';
import {
  defaultNotificationRegistry,
  type NotificationFailureHook,
  type NotificationRegistry,
  type NotificationResumer,
} from '@/server/services/notifications/renderers';
import { followUpNotificationPlan } from './follow-up-notification';
import { initialNotificationPlan } from './initial-notification';
import { replyDetectedNotificationPlan } from './reply-detected-notification';

// The resumers of the lead emails (PLAN §8.3 step 7, §8.4 step 2, D-45): `new_lead`, `needs_touch`
// (initial and follow-up keys), `follow_up` and `reply_detected`. Each rebuilds the send plan from
// the reservation's key and the stored rows (draft, lead content, settings), so a send lost to a
// crash or a transient Resend error is finished by the sweeper or a later sendReserved. A plan that
// can no longer be built (content purged, lead gone) returns null and the reservation becomes failed.

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const INITIAL_KEY = new RegExp(`^notify:(${UUID}):initial:r(\\d{1,9})$`);
const FOLLOW_UP_KEY = new RegExp(`^notify:(${UUID}):fu([12]):s(\\d{1,9})$`);
const REPLY_KEY = new RegExp(`^reply:(${UUID}):s(\\d{1,9})$`);

export type LeadNotificationKey =
  | { readonly type: 'initial'; readonly leadId: string; readonly processRev: number }
  | { readonly type: 'follow_up'; readonly leadId: string; readonly n: 1 | 2; readonly followupStream: number }
  | { readonly type: 'reply'; readonly leadId: string; readonly followupStream: number };

/** Parses a lead email's dedupe key (PLAN §8.4); null for any other key. */
export function parseLeadNotificationKey(key: string): LeadNotificationKey | null {
  const initial = INITIAL_KEY.exec(key);
  if (initial?.[1] !== undefined && initial[2] !== undefined) return { type: 'initial', leadId: initial[1], processRev: Number(initial[2]) };
  const followUp = FOLLOW_UP_KEY.exec(key);
  if (followUp?.[1] !== undefined && followUp[2] !== undefined && followUp[3] !== undefined) {
    return { type: 'follow_up', leadId: followUp[1], n: followUp[2] === '1' ? 1 : 2, followupStream: Number(followUp[3]) };
  }
  const reply = REPLY_KEY.exec(key);
  if (reply?.[1] !== undefined && reply[2] !== undefined) return { type: 'reply', leadId: reply[1], followupStream: Number(reply[2]) };
  return null;
}

function unresumable(row: Parameters<NotificationResumer>[1], reason: string): null {
  log.warn('lead email cannot be rebuilt', { event: 'lead.notification_not_resumable', notificationKind: row.kind, reservationId: row.id, reason });
  return null;
}

/** new_lead and needs_touch under the initial key; needs_touch and follow_up under a follow-up key. */
const resumeLeadEmail: NotificationResumer = async (deps, row) => {
  const key = parseLeadNotificationKey(row.dedupeKey);
  if (key === null || row.accountId === null) return unresumable(row, 'key');
  if (key.type === 'initial' && (row.kind === 'new_lead' || row.kind === 'needs_touch')) {
    const built = await initialNotificationPlan(deps, { accountId: row.accountId, leadId: key.leadId, processRev: key.processRev, kind: row.kind });
    return built.ok ? built.plan : unresumable(row, built.problem);
  }
  if (key.type === 'follow_up' && (row.kind === 'follow_up' || row.kind === 'needs_touch')) {
    const built = await followUpNotificationPlan(deps, {
      accountId: row.accountId,
      leadId: key.leadId,
      n: key.n,
      followupStream: key.followupStream,
      // The job read HubSpot within its lease before it reserved: a complete read since then counts.
      repliesCheckedSince: new Date(row.firstReservedAt.getTime() - JOB_LEASE_MS),
    });
    return built === null ? unresumable(row, 'source') : built.plan;
  }
  return unresumable(row, 'kind');
};

const resumeReplyDetected: NotificationResumer = async (deps, row) => {
  const key = parseLeadNotificationKey(row.dedupeKey);
  if (key?.type !== 'reply') return unresumable(row, 'key');
  return (await replyDetectedNotificationPlan(deps, { accountId: row.accountId, leadId: key.leadId })) ?? unresumable(row, 'source');
};

const RESUMERS = [
  ['new_lead', resumeLeadEmail],
  ['needs_touch', resumeLeadEmail],
  ['follow_up', resumeLeadEmail],
  ['reply_detected', resumeReplyDetected],
] as const;

/**
 * A lead's first email (`notify:{lead}:initial:r{rev}`) became `failed` unsent outside lead_process
 * (D-72 closing D-68's open point, D-73): the sweeper expired it after 23 h, or a resume (the sweeper's
 * takeover after the job ended on a send outage, D-68) found its predicates failing, could not rebuild
 * it, or got a permanent send error. The lead, still `processing` at that revision, becomes `skipped`
 * when the predicates failed (as lead_process does: dismissed, paused, disconnected, …) and `failed`
 * otherwise ("Not processed", D-32), in the same transaction. It gets no follow-ups (only the `sent`
 * transaction creates them). A lead that moved on (notified by the paired email, re-processed after an
 * override) is left alone.
 */
export const initialEmailFailed: NotificationFailureHook = {
  inTx: async (tx, row, failure) => {
    const key = parseLeadNotificationKey(row.dedupeKey);
    if (key?.type !== 'initial' || row.accountId === null) return;
    const state = failure.reason === 'predicates' ? 'skipped' : 'failed';
    const changed = await tx.maybeOne(
      `update leads set processing_state = $4
        where id = $1 and account_id = $2 and process_rev = $3 and processing_state = 'processing' and not is_test
        returning id`,
      [key.leadId, row.accountId, key.processRev, state],
    );
    if (changed !== null) {
      log.warn('lead email not sent: lead not processed', {
        event: 'lead.notification_abandoned',
        accountId: row.accountId,
        leadId: key.leadId,
        notificationKind: row.kind,
        reason: failure.reason,
        status: state,
      });
    }
  },
};

/** Registers the lead email resumers and the initial email's failure hook (part of registerLeadProcessJob); safe to call more than once. */
export function registerLeadNotifications(registries: { readonly notifications: NotificationRegistry }): void {
  for (const [kind, resumer] of RESUMERS) {
    if (registries.notifications.resumer(kind) === undefined) registries.notifications.register(kind, resumer);
  }
  registries.notifications.onFailed('new_lead', initialEmailFailed);
  registries.notifications.onFailed('needs_touch', initialEmailFailed);
}

/** Before a sendReserved in this process (M5's markReplied): the resumers are in the default registry. */
export function ensureLeadNotificationsRegistered(): void {
  registerLeadNotifications({ notifications: defaultNotificationRegistry });
}
