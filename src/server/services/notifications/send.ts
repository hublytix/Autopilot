import 'server-only';
import { AppError, errorCode, isIdempotencyConflict, isRetryable, PermanentError, TransientError } from '@/server/domain/errors';
import type { Db } from '@/server/db';
import { raiseAlert } from '@/server/jobs/alert';
import { cancelScheduledMessages, type CancelledJobs } from '@/server/jobs/cancel';
import { publishJobs } from '@/server/jobs/outbox';
import type { JobRow } from '@/server/jobs/types';
import { log } from '@/server/obs/log';
import type { Deps, MailTag, OutgoingMail } from '@/server/ports';
import { mintActionTokens, revokeTokens, type MintedTokens } from '@/server/security/action-tokens';
import { claimOnce, rateLimitKeyHash } from '@/server/security/rate-limit';
import { canTakeOver } from './predicates';
import {
  defaultNotificationRegistry,
  type NotificationFailureHook,
  type NotificationFailureReason,
  type NotificationRegistry,
} from './renderers';
import { failReservation, getNotification, reserveInTx, takeOver } from './reserve';
import type { NotificationRow, NotificationSendPlan, ReserveAndSendInput, SendResult } from './types';

// Exactly-once owner emails (PLAN §8.4, D-36, D-45). Every owner email goes through reserveAndSend,
// or through reserveInTx + sendReserved when the reservation belongs in another transaction:
//   1. reserve (INSERT … SELECT WHERE <predicates> ON CONFLICT DO NOTHING);
//   2. no row: `sent` → done; `sending` → take it over (same or paired kind, predicates re-checked);
//      `failed` or no row at all → skip;
//   3. mint the button tokens and count the attempt, and COMMIT, before sending;
//   4. Mailer.send with idempotency key `{ENV_NAMESPACE}:{dedupe_key}`: a transient error leaves the
//      row `sending` and throws (the job retries; the sweeper resumes; a Resend quota error raises
//      one admin alert per quota episode, D-36: per UTC day for the daily quota, per UTC month for
//      the monthly one, however many sends and retries hit it); a permanent one fails the row,
//      revokes the new tokens and raises one alert; Resend's 409 on our own key means an earlier
//      attempt's email already went out: the row is marked sent and the new tokens revoked;
//   5. in one transaction: `sent` + the caller's onSent (lead timestamp, follow-up job rows).
// A resumed reservation (the sweeper, sendReserved) that ends `failed` unsent runs the kind's failure
// hooks in the transaction that fails it (renderers.ts, D-73); reserveAndSend's caller handles its own
// result. A caller that holds a job passes `guard` (its ownership check): the reservation and any
// takeover then happen only while the job is still its own (D-73: a cancelled job never reserves).

const QUOTA_CODES: ReadonlySet<string> = new Set(['daily_quota_exceeded', 'monthly_quota_exceeded']);

/** The start of the quota episode `code` belongs to: the UTC day (daily quota) or month (monthly). */
export function quotaEpisodeStart(code: string, now: Date): Date {
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return code === 'monthly_quota_exceeded' ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) : new Date(day);
}

/** One `resend_quota_exceeded` alert per episode (D-36); a failing marker write alerts anyway. */
async function alertQuotaOnce(deps: Deps, code: string, notificationKind: string): Promise<void> {
  let first = true;
  try {
    first = await claimOnce(deps.db, {
      keyHash: rateLimitKeyHash(deps.env, `resend_quota:${code}`),
      windowStart: quotaEpisodeStart(code, deps.clock.now()),
    });
  } catch (error) {
    log.warn('quota alert marker not written', { event: 'notification.quota_marker_failed', code: errorCode(error) });
  }
  if (first) raiseAlert('resend_quota_exceeded', { notificationKind, errorCode: code });
}

function skipped(reason: Extract<SendResult, { status: 'skipped' }>['reason']): SendResult {
  return { status: 'skipped', reason };
}

/** Reserves `input.dedupeKey` and sends the email once. Throws TransientError when the send should be retried. */
export async function reserveAndSend(deps: Deps, input: ReserveAndSendInput): Promise<SendResult> {
  const now = deps.clock.now();
  const guarded = async <T>(work: (db: Db) => Promise<T>): Promise<T> => {
    const guard = input.guard;
    if (guard === undefined) return work(deps.db);
    return deps.db.tx(async (tx) => {
      await guard(tx);
      return work(tx);
    });
  };
  const reserved = await guarded((db) =>
    reserveInTx(db, {
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      accountId: input.accountId,
      leadId: input.leadId,
      predicates: input.predicates,
      now,
    }),
  );
  if (reserved !== null) return deliver(deps, reserved, input);

  const existing = await getNotification(deps.db, input.dedupeKey);
  if (existing === null) return skipped('predicates');
  if (existing.status === 'sent') return { status: 'already_sent' };
  if (existing.status === 'failed') return skipped('failed_earlier');
  if (!canTakeOver(existing.kind, input.kind)) {
    log.warn('notification takeover refused', { event: 'notification.kind_mismatch', notificationKind: input.kind, reservationId: existing.id });
    return skipped('kind_mismatch');
  }
  const taken = await guarded((db) => takeOver(db, existing, input.kind, input.predicates, now));
  if (taken.type === 'predicates_failed') return skipped('predicates');
  if (taken.type === 'busy') return skipped('busy');
  return deliver(deps, taken.row, input);
}

