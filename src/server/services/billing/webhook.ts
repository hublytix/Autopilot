import 'server-only';
import { z } from 'zod';
import { errorCode, isAppError } from '@/server/domain/errors';
import { raiseAlert } from '@/server/jobs/alert';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { sha256Hex } from '@/server/security/keys';
import type { ApplyOutcome } from './apply';
import { loadSubscriptionByProviderId } from './rows';
import { DAY_MS } from '@/server/domain/checkout-guard';
import { syncSubscription } from './sync';
import { loadTombstone, reconcileTombstone, type TombstoneOutcome } from './tombstone';

// A verified Razorpay webhook (PLAN §7.3, D-05, D-19; RZP-WH-IDEMPOTENCY-EVENT-ID,
// RZP-WH-REPLAY-TIMESTAMP, RZP-SUB-WEBHOOK-EVENTS-PAYLOAD). The signature was checked on the raw
// body by the route (http/razorpay-webhook.ts). Here:
// 1. record it once: `webhook_events` (provider razorpay) with dedupe_key = the x-razorpay-event-id
//    header, or `sha256:<body hash>` without one, plus the partial unique index on body_sha256, so a
//    replayed signed body under a fresh (unsigned) header id is a duplicate too. A duplicate → 200;
// 2. the `created_at` window: at most 5 minutes ahead of us and no more than 16 days old (Razorpay
//    sends no signed timestamp; retries run 24 h, manual replays up to 15 days). Outside it → 200,
//    recorded, nothing applied;
// 3. the event is only a trigger: the subscription it names is read with GET /v1/subscriptions/{id}
//    and applied only when newer, then applyProcessingState (services/billing/sync.ts);
// 4. no row: a tombstoned subscription (purged account) is reconciled (services/billing/tombstone.ts).
//    A tombstone already resolved is answered at once, except for the events only a subscription
//    that holds a mandate sends (authenticated, activated, charged, resumed, pending, halted): those
//    are read again, so a wrong resolution can't let a purged account be charged (D-82). An
//    unknown subscription gets a 200 and an admin warning;
// 5. a Razorpay read that fails transiently (or on our configuration) releases the record and answers
//    503, so Razorpay delivers again (it retries for 24 h); a permanent refusal is recorded, alerted
//    and answered 200 (a retry would not change it).
// Nothing from the body is logged: ids, codes and counts only.

export const RAZORPAY_WEBHOOK_MAX_FUTURE_MS = 5 * 60 * 1000;
export const RAZORPAY_WEBHOOK_MAX_AGE_MS = 16 * DAY_MS;

const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]{1,40}$/;

/** Events that mean the subscription holds a mandate (and may be charged): a resolved tombstone is read again. */
export const LIVE_SUBSCRIPTION_EVENTS: ReadonlySet<string> = new Set([
  'subscription.authenticated',
  'subscription.activated',
  'subscription.charged',
  'subscription.resumed',
  'subscription.pending',
  'subscription.halted',
]);
const EVENT_ID = /^[\x21-\x7e]{1,200}$/;

const envelopeSchema = z.object({
  event: z.string().min(1).max(100),
  created_at: z.number().int().nonnegative(),
  payload: z
    .object({ subscription: z.object({ entity: z.object({ id: z.string().max(100) }) }).optional() })
    .optional(),
});

export type RazorpayWebhookOutcome =
  | 'duplicate'
  | 'malformed'
  | 'too_old'
  | 'too_new'
  | 'ignored'
  | 'applied'
  | 'not_newer'
  | 'unknown_status'
  | 'gone'
  | 'fetch_refused'
  | 'tombstone_cancelled'
  | 'tombstone_resolved'
  | 'tombstone_open'
  | 'tombstone_cancel_failed'
  | 'unknown_subscription'
  | 'retry_later';

export interface RazorpayWebhookResult {
  /** 200, or 503 when Razorpay should deliver it again. */
  readonly status: 200 | 503;
  readonly outcome: RazorpayWebhookOutcome;
}

export interface RazorpayWebhookInput {
  /** The raw body bytes (already verified). */
  readonly rawBody: Uint8Array;
  /** The x-razorpay-event-id header (unsigned), or null. */
  readonly eventId: string | null;
}

/** The dedupe key (D-05): the event id header when usable, else `sha256:<body hash>`. */
export function razorpayDedupeKey(eventId: string | null, bodySha256: string): string {
  return eventId !== null && EVENT_ID.test(eventId) ? eventId : `sha256:${bodySha256}`;
}

function parseEnvelope(rawBody: Uint8Array): z.infer<typeof envelopeSchema> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)) as unknown;
  } catch {
    return null;
  }
  const result = envelopeSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

function applyOutcome(outcome: ApplyOutcome): RazorpayWebhookOutcome {
  if (outcome.type === 'applied') return outcome.known ? 'applied' : 'unknown_status';
  return outcome.type;
}

