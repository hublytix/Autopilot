import 'server-only';
import type { Db } from '@/server/db';
import { ACCOUNT_CANCEL_EXCEPT_KINDS, cancelJobsInTx, cancelScheduledMessages, type CancelledJobs } from '@/server/jobs/cancel';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import type { OwnerScope } from '@/server/services/auth/owner-scope';

// "Not a real lead" (PLAN §6.2 "dismiss POST → dismissed_at, jobs cancelled", §7.4, §7.5), shared by
// the /a/{token}/dismiss page (services/action-links/dismiss.ts, which uses its single-use token in
// the same transaction through `guard`) and the dashboard (M6, dismissLeadForOwner).
//
// One transaction: `dismissed_at = $now` while still null; `stop_reason = coalesce(stop_reason,
// 'dismissed')` (the first reason is kept: a test lead keeps `test_lead`, a replied lead `replied`, a
// privacy-deleted one `privacy_deletion`); the lead's scheduled and running jobs are cancelled
// (lead_process, follow-ups), never a privacy deletion (D-06). QStash messages are cancelled after
// commit. Idempotent: dismissing a dismissed lead changes nothing but cancelling any job still left.
// A follow-up job already past its stop check is caught by its reservation predicate (dismissed_at
// is null), so a dismiss during drafting is respected (PLAN §6.2). Nothing is written to HubSpot
// (law 2), and the lead's action tokens stay valid: the owner may still answer the lead by hand.

/** Where the dismiss came from (logged). */
export type DismissVia = 'action_link' | 'dashboard';

export interface LeadRef {
  readonly accountId: string;
  readonly leadId: string;
}

export type DismissLeadOutcome =
  /** This call dismissed the lead. */
  | { readonly type: 'dismissed'; readonly cancelledJobs: number }
  /** It was dismissed before; jobs still left were cancelled. */
  | { readonly type: 'already_dismissed'; readonly cancelledJobs: number }
  /** No such lead in that account. */
  | { readonly type: 'not_found' }
  /** `guard` said no (e.g. the dismiss token was used meanwhile): nothing changed. */
  | { readonly type: 'refused' };

export interface DismissLeadOptions {
  readonly via: DismissVia;
  /**
   * Runs first inside the transaction, with `$now`; returning false changes nothing (the action
   * link's single-use token compare-and-set, so the token and the lead commit together).
   */
  readonly guard?: ((tx: Db, now: Date) => Promise<boolean>) | undefined;
}

export interface DismissedInTx {
  readonly outcome: DismissLeadOutcome;
  /** The QStash messages to cancel after commit. */
  readonly cancelled: CancelledJobs;
}

const NOTHING_CANCELLED: CancelledJobs = { jobIds: [], messageIds: [] };

/** The dismiss inside the caller's transaction (no network I/O); cancel `cancelled` after commit. */
export async function dismissLeadInTx(tx: Db, lead: LeadRef, now: Date): Promise<DismissedInTx> {
  const changed = await tx.maybeOne(
    `update leads set dismissed_at = $3, stop_reason = coalesce(stop_reason, 'dismissed')
      where id = $1 and account_id = $2 and dismissed_at is null
      returning id`,
    [lead.leadId, lead.accountId, now],
  );
  if (changed === null) {
    const exists = await tx.maybeOne(`select id from leads where id = $1 and account_id = $2`, [lead.leadId, lead.accountId]);
    if (exists === null) return { outcome: { type: 'not_found' }, cancelled: NOTHING_CANCELLED };
  }
  // Lead-scoped jobs only (lead_process, follow-ups); a privacy deletion is never cancelled (D-06).
  const cancelled = await cancelJobsInTx(tx, { leadId: lead.leadId, accountId: lead.accountId, exceptKinds: ACCOUNT_CANCEL_EXCEPT_KINDS, reason: 'dismissed', now });
  const cancelledJobs = cancelled.jobIds.length;
  return { outcome: changed === null ? { type: 'already_dismissed', cancelledJobs } : { type: 'dismissed', cancelledJobs }, cancelled };
}

/** Dismisses the lead (ids: the action link, internal callers). Idempotent. */
export async function dismissLead(deps: Deps, lead: LeadRef, options: DismissLeadOptions): Promise<DismissLeadOutcome> {
  const now = deps.clock.now();
  const done = await deps.db.tx(async (tx): Promise<DismissedInTx> => {
    if (options.guard !== undefined && !(await options.guard(tx, now))) return { outcome: { type: 'refused' }, cancelled: NOTHING_CANCELLED };
    return dismissLeadInTx(tx, lead, now);
  });
  await cancelScheduledMessages(deps, done.cancelled);
  if (done.outcome.type === 'dismissed' || done.outcome.type === 'already_dismissed') {
    log.info('lead dismissed', {
      event: 'lead.dismissed',
      accountId: lead.accountId,
      leadId: lead.leadId,
      mode: options.via,
      outcome: done.outcome.type,
      count: done.outcome.cancelledJobs,
    });
  }
  return done.outcome;
}

/** The dashboard's "Not a real lead" (M6): the owner's own lead only. */
export async function dismissLeadForOwner(deps: Deps, scope: OwnerScope, leadId: string): Promise<DismissLeadOutcome> {
  return dismissLead(deps, { accountId: scope.accountId, leadId }, { via: 'dashboard' });
}