/** Runs `hooks` for `row` inside `tx`; returns the jobs they cancelled. */
async function runFailureHooksInTx(
  tx: Db,
  hooks: readonly NotificationFailureHook[],
  row: NotificationRow,
  reason: NotificationFailureReason,
  now: Date,
): Promise<CancelledJobs[]> {
  const cancelled: CancelledJobs[] = [];
  for (const hook of hooks) {
    const result = await hook.inTx(tx, row, { reason, now });
    if (result !== undefined) cancelled.push(result);
  }
  return cancelled;
}

async function cancelAfterCommit(deps: Deps, cancelled: readonly CancelledJobs[]): Promise<void> {
  for (const jobs of cancelled) await cancelScheduledMessages(deps, jobs);
}

/**
 * Marks `row` failed (`fail`, default failReservation: still `sending` at its `reserved_at`) and runs
 * the kind's failure hooks in the same transaction; after commit, the QStash messages of the jobs they
 * cancelled. False when the row had changed (nothing ran). A hook error rolls it all back and throws.
 */
export async function failReservationWithHooks(
  deps: Deps,
  row: NotificationRow,
  reason: NotificationFailureReason,
  registry: NotificationRegistry = defaultNotificationRegistry,
  fail: (tx: Db) => Promise<boolean> = (tx) => failReservation(tx, row),
): Promise<boolean> {
  const hooks = registry.failureHooks(row.kind);
  const now = deps.clock.now();
  const outcome = await deps.db.tx(async (tx) => {
    if (!(await fail(tx))) return null;
    return runFailureHooksInTx(tx, hooks, row, reason, now);
  });
  if (outcome === null) return false;
  await cancelAfterCommit(deps, outcome);
  return true;
}

/**
 * After the transaction that called reserveInTx commits: sends that reservation, rebuilding the
 * email through the kind's registered renderer. Also resumes a reservation still `sending` from an
 * earlier attempt (PLAN §9.5 step 1).
 */
export async function sendReserved(
  deps: Deps,
  dedupeKey: string,
  registry: NotificationRegistry = defaultNotificationRegistry,
): Promise<SendResult> {
  const row = await getNotification(deps.db, dedupeKey);
  if (row === null) return skipped('not_reserved');
  return resumeReservation(deps, row, { bySweeper: false }, registry);
}

/**
 * Resumes a `sending` reservation (step 2's takeover with its own kind, then steps 3-5). The sweeper
 * passes `bySweeper` so the resume counts in `sweeper_resumes`. A row that ends `failed` unsent here
 * (no plan, predicates failing, a permanent send error) runs the kind's failure hooks (D-73).
 */
export async function resumeReservation(
  deps: Deps,
  row: NotificationRow,
  options: { bySweeper: boolean },
  registry: NotificationRegistry = defaultNotificationRegistry,
): Promise<SendResult> {
  if (row.status === 'sent') return { status: 'already_sent' };
  if (row.status === 'failed') return skipped('failed_earlier');
  const resumer = registry.resumer(row.kind);
  if (resumer === undefined) {
    log.warn('notification has no renderer', { event: 'notification.no_renderer', notificationKind: row.kind, reservationId: row.id });
    return skipped('no_renderer');
  }
  const plan = await resumer(deps, row);
  if (plan === null) {
    await failReservationWithHooks(deps, row, 'not_resumable', registry);
    log.warn('notification cannot be resumed', { event: 'notification.not_resumable', notificationKind: row.kind, reservationId: row.id });
    return { status: 'failed', code: 'notification_not_resumable' };
  }
  const hooks = registry.failureHooks(row.kind);
  const now = deps.clock.now();
  const { taken, cancelled } = await deps.db.tx(async (tx) => {
    const result = await takeOver(tx, row, row.kind, plan.predicates, now, { bySweeper: options.bySweeper });
    return { taken: result, cancelled: result.type === 'predicates_failed' ? await runFailureHooksInTx(tx, hooks, row, 'predicates', now) : [] };
  });
  await cancelAfterCommit(deps, cancelled);
  if (taken.type === 'predicates_failed') return skipped('predicates');
  if (taken.type === 'busy') return skipped('busy');
  return deliver(deps, taken.row, plan, hooks);
}

