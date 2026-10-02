'use server';
import 'server-only';
import { withServerActionInstrumentation } from '@sentry/nextjs';
import { redirect } from 'next/navigation';
import { requestBriefGeneration, saveOwnerBrief } from '@/server/services/brief';
import { requireOwnerAction } from '../auth/context';
import { briefInputFromValues, formText, parseBriefForm } from './parse';
import type { BriefFormState, GenerateBriefFormState } from './types';

// /onboarding/brief (PLAN §7.5, §9.7): start a generation from the website address, and save the
// owner's brief (a `brief_versions` row with source 'owner'). Sentry sees neither the form data nor
// the response.

const BRIEF_PATH = '/onboarding/brief';
const NEXT_PATH = '/onboarding/forms';

export async function generateBriefAction(_previous: GenerateBriefFormState, formData: FormData): Promise<GenerateBriefFormState> {
  const websiteUrl = formText(formData, 'website_url').slice(0, 2048);
  const result = await withServerActionInstrumentation('onboarding.brief_generate', { recordResponse: false }, async () => {
    const { deps, scope } = await requireOwnerAction();
    return requestBriefGeneration(scope, deps, { websiteUrl });
  });
  if (!result.ok) return { error: result.reason, websiteUrl };
  redirect(BRIEF_PATH);
}

export async function saveBriefAction(_previous: BriefFormState, formData: FormData): Promise<BriefFormState> {
  const values = parseBriefForm(formData);
  const result = await withServerActionInstrumentation('onboarding.brief_save', { recordResponse: false }, async () => {
    const { deps, scope } = await requireOwnerAction();
    return saveOwnerBrief(scope, deps, briefInputFromValues(values));
  });
  if (!result.ok) return { issues: result.issues, values };
  redirect(NEXT_PATH);
}
