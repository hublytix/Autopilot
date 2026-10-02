import 'server-only';
import type { Deps } from '@/server/ports';
import type { OwnerScope } from '@/server/services/auth';
import { listFormsForSelection, type FormsListResult } from '@/server/services/onboarding';

// /onboarding/forms's read side (PLAN §7.5, D-07): the portal's hubspot and flow forms with their
// starting ticks (newsletter-like forms unticked). Reads HubSpot through the portal client.

export type FormsPageView = FormsListResult;

export async function formsPageView(scope: OwnerScope, deps: Deps): Promise<FormsPageView> {
  return listFormsForSelection(scope, deps);
}
