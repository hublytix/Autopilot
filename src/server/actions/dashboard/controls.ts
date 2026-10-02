import 'server-only';
import type { Deps } from '@/server/ports';
import type { OwnerScope } from '@/server/services/auth/owner-scope';
import { leadPagePath } from '@/server/services/leads/reply-detected-notification';
import { dismissLeadForOwner, markRealLead, pauseAll, resumeAll, resumeFollowUps } from '@/server/services/owner-controls';
import { parseLeadId } from '@/server/views/dashboard/leads';

// The bodies of the dashboard's Server Actions (PLAN §7.5, §9.6, D-42): the lead page's three
// controls and Pause all / Resume, each on the caller's OwnerScope (requireOwnerAction), returning
// where to send the browser next (post/redirect/get) with the outcome as a code in the query (never
// any content). A lead id that is not a uuid, or not a lead of the owner's account, changes nothing
// and goes back to the dashboard with `lead_not_found`. Kept out of the 'use server' modules so the
// tests call them with a test scope.

export const DASHBOARD_PATH = '/dashboard';
export { leadPagePath };

export type LeadControl = 'real_lead' | 'resume_followups' | 'dismiss';

/** Every `?result=` code the lead page can show (the page has the words). */
export const LEAD_RESULT_CODES = [
  'real_lead.queued',
  'real_lead.not_filtered',
  'real_lead.test_lead',
  'real_lead.dismissed',
  'real_lead.privacy_deleted',
  'real_lead.content_gone',
  'real_lead.account_not_active',
  'resume_followups.resumed',
  'resume_followups.resumed_none_left',
  'resume_followups.dismissed',
  'resume_followups.test_lead',
  'resume_followups.privacy_deleted',
  'resume_followups.not_notified',
  'resume_followups.not_replied',
  'resume_followups.stopped',
  'resume_followups.account_not_active',
  'resume_followups.followups_off',
  'resume_followups.unschedulable',
  'dismiss.dismissed',
  'dismiss.already_dismissed',
] as const;
export type LeadResultCode = (typeof LEAD_RESULT_CODES)[number];

/** Every `?result=` code /dashboard can show. */
export const DASHBOARD_RESULT_CODES = ['lead_not_found', 'paused', 'already_paused', 'resumed', 'resumed_not_active', 'not_paused'] as const;
export type DashboardResultCode = (typeof DASHBOARD_RESULT_CODES)[number];

const NOT_FOUND_PATH = `${DASHBOARD_PATH}?result=lead_not_found`;

function withResult(leadId: string, code: LeadResultCode): string {
  return `${leadPagePath(leadId)}?result=${code}`;
}

/** Runs one lead control for the owner; returns the path to redirect to. */
export async function runLeadControl(deps: Deps, scope: OwnerScope, control: LeadControl, leadIdInput: unknown): Promise<string> {
  const leadId = parseLeadId(leadIdInput);
  if (leadId === null) return NOT_FOUND_PATH;
  switch (control) {
    case 'real_lead': {
      const result = await markRealLead(deps, scope, leadId);
      if (result.type === 'queued') return withResult(leadId, 'real_lead.queued');
      return result.reason === 'not_found' ? NOT_FOUND_PATH : withResult(leadId, `real_lead.${result.reason}`);
    }
    case 'resume_followups': {
      const result = await resumeFollowUps(deps, scope, leadId);
      if (result.type === 'resumed') return withResult(leadId, result.scheduled.length > 0 ? 'resume_followups.resumed' : 'resume_followups.resumed_none_left');
      return result.reason === 'not_found' ? NOT_FOUND_PATH : withResult(leadId, `resume_followups.${result.reason}`);
    }
    case 'dismiss': {
      const result = await dismissLeadForOwner(deps, scope, leadId);
      if (result.type === 'dismissed' || result.type === 'already_dismissed') return withResult(leadId, `dismiss.${result.type}`);
      return NOT_FOUND_PATH;
    }
  }
}

/** Pause all / Resume (PLAN §6.1, §9.6) for the owner's account; returns the path to redirect to. */
export async function runPauseControl(deps: Deps, scope: OwnerScope, pause: boolean): Promise<string> {
  if (pause) {
    const result = await pauseAll(deps, scope);
    return `${DASHBOARD_PATH}?result=${result.changed ? 'paused' : 'already_paused'}`;
  }
  const result = await resumeAll(deps, scope);
  const code: DashboardResultCode = !result.changed ? 'not_paused' : result.processingState === 'active' ? 'resumed' : 'resumed_not_active';
  return `${DASHBOARD_PATH}?result=${code}`;
}
