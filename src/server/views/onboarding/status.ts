import 'server-only';
import { z } from 'zod';
import { INBOX_CHECK_STATUSES, INBOX_LEG_STATUSES, type BaselineStatus, type BriefJobStatus, type InboxCheckStatus, type InboxLegStatus } from '@/server/domain/types';
import type { Deps } from '@/server/ports';
import type { OwnerScope } from '@/server/services/auth';
import { baselineView } from '@/server/services/baseline';
import { latestBriefJob } from '@/server/services/brief';
import { getOnboardingGate, type OnboardingRequirement } from '@/server/services/onboarding';

// GET /api/onboarding/status (PLAN §7.3): what the onboarding pages poll while background work runs.
// Reads the database only (the HubSpot reads happen in the inbox_check and baseline jobs): the newest
// brief job, the newest inbox check's legs, the baseline's state and the onboarding gate. Statuses,
// codes and counts only: no brief content, addresses or lead data.

export interface OnboardingStatusDto {
  brief: { status: BriefJobStatus | 'none'; errorCode: string | null };
  inboxCheck: { status: InboxCheckStatus | 'none'; sendLeg: InboxLegStatus | null; replyLeg: InboxLegStatus | null };
  baseline: { state: 'not_started' | 'running' | 'done'; status: BaselineStatus | null };
  gate: { ready: boolean; missing: OnboardingRequirement[]; completed: boolean };
}

const inboxRow = z.object({ status: z.enum(INBOX_CHECK_STATUSES), send_leg: z.enum(INBOX_LEG_STATUSES), reply_leg: z.enum(INBOX_LEG_STATUSES) });

export async function onboardingStatus(scope: OwnerScope, deps: Pick<Deps, 'db'>): Promise<OnboardingStatusDto> {
  const job = await latestBriefJob(deps.db, scope.accountId);
  const inboxRaw = await deps.db.maybeOne(
    `select status, send_leg, reply_leg from inbox_checks where account_id = $1 order by created_at desc, id desc limit 1`,
    [scope.accountId],
  );
  const inbox = inboxRaw === null ? null : inboxRow.parse(inboxRaw);
  const baseline = await baselineView(deps.db, scope.accountId);
  const gate = await getOnboardingGate(scope, deps);
  return {
    brief: job === null ? { status: 'none', errorCode: null } : { status: job.status, errorCode: job.errorCode },
    inboxCheck: inbox === null ? { status: 'none', sendLeg: null, replyLeg: null } : { status: inbox.status, sendLeg: inbox.send_leg, replyLeg: inbox.reply_leg },
    baseline: { state: baseline.state, status: baseline.state === 'done' ? baseline.baseline.status : null },
    gate: { ready: gate.ready, missing: gate.missing, completed: gate.completedAt !== null },
  };
}
