import 'server-only';
import type { Db } from '@/server/db';
import { insertJob, publishJobs } from '@/server/jobs/outbox';
import type { JobRow } from '@/server/jobs/types';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import type { OwnerScope } from '@/server/services/auth/owner-scope';
import { leadProcessDedupeKey } from '@/server/services/leads/process';

// "This is a real lead" (D-42, PLAN §6.2, §7.5 lead detail, §9.6): the owner overrides a filtered
// lead's class. One transaction: `process_rev + 1`, `classification_override = 'lead'`,
// `processing_state = 'new'` (a compare-and-set on the lead still `filtered` at the revision read),
// and a new `lead_process` job keyed `lead:{id}:process:r{rev}`; published after commit. The job
// reuses the stored class, skips the filter (an overridden lead is always drafted), and then runs as
// any lead does: the daily cap, the draft, the `new_lead` email under `notify:{id}:initial:r{rev}`,
// the follow-ups. A second tap finds the lead no longer `filtered` and changes nothing, so the lead is
// processed once per override (the dedupe key would refuse a duplicate job anyway).
//
// Only a `filtered` lead (PLAN §6.2 "FILTERED (owner override → process_rev+1)"; §7.5 shows the button
// for filtered leads). Refused, changing nothing: not the owner's lead, not filtered, a test lead,
// dismissed, privacy-deleted, its content already purged (nothing to draft from), or the account not
// active (lead_process would only skip it, turning "Filtered" into "Not processed").

export type MarkRealLeadRefusal =
  | 'not_found'
  | 'not_filtered'
  | 'test_lead'
  | 'dismissed'
  | 'privacy_deleted'
  | 'content_gone'
  | 'account_not_active';

export type MarkRealLeadResult =
  | { readonly type: 'queued'; readonly processRev: number }
  | { readonly type: 'refused'; readonly reason: MarkRealLeadRefusal };

interface OverrideRow {
  processing_state: string;
  process_rev: number;
  is_test: boolean;
  dismissed_at: Date | null;
  stop_reason: string | null;
  has_content: boolean;
  account_state: string;
}

function refusalOf(row: OverrideRow): MarkRealLeadRefusal | null {
  if (row.is_test) return 'test_lead';
  if (row.stop_reason === 'privacy_deletion') return 'privacy_deleted';
  if (row.dismissed_at !== null) return 'dismissed';
  if (row.processing_state !== 'filtered') return 'not_filtered';
  if (!row.has_content) return 'content_gone';
  if (row.account_state !== 'active') return 'account_not_active';
  return null;
}

type InTx = { readonly type: 'queued'; readonly processRev: number; readonly job: JobRow | null } | { readonly type: 'refused'; readonly reason: MarkRealLeadRefusal };

async function overrideInTx(tx: Db, accountId: string, leadId: string, now: Date): Promise<InTx> {
  const row = await tx.maybeOne<OverrideRow>(
    `select l.processing_state, l.process_rev, l.is_test, l.dismissed_at, l.stop_reason,
            exists (select 1 from lead_messages m where m.lead_id = l.id) as has_content,
            a.processing_state as account_state
       from leads l join accounts a on a.id = l.account_id
      where l.id = $1 and l.account_id = $2`,
    [leadId, accountId],
  );
  if (row === null) return { type: 'refused', reason: 'not_found' };
  const refusal = refusalOf(row);
  if (refusal !== null) return { type: 'refused', reason: refusal };

  const updated = await tx.maybeOne<{ process_rev: number }>(
    `update leads set process_rev = process_rev + 1, classification_override = 'lead', processing_state = 'new'
      where id = $1 and account_id = $2 and process_rev = $3 and processing_state = 'filtered'
        and dismissed_at is null and not is_test
      returning process_rev`,
    [leadId, accountId, row.process_rev],
  );
  // Another tap won the compare-and-set first.
  if (updated === null) return { type: 'refused', reason: 'not_filtered' };
  const job = await insertJob(tx, {
    kind: 'lead_process',
    accountId,
    leadId,
    dedupeKey: leadProcessDedupeKey(leadId, updated.process_rev),
    payload: { processRev: updated.process_rev },
    runAt: now,
    now,
  });
  return { type: 'queued', processRev: updated.process_rev, job };
}

/** "This is a real lead" on one of the owner's filtered leads. */
export async function markRealLead(deps: Deps, scope: OwnerScope, leadId: string): Promise<MarkRealLeadResult> {
  const accountId = scope.accountId;
  const now = deps.clock.now();
  const outcome = await deps.db.tx((tx) => overrideInTx(tx, accountId, leadId, now));
  if (outcome.type === 'refused') {
    log.info('real-lead override refused', { event: 'lead.override_refused', accountId, leadId, reason: outcome.reason });
    return outcome;
  }
  await publishJobs(deps, [outcome.job]);
  log.info('lead marked real', { event: 'lead.override', accountId, leadId, count: outcome.processRev });
  return { type: 'queued', processRev: outcome.processRev };
}
