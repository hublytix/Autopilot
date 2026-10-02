import 'server-only';
import type { Deps } from '@/server/ports';
import type { OwnerScope } from '@/server/services/auth';
import { baselineView, ensureBaselineStarted, type BaselineView, type StartBaselineResult } from '@/server/services/baseline';
import { getOnboardingGate, type OnboardingGate } from '@/server/services/onboarding';

// /onboarding/baseline (PLAN §7.5): the page starts the baseline job when it has not run yet (the
// step needs a selected form and an active connection), then shows the job's status and the
// onboarding-complete gate that enables Finish. Starting is idempotent (one job per account and day).

export interface BaselinePageView {
  start: StartBaselineResult;
  baseline: BaselineView;
  gate: OnboardingGate;
}

export async function baselinePageView(scope: OwnerScope, deps: Deps): Promise<BaselinePageView> {
  const gateBefore = await getOnboardingGate(scope, deps);
  // After onboarding the dashboard owns the baseline: nothing is started from this page then.
  const start: StartBaselineResult = gateBefore.completedAt === null ? await ensureBaselineStarted(scope, deps) : 'already_started';
  return { start, baseline: await baselineView(deps.db, scope.accountId), gate: gateBefore };
}
