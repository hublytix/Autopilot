import 'server-only';
import { z } from 'zod';
import type { Db } from '@/server/db';
import { insertJob, publishJobs, type JobRow } from '@/server/jobs';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';

// HubSpot webhook deliveries, after the signature check (PLAN §7.3, D-05, D-06, D-07; HS-WH-PAYLOAD,
// HS-WH-IDEMPOTENCY, HS-WH-GDPR-PRIVACY-DELETION). In one transaction, for each event of our app:
// - record it in `webhook_events` with dedupe key portalId:subscriptionType:objectId:eventId:occurredAt
//   (ON CONFLICT DO NOTHING: a replay, or HubSpot's retry with a higher attemptNumber, does nothing);
// - `contact.privacyDeletion` for ANY known portal, whatever its state → a `privacy_delete` job;
// - `object.creation` (contacts) / `contact.creation` for an ACTIVE portal → at most once a minute
//   (compare-and-set on `poll_requested_at`) two `portal_poll` jobs, now and +90 s, because the
//   submission may lag behind the contact. The webhook only triggers polls: pollPortal decides
//   what is a lead (there is no form-submission webhook);
// - `last_webhook_at` for every known portal in the delivery.
// Jobs are published after commit. Unknown portals and other event types are recorded and ignored.

export const HUBSPOT_WEBHOOK_MAX_EVENTS = 100;
/** The second poll after a creation event, for a submission that lags behind its contact (D-07). */
export const SECOND_POLL_DELAY_MS = 90 * 1000;
const MINUTE_MS = 60 * 1000;

const hubspotId = z
  .union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^\d{1,20}$/)])
  .transform((value) => String(value));

/** One event (HS-WH-PAYLOAD); ids become strings. Unknown keys are dropped. */
export const hubSpotWebhookEventSchema = z.object({
  eventId: hubspotId,
  subscriptionId: hubspotId.optional(),
  portalId: hubspotId,
  appId: hubspotId,
  occurredAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  subscriptionType: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/),
  attemptNumber: z.number().int().min(0).optional(),
  objectId: hubspotId,
  objectTypeId: z.string().max(32).optional(),
  changeSource: z.string().max(64).optional(),
  changeFlag: z.string().max(64).optional(),
});

export type HubSpotWebhookEvent = z.output<typeof hubSpotWebhookEventSchema>;

const bodySchema = z.array(z.unknown()).max(HUBSPOT_WEBHOOK_MAX_EVENTS);

export interface ParsedWebhookBody {
  events: HubSpotWebhookEvent[];
  /** Array entries that did not match the event schema (dropped). */
  malformed: number;
}

/** The body must be an array of at most 100 entries; null otherwise. Each entry is validated on its own. */
export function parseWebhookBody(json: unknown): ParsedWebhookBody | null {
  const body = bodySchema.safeParse(json);
  if (!body.success) return null;
  const events: HubSpotWebhookEvent[] = [];
  let malformed = 0;
  for (const entry of body.data) {
    const event = hubSpotWebhookEventSchema.safeParse(entry);
    if (event.success) events.push(event.data);
    else malformed += 1;
  }
  return { events, malformed };
}

export type WebhookEventOutcome =
  | 'privacy_delete_queued'
  | 'privacy_delete_duplicate'
  | 'poll_queued'
  | 'poll_debounced'
  | 'portal_not_active'
  | 'unknown_portal'
  | 'ignored';

export interface WebhookSummary {
  events: number;
  malformed: number;
  /** `appId` is not ours (D-06): dropped before anything is recorded. */
  otherApp: number;
  duplicates: number;
  privacyDeletesQueued: number;
  pollsQueued: number;
  pollsDebounced: number;
  notActive: number;
  unknownPortal: number;
  ignored: number;
}

export function webhookDedupeKey(event: HubSpotWebhookEvent): string {
  return `${event.portalId}:${event.subscriptionType}:${event.objectId}:${event.eventId}:${event.occurredAt}`;
}

function isContactCreation(event: HubSpotWebhookEvent): boolean {
  return event.subscriptionType === 'contact.creation' || (event.subscriptionType === 'object.creation' && event.objectTypeId === '0-1');
}

function isPrivacyDeletion(event: HubSpotWebhookEvent): boolean {
  return event.subscriptionType === 'contact.privacyDeletion';
}

const portalSchema = z.object({ id: z.string(), processing_state: z.string(), connection_status: z.string().nullable() });

interface KnownPortal {
  accountId: string;
  active: boolean;
}

async function lookUpPortal(tx: Db, portalId: string): Promise<KnownPortal | null> {
  const raw = await tx.maybeOne(
    `select a.id, a.processing_state, c.status as connection_status
       from accounts a left join hubspot_connections c on c.account_id = a.id
      where a.hubspot_portal_id = $1`,
    [portalId],
  );
  if (raw === null) return null;
  const row = portalSchema.parse(raw);
  return { accountId: row.id, active: row.processing_state === 'active' && row.connection_status === 'active' };
}

/** The `{minute}` of the portal_poll dedupe key: the UTC minute, e.g. `2026-10-06T14:05`. */
export function pollMinuteKey(minuteStart: Date): string {
  return minuteStart.toISOString().slice(0, 16);
}

