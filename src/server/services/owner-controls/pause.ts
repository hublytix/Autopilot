import 'server-only';
import type { AccountProcessingState } from '@/server/domain/types';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { applyProcessingStateInTx } from '@/server/services/accounts/apply-processing-state';
import { runPostCommitWork, type PostCommitWork } from '@/server/services/accounts/post-commit';
import { insertAuditOnce } from '@/server/services/audit/audit-log';
import type { OwnerScope } from '@/server/services/auth/owner-scope';

// Pause all / Resume (PLAN §6.1, §9.6, D-42, D-48). `accounts.paused_at` is the owner's intent;
// `processing_state` is always derived by applyProcessingState, in the same transaction, so a pause
// survives revoke, reconnect and billing changes, and Resume lands on whatever the other inputs say
// (active, or still revoked/inactive/onboarding). This is not a Razorpay pause.
//
// Pause cancels nothing (PLAN §6.1 "→ paused: cancel nothing"): while paused the poller skips the
// account, a lead_process job skips its lead, and every pending follow-up fails its stop check and its
// reservation predicate (account not active) and is skipped, never sent. Those follow-ups are not
// rescheduled on Resume. Resume → active moves every form's intake floor and cursor to $now (the
// transition's side effect), so leads that arrived while paused are never drafted; the dashboard
// says so (M6), reading the `account.resumed` audit entry for the pause it ended.
//
// Both are idempotent: pausing a paused account keeps the first `paused_at`, resuming an unpaused one
// changes nothing. Each writes one audit entry (`account.paused` / `account.resumed`, meta `pausedAt`).

export interface PauseResult {
  /** The derived state after the call. */
  readonly processingState: AccountProcessingState;
  /** False when the account was already paused (or, for resume, not paused). */
  readonly changed: boolean;
  /** The pause this call started (pause) or ended (resume); null when nothing changed. */
  readonly pausedAt: Date | null;
}

interface Outcome {
  readonly result: PauseResult;
  readonly work: PostCommitWork;
}

async function setPaused(deps: Deps, scope: OwnerScope, pause: boolean): Promise<PauseResult> {
  const accountId = scope.accountId;
  const now = deps.clock.now();
  const outcome = await deps.db.tx(async (tx): Promise<Outcome> => {
    // The update locks the account row first (the documented lock order: accounts, then connection).
    const row = pause
      ? await tx.maybeOne<{ paused_at: Date }>(`update accounts set paused_at = $2 where id = $1 and paused_at is null returning paused_at`, [accountId, now])
      : await tx.maybeOne<{ paused_at: Date }>(
          `update accounts a set paused_at = null from accounts old
            where a.id = $1 and old.id = a.id and a.paused_at is not null
            returning old.paused_at`,
          [accountId],
        );
    const applied = await applyProcessingStateInTx(tx, now, accountId);
    if (applied === null) throw new Error('owner_controls_account_missing');
    const pausedAt = row?.paused_at ?? null;
    if (pausedAt !== null) {
      await insertAuditOnce(
        tx,
        { accountId, actor: 'owner', action: pause ? 'account.paused' : 'account.resumed', level: 'info', meta: { pausedAt: pausedAt.toISOString() } },
        ['pausedAt'],
      );
    }
    return {
      result: { processingState: applied.next, changed: pausedAt !== null, pausedAt },
      work: applied.work,
    };
  });
  await runPostCommitWork(deps, outcome.work);
  if (outcome.result.changed) {
    log.info(pause ? 'account paused' : 'account resumed', {
      event: pause ? 'account.paused' : 'account.resumed',
      accountId,
      processingState: outcome.result.processingState,
    });
  }
  return outcome.result;
}

/** Pause all: sets `paused_at` (kept if already set), then applyProcessingState. Cancels nothing. */
export async function pauseAll(deps: Deps, scope: OwnerScope): Promise<PauseResult> {
  return setPaused(deps, scope, true);
}

/** Resume: clears `paused_at`, then applyProcessingState (→ active moves the intake floors to now). */
export async function resumeAll(deps: Deps, scope: OwnerScope): Promise<PauseResult> {
  return setPaused(deps, scope, false);
}
