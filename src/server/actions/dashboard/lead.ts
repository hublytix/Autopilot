'use server';
import 'server-only';
import { withServerActionInstrumentation } from '@sentry/nextjs';
import { redirect } from 'next/navigation';
import { requireOwnerAction } from '../auth/context';
import { runLeadControl, type LeadControl } from './controls';

// The lead page's controls (PLAN §7.5, §9.6, D-42): "This is a real lead" (filtered leads), "Resume
// follow-ups" (leads that replied) and "Not a real lead". Owner only (requireOwnerAction: a verified
// session, else /login); Server Actions carry Next's Origin check. Each form posts the lead id; the
// services read it together with the owner's account id, so another account's lead is not found.
// Then back to the lead page (post/redirect/get) with the outcome code. Sentry sees neither the form
// data nor the response.

async function run(name: string, control: LeadControl, formData: FormData): Promise<never> {
  const leadId = formData.get('lead_id');
  const path = await withServerActionInstrumentation(name, { recordResponse: false }, async () => {
    const { deps, scope } = await requireOwnerAction();
    return runLeadControl(deps, scope, control, leadId);
  });
  redirect(path);
}

export async function markRealLeadAction(formData: FormData): Promise<void> {
  await run('dashboard.real_lead', 'real_lead', formData);
}

export async function resumeFollowUpsAction(formData: FormData): Promise<void> {
  await run('dashboard.resume_followups', 'resume_followups', formData);
}

export async function notARealLeadAction(formData: FormData): Promise<void> {
  await run('dashboard.dismiss', 'dismiss', formData);
}