function tombstoneOutcome(outcome: TombstoneOutcome): RazorpayWebhookOutcome {
  switch (outcome.type) {
    case 'cancelled':
      return 'tombstone_cancelled';
    case 'resolved':
      return 'tombstone_resolved';
    case 'open':
      return 'tombstone_open';
    case 'cancel_failed':
      return 'tombstone_cancel_failed';
  }
}

/** Should Razorpay deliver this again? Transient failures and our own misconfiguration: yes. */
function retryable(error: unknown): boolean {
  return !isAppError(error) || error.kind === 'transient' || error.kind === 'config';
}

export async function processRazorpayWebhook(deps: Deps, input: RazorpayWebhookInput): Promise<RazorpayWebhookResult> {
  const now = deps.clock.now();
  const bodySha256 = sha256Hex(input.rawBody);
  const dedupeKey = razorpayDedupeKey(input.eventId, bodySha256);
  const envelope = parseEnvelope(input.rawBody);
  const occurredAt = envelope === null ? null : new Date(envelope.created_at * 1000);

  const recorded = await deps.db.maybeOne<{ id: string }>(
    `insert into webhook_events (provider, dedupe_key, body_sha256, event_type, occurred_at, outcome, recorded_at)
     values ('razorpay', $1, $2, $3, $4, 'received', $5)
     on conflict do nothing
     returning id`,
    [dedupeKey, bodySha256, envelope?.event ?? null, occurredAt, now],
  );
  if (recorded === null) {
    log.info('razorpay webhook duplicate', { event: 'webhook.razorpay_duplicate', provider: 'razorpay' });
    return { status: 200, outcome: 'duplicate' };
  }
  const webhookEventId = recorded.id;
  const finish = async (outcome: RazorpayWebhookOutcome, accountId: string | null = null): Promise<RazorpayWebhookResult> => {
    await deps.db.query(`update webhook_events set outcome = $2, account_id = coalesce($3::uuid, account_id) where id = $1`, [webhookEventId, outcome, accountId]);
    log.info('razorpay webhook handled', { event: 'webhook.razorpay', provider: 'razorpay', webhookEventId, outcome, accountId: accountId ?? undefined });
    return { status: 200, outcome };
  };
  const release = async (error: unknown, accountId: string | null): Promise<RazorpayWebhookResult> => {
    // Forget the record so Razorpay's next delivery is processed, not answered as a duplicate.
    await deps.db.query(`delete from webhook_events where id = $1`, [webhookEventId]);
    if (!isAppError(error)) raiseAlert('billing_webhook_error', { accountId: accountId ?? undefined });
    else if (error.kind === 'config') raiseAlert('billing_razorpay_config', { accountId: accountId ?? undefined, errorCode: error.code });
    log.warn('razorpay webhook deferred', { event: 'webhook.razorpay_retry', provider: 'razorpay', accountId: accountId ?? undefined, code: errorCode(error) });
    return { status: 503, outcome: 'retry_later' };
  };

  if (envelope === null || occurredAt === null) return finish('malformed');
  if (occurredAt.getTime() > now.getTime() + RAZORPAY_WEBHOOK_MAX_FUTURE_MS) return finish('too_new');
  if (occurredAt.getTime() < now.getTime() - RAZORPAY_WEBHOOK_MAX_AGE_MS) return finish('too_old');

  const subscriptionId = envelope.payload?.subscription?.entity.id;
  if (!envelope.event.startsWith('subscription.') || subscriptionId === undefined || !SUBSCRIPTION_ID.test(subscriptionId)) return finish('ignored');

  const row = await loadSubscriptionByProviderId(deps.db, subscriptionId);
  if (row !== null) {
    const pendingEventAt = envelope.event === 'subscription.pending' ? occurredAt : null;
    try {
      return await finish(applyOutcome(await syncSubscription(deps, row, pendingEventAt)), row.accountId);
    } catch (error) {
      if (retryable(error)) return release(error, row.accountId);
      raiseAlert('billing_webhook_fetch_refused', { accountId: row.accountId, subscriptionId: row.id, errorCode: errorCode(error) });
      return finish('fetch_refused', row.accountId);
    }
  }

  const tombstone = await loadTombstone(deps.db, subscriptionId);
  if (tombstone !== null) {
    if (tombstone.resolvedAt !== null && !LIVE_SUBSCRIPTION_EVENTS.has(envelope.event)) return finish('tombstone_resolved');
    try {
      return await finish(tombstoneOutcome(await reconcileTombstone(deps, tombstone)));
    } catch (error) {
      if (retryable(error)) return release(error, null);
      raiseAlert('billing_tombstone_fetch_refused', { subscriptionId, errorCode: errorCode(error) });
      return finish('fetch_refused');
    }
  }

  // No row and no tombstone: not ours (another integration on the same Razorpay account?) or a bug.
  raiseAlert('billing_webhook_unknown_subscription', { subscriptionId });
  return finish('unknown_subscription');
}
