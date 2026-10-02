'use server';
import 'server-only';
import { withServerActionInstrumentation } from '@sentry/nextjs';
import { redirect } from 'next/navigation';
import { completeOnboarding } from '@/server/services/onboarding';
import { requireOwnerAction } from '../auth/context';

// Finish on /onboarding/baseline (PLAN §6.1, §7.5): completes onboarding when the gate holds
// (→ active), otherwise back to the step, which lists what is missing.

const BASELINE_PATH = '/onboarding/baseline';
const DASHBOARD_PATH = '/dashboard';

export async function finishOnboardingAction(): Promise<void> {
  const result = await withServerActionInstrumentation('onboarding.finish', { recordResponse: false }, async () => {
    const { deps, scope } = await requireOwnerAction();
    return completeOnboarding(scope, deps);
  });
  redirect(result.ok ? DASHBOARD_PATH : `${BASELINE_PATH}?error=not_ready`);
}
