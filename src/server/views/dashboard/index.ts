import 'server-only';
import type { Deps } from '@/server/ports';
import type { OwnerScope } from '@/server/services/auth';
import { getOnboardingGate, type OnboardingGate } from '@/server/services/onboarding';

// The M3 /dashboard placeholder's read model (PLAN §7.5; M6 replaces the page with the real
// dashboard): whether setup is finished and the account's processing state.

export interface DashboardPlaceholderView {
  readonly gate: OnboardingGate;
}

export async function dashboardPlaceholderView(scope: OwnerScope, deps: Deps): Promise<DashboardPlaceholderView> {
  return { gate: await getOnboardingGate(scope, deps) };
}