/** At most one pair of polls per account per minute: the compare-and-set on `poll_requested_at`, then both jobs. */
async function requestPolls(tx: Db, accountId: string, now: Date): Promise<JobRow[] | null> {
  const minuteStart = new Date(Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS);
  const won = await tx.maybeOne(
    `update hubspot_connections c set poll_requested_at = $2
       from accounts a
      where c.account_id = $1 and a.id = c.account_id and a.processing_state = 'active' and c.status = 'active'
        and (c.poll_requested_at is null or c.poll_requested_at < $3)
      returning c.id`,
    [accountId, now, minuteStart],
  );
  if (won === null) return null;
  const minute = pollMinuteKey(minuteStart);
  const jobs: JobRow[] = [];
  for (const [suffix, runAt] of [
    ['a', now],
    ['b', new Date(now.getTime() + SECOND_POLL_DELAY_MS)],
  ] as const) {
    const job = await insertJob(tx, { kind: 'portal_poll', accountId, dedupeKey: `poll:${accountId}:${minute}:${suffix}`, runAt, now });
    if (job !== null) jobs.push(job);
  }
  return jobs;
}

interface BatchState {
  readonly now: Date;
  readonly bodySha256: string;
  readonly portals: Map<string, KnownPortal | null>;
  readonly jobs: JobRow[];
  readonly summary: WebhookSummary;
}

async function handleEvent(tx: Db, event: HubSpotWebhookEvent, state: BatchState): Promise<void> {
  let portal = state.portals.get(event.portalId);
  if (portal === undefined) {
    portal = await lookUpPortal(tx, event.portalId);
    state.portals.set(event.portalId, portal);
  }
  const recorded = await tx.maybeOne<{ id: string }>(
    `insert into webhook_events (provider, dedupe_key, body_sha256, portal_id, account_id, event_type, occurred_at, outcome)
     values ('hubspot', $1, $2, $3, $4, $5, $6, 'received')
     on conflict (provider, dedupe_key) do nothing
     returning id`,
    [webhookDedupeKey(event), state.bodySha256, event.portalId, portal?.accountId ?? null, event.subscriptionType, new Date(event.occurredAt)],
  );
  if (recorded === null) {
    state.summary.duplicates += 1;
    return;
  }
  const outcome = await actOn(tx, event, portal, state);
  await tx.query(`update webhook_events set outcome = $2 where id = $1`, [recorded.id, outcome]);
}

async function actOn(tx: Db, event: HubSpotWebhookEvent, portal: KnownPortal | null, state: BatchState): Promise<WebhookEventOutcome> {
  const { summary } = state;
  const relevant = isPrivacyDeletion(event) || isContactCreation(event);
  if (!relevant) {
    summary.ignored += 1;
    return 'ignored';
  }
  if (portal === null) {
    summary.unknownPortal += 1;
    return 'unknown_portal';
  }
  if (isPrivacyDeletion(event)) {
    const job = await insertJob(tx, {
      kind: 'privacy_delete',
      accountId: portal.accountId,
      dedupeKey: `privacy:${event.portalId}:${event.objectId}:${event.occurredAt}`,
      payload: { portalId: event.portalId, contactId: event.objectId },
      runAt: state.now,
      now: state.now,
    });
    if (job === null) return 'privacy_delete_duplicate';
    state.jobs.push(job);
    summary.privacyDeletesQueued += 1;
    return 'privacy_delete_queued';
  }
  if (!portal.active) {
    summary.notActive += 1;
    return 'portal_not_active';
  }
  const polls = await requestPolls(tx, portal.accountId, state.now);
  if (polls === null) {
    summary.pollsDebounced += 1;
    return 'poll_debounced';
  }
  state.jobs.push(...polls);
  summary.pollsQueued += 1;
  return 'poll_queued';
}

export interface ProcessWebhookInput {
  events: readonly HubSpotWebhookEvent[];
  malformed: number;
  /** sha256 (hex) of the raw body. */
  bodySha256: string;
}

/** Everything after the signature and parse: record, act, publish. */
export async function processHubSpotWebhook(deps: Deps, input: ProcessWebhookInput): Promise<WebhookSummary> {
  const now = deps.clock.now();
  const summary: WebhookSummary = {
    events: input.events.length,
    malformed: input.malformed,
    otherApp: 0,
    duplicates: 0,
    privacyDeletesQueued: 0,
    pollsQueued: 0,
    pollsDebounced: 0,
    notActive: 0,
    unknownPortal: 0,
    ignored: 0,
  };
  const ours = input.events.filter((event) => event.appId === deps.env.HUBSPOT_APP_ID);
  summary.otherApp = input.events.length - ours.length;
  const state: BatchState = { now, bodySha256: input.bodySha256, portals: new Map(), jobs: [], summary };

  if (ours.length > 0) {
    await deps.db.tx(async (tx) => {
      for (const event of ours) await handleEvent(tx, event, state);
      const accounts = new Set([...state.portals.values()].flatMap((portal) => (portal === null ? [] : [portal.accountId])));
      for (const accountId of accounts) {
        await tx.query(
          `update hubspot_connections set last_webhook_at = greatest(coalesce(last_webhook_at, $2), $2) where account_id = $1`,
          [accountId, now],
        );
      }
    });
  }
  await publishJobs(deps, state.jobs);

  log.info('hubspot webhook processed', {
    event: 'webhook.hubspot',
    provider: 'hubspot',
    total: summary.events,
    count: summary.pollsQueued + summary.privacyDeletesQueued,
    skipped: summary.duplicates + summary.otherApp + summary.malformed + summary.unknownPortal + summary.ignored,
  });
  return summary;
}
