import 'server-only';
import { log } from '@/server/obs/log';
import { defaultNotificationRegistry, type NotificationRegistry, type NotificationResumer } from '@/server/services/notifications/renderers';
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
    const built = await followUpNotificationPlan(deps, { accountId: row.accountId, leadId: key.leadId, n: key.n, followupStream: key.followupStream });
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

/** Registers the lead email resumers (part of registerLeadProcessJob); safe to call more than once. */
export function registerLeadNotifications(registries: { readonly notifications: NotificationRegistry }): void {
  for (const [kind, resumer] of RESUMERS) {
    if (registries.notifications.resumer(kind) === undefined) registries.notifications.register(kind, resumer);
  }
}

/** Before a sendReserved in this process (M5's markReplied): the resumers are in the default registry. */
export function ensureLeadNotificationsRegistered(): void {
  registerLeadNotifications({ notifications: defaultNotificationRegistry });
}
