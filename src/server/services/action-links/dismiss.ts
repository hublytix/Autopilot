import 'server-only';
import type { Db } from '@/server/db';
import type { Deps } from '@/server/ports';
import { hashActionToken, verifyActionToken, type VerifiedActionToken } from '@/server/security/action-tokens';
import { dismissLead as dismissOwnerLead } from '@/server/services/owner-controls/dismiss';
import { hitActionLinkLimits } from './limits';

// /a/{token}/dismiss (PLAN §6.2, §7.4, D-26, D-45): "Not a real lead".
//
// GET shows a confirmation page and changes nothing: mail scanners open every link in an email, so
// only the page's POST dismisses. The POST (same origin) uses the dismiss token once, by a
// compare-and-set on `use_count = 0` in the same transaction as the dismiss itself, which is
// owner-controls' dismissLead (shared with the dashboard): `leads.dismissed_at`, `stop_reason` set to
// 'dismissed' unless the lead already has one (the first reason is kept, so a test lead keeps
// 'test_lead', its second guard on every lead email), the lead's jobs cancelled (their QStash
// messages after commit). A second POST, or a POST that loses the race, changes nothing and shows the
// same result. Nothing is written to HubSpot (law 2).

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

/** The single-use token compare-and-set, run first in the dismiss transaction; false when it was already used. */
function spendDismissToken(token: string, resolved: ResolvedDismiss): (tx: Db, now: Date) => Promise<boolean> {
  return async (tx, now) => {
    const used = await tx.maybeOne(
      `update action_tokens set use_count = use_count + 1, first_used_at = coalesce(first_used_at, $3)
        where id = $1 and token_hash = $2 and purpose = 'dismiss' and use_count = 0
          and revoked_at is null and expires_at > $3
        returning id`,
      [resolved.token.id, hashActionToken(token), now],
    );
    return used !== null;
  };
}

/** POST: dismisses the token's lead, once (owner-controls' dismissLead, with the token used in its transaction). */
export async function dismissLead(deps: Deps, request: DismissRequest): Promise<DismissOutcome> {
  const retryAfterSeconds = await hitActionLinkLimits(deps, request.ip, request.token);
  if (retryAfterSeconds !== null) return { type: 'rate_limited', retryAfterSeconds };
  const resolved = await resolve(deps, request.token, deps.clock.now());
  if (resolved === null) return { type: 'invalid' };
  if (resolved.token.useCount > 0) return { type: 'unchanged' };

  const outcome = await dismissOwnerLead(
    deps,
    { accountId: resolved.token.accountId, leadId: resolved.token.leadId },
    { via: 'action_link', guard: spendDismissToken(request.token, resolved) },
  );
  return outcome.type === 'dismissed' ? { type: 'dismissed', cancelledJobs: outcome.cancelledJobs } : { type: 'unchanged' };
}
