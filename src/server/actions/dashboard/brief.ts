'use server';
import 'server-only';
import { withServerActionInstrumentation } from '@sentry/nextjs';
import { redirect } from 'next/navigation';
import { saveOwnerBrief } from '@/server/services/brief';
import { requireOwnerAction } from '../auth/context';
import { briefInputFromValues, parseBriefForm } from '../onboarding/parse';
import type { BriefFormState } from '../onboarding/types';

// /dashboard/brief (PLAN §7.5): the onboarding editor's form, saved the same way (a `brief_versions`
// row with source 'owner', which drafts use from then on), then back to the page (PRG) with
// `?saved=1`. An invalid form keeps the owner's input (useActionState). Sentry sees neither the
// form data nor the response.

const DASHBOARD_BRIEF_PATH = '/dashboard/brief';

export async function saveDashboardBriefAction(_previous: BriefFormState, formData: FormData): Promise<BriefFormState> {
  const values = parseBriefForm(formData);
  const result = await withServerActionInstrumentation('dashboard.brief_save', { recordResponse: false }, async () => {
    const { deps, scope } = await requireOwnerAction();
    return saveOwnerBrief(scope, deps, briefInputFromValues(values));
  });
  if (!result.ok) return { issues: result.issues, values };
  redirect(`${DASHBOARD_BRIEF_PATH}?saved=${result.version.version}`);
}
