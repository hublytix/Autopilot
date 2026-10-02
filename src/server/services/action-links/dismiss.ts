import 'server-only';
import type { Db } from '@/server/db';
import { ACCOUNT_CANCEL_EXCEPT_KINDS, cancelJobsInTx, cancelScheduledMessages, type CancelledJobs } from '@/server/jobs';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { hashActionToken, verifyActionToken, type VerifiedActionToken } from '@/server/security/action-tokens';
import { hitActionLinkLimits } from './limits';

// /a/{token}/dismiss (PLAN §6.2, §7.4, D-26, D-45): "Not a real lead".
//
// GET shows a confirmation page and changes nothing: mail scanners open every link in an email, so
// only the page's POST dismisses. The POST (same origin) uses the dismiss token once, by a
// compare-and-set on `use_count = 0` in the same transaction that sets `leads.dismissed_at`, sets
// `stop_reason` to 'dismissed' (unless the lead already has one: the first reason is kept, so a test
// lead keeps 'test_lead', its second guard on every lead email) and cancels the lead's jobs; their
// QStash messages are cancelled after commit. A second POST, or a POST that loses the race, changes
// nothing and shows the same result. Nothing is written to HubSpot (law 2).

export type DismissLinkState =
  /** Show "Mark this as not a real lead?" with the button. */
  | { readonly type: 'confirm' }
  /** The lead is dismissed (by this link now or earlier, or already before). */
  | { readonly type: 'dismissed' }
  /** Not a live dismiss token (unknown, other purpose, expired, revoked, account unavailable) or no such lead. */
  | { readonly type: 'invalid' }
  | { readonly type: 'rate_limited'; readonly retryAfterSeconds: number };

export type DismissOutcome =
  /** This request dismissed the lead. */
  | { readonly type: 'dismissed'; readonly cancelledJobs: number }
  /** The token was used before (or the lead was already dismissed): nothing changed. */
  | { readonly type: 'unchanged' }
  | { readonly type: 'invalid' }
  | { readonly type: 'rate_limited'; readonly retryAfterSeconds: number };

export interface DismissRequest {
  /** The path segment, untrusted. */
  readonly token: string;
  /** Client IP, for the rate limit only (stored as an HMAC). */
  readonly ip: string;
}

interface ResolvedDismiss {
  readonly token: VerifiedActionToken & { readonly leadId: string };
  readonly leadDismissed: boolean;
}

async function resolve(deps: Deps, token: string, now: Date): Promise<ResolvedDismiss | null> {
  const checked = await verifyActionToken(deps.db, token, 'dismiss', now);
  if (!checked.ok || checked.token.leadId === null) return null;
  const lead = await deps.db.maybeOne<{ dismissed: boolean }>(`select dismissed_at is not null as dismissed from leads where id = $1 and account_id = $2`, [
    checked.token.leadId,
    checked.token.accountId,
  ]);
  if (lead === null) return null;
  return { token: { ...checked.token, leadId: checked.token.leadId }, leadDismissed: lead.dismissed };
}

/** GET: the confirmation page's state. Changes nothing but the rate-limit counters. */
export async function resolveDismissLink(deps: Deps, request: DismissRequest): Promise<DismissLinkState> {
  const retryAfterSeconds = await hitActionLinkLimits(deps, request.ip, request.token);
  if (retryAfterSeconds !== null) return { type: 'rate_limited', retryAfterSeconds };
  const resolved = await resolve(deps, request.token, deps.clock.now());
  if (resolved === null) return { type: 'invalid' };
  return resolved.token.useCount > 0 || resolved.leadDismissed ? { type: 'dismissed' } : { type: 'confirm' };
}

interface DismissedInTx {
  /** False when the lead was already dismissed (the token is still used up). */
  readonly leadChanged: boolean;
  readonly cancelled: CancelledJobs;
}

/** Uses the token (once) and dismisses its lead in `tx`; null when the token was already used. */
async function dismissInTx(tx: Db, token: string, resolved: ResolvedDismiss, now: Date): Promise<DismissedInTx | null> {
  const used = await tx.maybeOne(
    `update action_tokens set use_count = use_count + 1, first_used_at = coalesce(first_used_at, $3)
      where id = $1 and token_hash = $2 and purpose = 'dismiss' and use_count = 0
        and revoked_at is null and expires_at > $3
      returning id`,
    [resolved.token.id, hashActionToken(token), now],
  );
  if (used === null) return null;
  const lead = await tx.maybeOne(
    `update leads set dismissed_at = $3, stop_reason = coalesce(stop_reason, 'dismissed')
      where id = $1 and account_id = $2 and dismissed_at is null
      returning id`,
    [resolved.token.leadId, resolved.token.accountId, now],
  );
  // Lead-scoped jobs only (lead_process, follow-ups); a privacy deletion is never cancelled (D-06).
  const cancelled = await cancelJobsInTx(tx, { leadId: resolved.token.leadId, exceptKinds: ACCOUNT_CANCEL_EXCEPT_KINDS, reason: 'dismissed', now });
  return { leadChanged: lead !== null, cancelled };
}

/** POST: dismisses the token's lead, once. */
export async function dismissLead(deps: Deps, request: DismissRequest): Promise<DismissOutcome> {
  const retryAfterSeconds = await hitActionLinkLimits(deps, request.ip, request.token);
  if (retryAfterSeconds !== null) return { type: 'rate_limited', retryAfterSeconds };
  const now = deps.clock.now();
  const resolved = await resolve(deps, request.token, now);
  if (resolved === null) return { type: 'invalid' };
  if (resolved.token.useCount > 0) return { type: 'unchanged' };

  const done = await deps.db.tx((tx) => dismissInTx(tx, request.token, resolved, now));
  if (done === null) return { type: 'unchanged' };
  await cancelScheduledMessages(deps, done.cancelled);
  log.info('lead dismissed', {
    event: 'action_link.dismiss',
    accountId: resolved.token.accountId,
    leadId: resolved.token.leadId,
    outcome: done.leadChanged ? 'dismissed' : 'already_dismissed',
    count: done.cancelled.jobIds.length,
  });
  return done.leadChanged ? { type: 'dismissed', cancelledJobs: done.cancelled.jobIds.length } : { type: 'unchanged' };
}
