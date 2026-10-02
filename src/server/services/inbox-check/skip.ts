import 'server-only';
import type { Deps } from '@/server/ports';
import type { OwnerScope } from '@/server/services/auth/owner-scope';
import { clearExpiredTestAddresses, closeAbandonedInboxChecks, closeOpenChecksInTx } from './repository';

// "Skip for now" (PLAN §9.7 step 6, D-14): every open check closed with its open legs `skipped`,
// and `logging_mode = 'unknown'` (the dashboard reminds the owner) only when that closed a check:
// a check that finished between the page render and the tap keeps its measured mode (law 3: a
// confirmed result is never thrown away). The checks are closed before the account row is touched,
// the job's own order (legs, then the mode), so the two never wait on each other. A run of the job that arrives
// afterwards finds the check closed and ends without calling HubSpot; an inbox_test email still
// waiting to be sent fails its predicate (the check must be open).
// "Continue — we'll keep checking" changes nothing: the job keeps running and the result lands on
// the dashboard.

export interface SkipInboxCheckResult {
  readonly closed: number;
  /** Onboarding is already complete (a re-run from the dashboard): the owner goes back there. */
  readonly onboardingComplete: boolean;
}

export async function skipInboxCheck(scope: OwnerScope, deps: Deps): Promise<SkipInboxCheckResult> {
  const now = deps.clock.now();
  return deps.db.tx(async (tx) => {
    const closed = await closeOpenChecksInTx(tx, scope.accountId, now);
    const account = await tx.maybeOne<{ onboarding_completed_at: Date | null }>(
      `update accounts set logging_mode = case when $2::int > 0 then 'unknown' else logging_mode end
        where id = $1 returning onboarding_completed_at`,
      [scope.accountId, closed],
    );
    return { closed, onboardingComplete: account !== null && account.onboarding_completed_at !== null };
  });
}

export interface InboxCheckRetentionSummary {
  readonly inboxChecksClosed: number;
  readonly testAddressesCleared: number;
}

/**
 * PLAN §9.10 step 4 for inbox checks (D-49): checks still without deadlines 24 h after creation are
 * closed with their legs skipped, and test addresses older than 24 h are cleared (the HMAC stays
 * for the intake skip). For M7's retention guard and daily cron.
 */
export async function runInboxCheckRetention(deps: Pick<Deps, 'db' | 'clock'>): Promise<InboxCheckRetentionSummary> {
  const now = deps.clock.now();
  const inboxChecksClosed = await closeAbandonedInboxChecks(deps.db, now);
  const testAddressesCleared = await clearExpiredTestAddresses(deps.db, now);
  return { inboxChecksClosed, testAddressesCleared };
}