function withKindTag(tags: readonly MailTag[] | undefined, kind: string): MailTag[] {
  const list = [...(tags ?? [])];
  if (!list.some((tag) => tag.name === 'kind')) list.unshift({ name: 'kind', value: kind });
  return list;
}

function tokenList(tokens: MintedTokens): string[] {
  return Object.values(tokens).filter((token): token is string => typeof token === 'string');
}

/** Steps 3-5 for a reservation this caller holds (its `reserved_at` is ours). `failureHooks` run on a permanent error. */
async function deliver(deps: Deps, row: NotificationRow, plan: NotificationSendPlan, failureHooks: readonly NotificationFailureHook[] = []): Promise<SendResult> {
  const buttons = plan.buttons ?? [];
  // Step 3: the attempt count and the tokens commit before anything is sent (D-45).
  const minted = await deps.db.tx(async (tx): Promise<MintedTokens | null> => {
    const owned = await tx.maybeOne(
      `update notifications_sent set send_attempts = send_attempts + 1
        where id = $1 and status = 'sending' and reserved_at = $2 returning id`,
      [row.id, row.reservedAt],
    );
    if (owned === null) return null;
    if (buttons.length === 0) return {};
    if (row.accountId === null) throw new PermanentError('notification_tokens_need_account');
    return mintActionTokens(tx, {
      accountId: row.accountId,
      leadId: row.leadId,
      draftId: plan.draftId,
      notificationKey: row.dedupeKey,
      purposes: buttons,
      now: deps.clock.now(),
    });
  });
  if (minted === null) return skipped('busy');
  const mintedTokens = tokenList(minted);

  const rendered = await plan.render(minted);
  const mail: OutgoingMail = {
    to: rendered.to,
    replyTo: rendered.replyTo,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    tags: withKindTag(rendered.tags, row.kind),
    idempotencyKey: `${deps.env.ENV_NAMESPACE}:${row.dedupeKey}`,
  };

  // Step 4.
  let providerMessageId: string | null;
  let viaIdempotencyConflict = false;
  try {
    providerMessageId = (await deps.mailer.send(mail)).providerMessageId;
  } catch (error) {
    if (isIdempotencyConflict(error)) {
      providerMessageId = null;
      viaIdempotencyConflict = true;
    } else if (isRetryable(error)) {
      if (QUOTA_CODES.has(error.code)) await alertQuotaOnce(deps, error.code, row.kind);
      log.warn('notification send failed transiently', {
        event: 'notification.transient',
        notificationKind: row.kind,
        reservationId: row.id,
        code: error.code,
      });
      if (error instanceof TransientError) throw error;
      throw new TransientError('notification_send_transient', { httpStatus: error.httpStatus });
    } else if (error instanceof AppError) {
      const now = deps.clock.now();
      const cancelled = await deps.db.tx(async (tx) => {
        const failed = await tx.maybeOne(`update notifications_sent set status = 'failed' where id = $1 and status = 'sending' returning id`, [row.id]);
        if (mintedTokens.length > 0) await revokeTokens(tx, { tokens: mintedTokens, now });
        return failed === null ? [] : runFailureHooksInTx(tx, failureHooks, row, 'permanent', now);
      });
      await cancelAfterCommit(deps, cancelled);
      raiseAlert('notification_send_failed', { notificationKind: row.kind, reservationId: row.id, errorCode: error.code });
      return { status: 'failed', code: error.code };
    } else {
      // Not a mapped provider error: keep the reservation and let the job (or the sweeper) retry.
      log.warn('notification send failed unexpectedly', { event: 'notification.unexpected', reservationId: row.id, code: errorCode(error) });
      throw new TransientError('notification_send_unexpected');
    }
  }

  // Step 5: `sent` and the caller's side effects in one transaction.
  const jobs = await deps.db.tx(async (tx): Promise<readonly (JobRow | null)[]> => {
    const marked = await tx.maybeOne(
      `update notifications_sent set status = 'sent', sent_at = $2, provider_message_id = $3, recipients_count = $4
        where id = $1 and status <> 'sent' returning id`,
      [row.id, deps.clock.now(), providerMessageId, mail.to.length],
    );
    if (viaIdempotencyConflict && mintedTokens.length > 0) {
      await revokeTokens(tx, { tokens: mintedTokens, now: deps.clock.now() });
    }
    if (marked === null || plan.onSent === undefined) return [];
    return (await plan.onSent(tx, providerMessageId)) ?? [];
  });
  if (jobs.length > 0) await publishJobs(deps, jobs);
  log.info('notification sent', {
    event: 'notification.sent',
    notificationKind: row.kind,
    reservationId: row.id,
    outcome: viaIdempotencyConflict ? 'idempotency_conflict' : 'sent',
  });
  return { status: 'sent', providerMessageId, viaIdempotencyConflict };
}
