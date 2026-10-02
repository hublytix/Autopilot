import 'server-only';
import { z } from 'zod';
import { ACCOUNT_PROCESSING_STATES, type AccountProcessingState } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { applyProcessingStateInTx, runPostCommitWork, type PostCommitWork } from '@/server/services/accounts';
import type { OwnerScope } from '@/server/services/auth';
import { insertAuditOnce } from '@/server/services/audit';

// The onboarding-complete gate (PLAN §6.1, §7.5 /onboarding/baseline, D-48). Finish needs all of:
// - an owner-saved brief (`brief_versions.source='owner'` with `booking_link_choice <> 'unset'`);
// - at least one selected form;
// - saved preferences (`preferences_saved_at`) with at least one notify address.
// The inbox check and the baseline may still be running. Finish sets `onboarding_completed_at` and
// calls applyProcessingState in the same transaction (→ `active`: every form's floor and cursor move
// to $now), then runs the transition's post-commit work.

export const ONBOARDING_REQUIREMENTS = ['brief', 'forms', 'preferences'] as const;
export type OnboardingRequirement = (typeof ONBOARDING_REQUIREMENTS)[number];

export interface OnboardingGate {
  /** Every requirement holds. */
  ready: boolean;
  /** What is still missing, in the order the owner fixes it. */
  missing: OnboardingRequirement[];
  completedAt: Date | null;
  processingState: AccountProcessingState;
  /** Saved notify addresses, none of which is confirmed yet (a warning: alerts wait for a confirmation). */
  noConfirmedNotifyAddress: boolean;
}

// One expression per requirement, over the account row `a`.
const REQUIREMENT_SQL: Readonly<Record<OnboardingRequirement, string>> = {
  brief: `exists (select 1 from brief_versions v where v.account_id = a.id and v.source = 'owner' and v.booking_link_choice <> 'unset')`,
  forms: `exists (select 1 from selected_forms f where f.account_id = a.id and f.selected)`,
  preferences: `exists (select 1 from settings s where s.account_id = a.id and s.preferences_saved_at is not null and cardinality(s.notify_emails) >= 1)`,
};

const gateRow = z.object({
  onboarding_completed_at: z.date().nullable(),
  processing_state: z.enum(ACCOUNT_PROCESSING_STATES),
  brief: z.boolean(),
  forms: z.boolean(),
  preferences: z.boolean(),
  confirmed: z.boolean(),
});

async function readGate(db: Db, accountId: string, lock: boolean): Promise<OnboardingGate | null> {
  const raw = await db.maybeOne(
    `select a.onboarding_completed_at, a.processing_state,
            ${REQUIREMENT_SQL.brief} as brief, ${REQUIREMENT_SQL.forms} as forms, ${REQUIREMENT_SQL.preferences} as preferences,
            exists (select 1 from settings s where s.account_id = a.id and cardinality(s.notify_emails_verified) >= 1) as confirmed
       from accounts a where a.id = $1
       ${lock ? 'for no key update' : ''}`,
    [accountId],
  );
  if (raw === null) return null;
  const row = gateRow.parse(raw);
  const missing = ONBOARDING_REQUIREMENTS.filter((requirement) => !row[requirement]);
  return {
    ready: missing.length === 0,
    missing,
    completedAt: row.onboarding_completed_at,
    processingState: row.processing_state,
    noConfirmedNotifyAddress: row.preferences && !row.confirmed,
  };
}

/** The gate for the owner's account. */
export async function getOnboardingGate(scope: OwnerScope, deps: Pick<Deps, 'db'>): Promise<OnboardingGate> {
  const gate = await readGate(deps.db, scope.accountId, false);
  if (gate === null) throw new Error('onboarding_account_missing');
  return gate;
}

export type CompleteOnboardingResult =
  | { ok: true; alreadyComplete: boolean; processingState: AccountProcessingState }
  | { ok: false; missing: OnboardingRequirement[] };

/**
 * Finish (PLAN §7.5): when the gate holds, sets `onboarding_completed_at = $now` and applies the
 * processing state in one transaction (the account row is locked first, so the gate and the write
 * see the same state). Calling it again after completion changes nothing.
 */
export async function completeOnboarding(scope: OwnerScope, deps: Deps): Promise<CompleteOnboardingResult> {
  const accountId = scope.accountId;
  const now = deps.clock.now();
  const outcome = await deps.db.tx(async (tx): Promise<{ result: CompleteOnboardingResult; work: PostCommitWork | null }> => {
    const gate = await readGate(tx, accountId, true);
    if (gate === null) throw new Error('onboarding_account_missing');
    if (gate.completedAt !== null) return { result: { ok: true, alreadyComplete: true, processingState: gate.processingState }, work: null };
    if (!gate.ready) return { result: { ok: false, missing: gate.missing }, work: null };
    await tx.query(`update accounts set onboarding_completed_at = $2 where id = $1 and onboarding_completed_at is null`, [accountId, now]);
    const applied = await applyProcessingStateInTx(tx, now, accountId);
    await insertAuditOnce(tx, { accountId, actor: 'owner', action: 'onboarding.completed', level: 'info', meta: {} }, []);
    return {
      result: { ok: true, alreadyComplete: false, processingState: applied?.next ?? gate.processingState },
      work: applied?.work ?? null,
    };
  });
  if (outcome.work !== null) await runPostCommitWork(deps, outcome.work);
  if (outcome.result.ok && !outcome.result.alreadyComplete) {
    log.info('onboarding completed', { event: 'onboarding.completed', accountId, processingState: outcome.result.processingState });
  }
  return outcome.result;
}
