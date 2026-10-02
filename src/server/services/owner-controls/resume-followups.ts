import 'server-only';
import { errorCode } from '@/server/domain/errors';
import { FOLLOW_UP_NUMBERS, resumeTargets, type FollowUpNumber, type FollowUpTarget } from '@/server/domain/followup-schedule';
import type { Db } from '@/server/db';
import { raiseAlert } from '@/server/jobs/alert';
import { cancelJobsInTx, cancelScheduledMessages, type CancelledJobs } from '@/server/jobs/cancel';
import { insertJob, publishJobs } from '@/server/jobs/outbox';
import type { JobRow } from '@/server/jobs/types';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { insertAuditOnce } from '@/server/services/audit/audit-log';
import type { OwnerScope } from '@/server/services/auth/owner-scope';
import { followUpDedupeKey } from '@/server/services/followups/schedule';
import { inPortalZone, quietHoursOf, type QuietHoursColumns } from '@/server/services/followups/settings';

// "Resume follow-ups" (D-42, PLAN §9.6), e.g. after an out-of-office auto-reply, in one transaction:
// - the old `replied_at` is written to `audit_log` (`lead.followups_resumed`, meta leadId, repliedAt,
//   followupStream: ids and the timestamp only);
// - `replied_at = NULL`; `stop_reason = NULL` if it was `replied`;
// - `replies_ignored_before = $now` (D-08: only a reply after it counts); `followup_stream + 1`;
// - a `followup` job for each follow-up not yet sent, keyed `lead:{id}:fu:{n}:s{new stream}`
//   (payload {leadId, n, followupStream} + targetAt, seq n, as the "notified" transaction writes
//   them), at domain/followup-schedule.ts' resumeTargets: D-42's shiftToAllowed(max(T0 + n days,
//   now + 1 h)) for the earliest, and at least 3 days after follow-up 1 for fu2 (M5's spacing rule,
//   D-72), whether follow-up 1 is rescheduled now, already sent, or still being sent (D-73).
// The jobs are published after commit. A later real reply is recorded normally (D-08) and stops them.
//
// "Not yet sent": `fu{n}_notified_at` is null and no follow-up n email of an earlier stream is still
// reserved (`sending`): the sweeper finishes that one (its predicates pass again once `replied_at` is
// cleared), through Resend's idempotency key, so the owner never gets follow-up n twice. Any
// follow-up job of the old stream still pending (markReplied cancels them in its own transaction, so
// none should be) is cancelled, as the reply should have done.
//
// Refused, changing nothing: a lead that is not in the owner's account, dismissed, a test lead,
// privacy-deleted, never emailed (no T0), not replied, or stopped for another reason (opted out,
// bounced, contact deleted, superseded, account inactive at a follow-up, follow-ups off when
// notified: a reason Resume does not clear, which would only make the new jobs skip); the account
// not active (paused, revoked, …); follow-ups switched off in the settings (switch them on first);
// a schedule that cannot be computed (alerted).

export type ResumeFollowUpsRefusal =
  | 'not_found'
  | 'dismissed'
  | 'test_lead'
  | 'privacy_deleted'
  | 'not_notified'
  | 'not_replied'
  | 'stopped'
  | 'account_not_active'
  | 'followups_off'
  | 'unschedulable';

export type ResumeFollowUpsResult =
  | {
      readonly type: 'resumed';
      readonly followupStream: number;
      /** The follow-ups rescheduled, in order (none when both were already sent). */
      readonly scheduled: readonly { readonly n: FollowUpNumber; readonly runAt: Date }[];
    }
  | { readonly type: 'refused'; readonly reason: ResumeFollowUpsRefusal };

interface ResumeRow extends QuietHoursColumns {
  is_test: boolean;
  dismissed_at: Date | null;
  stop_reason: string | null;
  replied_at: Date | null;
  first_notified_at: Date | null;
  fu1_notified_at: Date | null;
  fu2_notified_at: Date | null;
  followup_stream: number;
  account_state: string;
  timezone: string | null;
  followups_enabled: boolean | null;
}

const IN_FLIGHT_KEY = /^notify:[^:]+:fu([12]):s\d+$/;

function refusalOf(row: ResumeRow): ResumeFollowUpsRefusal | null {
  if (row.is_test) return 'test_lead';
  if (row.stop_reason === 'privacy_deletion') return 'privacy_deleted';
  if (row.dismissed_at !== null) return 'dismissed';
  if (row.first_notified_at === null) return 'not_notified';
  if (row.replied_at === null && row.stop_reason !== 'replied') return 'not_replied';
  if (row.stop_reason !== null && row.stop_reason !== 'replied') return 'stopped';
  if (row.account_state !== 'active') return 'account_not_active';
  if (row.followups_enabled !== true) return 'followups_off';
  return null;
}

interface SentFollowUps {
  readonly sent: FollowUpNumber[];
  /** When each reached the owner (`fu{n}_notified_at`), or was first reserved while its email is still being sent. */
  readonly sentAt: Partial<Record<FollowUpNumber, Date>>;
}

/** Follow-ups already sent, or whose email of an earlier stream is still being sent (the sweeper finishes it). */
async function sentFollowUps(tx: Db, leadId: string, row: ResumeRow): Promise<SentFollowUps> {
  const inFlight = await tx.query<{ dedupe_key: string; first_reserved_at: Date }>(
    `select dedupe_key, first_reserved_at from notifications_sent
      where lead_id = $1 and status = 'sending' and kind in ('follow_up', 'needs_touch')`,
    [leadId],
  );
  const sentAt: Partial<Record<FollowUpNumber, Date>> = {};
  for (const r of inFlight) {
    const n = Number(IN_FLIGHT_KEY.exec(r.dedupe_key)?.[1] ?? 0);
    if (n !== 1 && n !== 2) continue;
    const known = sentAt[n];
    if (known === undefined || r.first_reserved_at.getTime() > known.getTime()) sentAt[n] = r.first_reserved_at;
  }
  for (const n of FOLLOW_UP_NUMBERS) {
    const notifiedAt = n === 1 ? row.fu1_notified_at : row.fu2_notified_at;
    if (notifiedAt !== null) sentAt[n] = notifiedAt;
  }
  return { sent: FOLLOW_UP_NUMBERS.filter((n) => sentAt[n] !== undefined), sentAt };
}

function targetsFor(row: ResumeRow, accountId: string, now: Date, done: SentFollowUps): FollowUpTarget[] {
  const firstNotifiedAt = row.first_notified_at;
  if (firstNotifiedAt === null) return [];
  const settings = quietHoursOf(row);
  return inPortalZone(row.timezone, accountId, (zone) => resumeTargets(firstNotifiedAt, now, done.sent, settings, zone, accountId, done.sentAt));
}

type InTx =
  | { readonly type: 'resumed'; readonly followupStream: number; readonly jobs: readonly (JobRow | null)[]; readonly targets: readonly FollowUpTarget[]; readonly cancelled: CancelledJobs }
  | { readonly type: 'refused'; readonly reason: ResumeFollowUpsRefusal; readonly errorCode?: string | undefined };

async function resumeInTx(tx: Db, accountId: string, leadId: string, now: Date): Promise<InTx> {
  const row = await tx.maybeOne<ResumeRow>(
    `select l.is_test, l.dismissed_at, l.stop_reason, l.replied_at, l.first_notified_at, l.fu1_notified_at, l.fu2_notified_at,
            l.followup_stream, a.processing_state as account_state, a.timezone,
            s.followups_enabled, s.quiet_start_hour, s.quiet_end_hour, s.skip_weekends
       from leads l
       join accounts a on a.id = l.account_id
       left join settings s on s.account_id = l.account_id
      where l.id = $1 and l.account_id = $2
      for no key update of l`,
    [leadId, accountId],
  );
  if (row === null) return { type: 'refused', reason: 'not_found' };
  const refusal = refusalOf(row);
  if (refusal !== null) return { type: 'refused', reason: refusal };

  const sent = await sentFollowUps(tx, leadId, row);
  let targets: FollowUpTarget[];
  try {
    targets = targetsFor(row, accountId, now, sent);
  } catch (error) {
    return { type: 'refused', reason: 'unschedulable', errorCode: errorCode(error) };
  }

  // Compare-and-set on the stream read above (the row is also locked), so a racing resume or reply
  // in between makes this one change nothing.
  const updated = await tx.maybeOne<{ followup_stream: number }>(
    `update leads
        set replied_at = null,
            stop_reason = case when stop_reason = 'replied' then null else stop_reason end,
            replies_ignored_before = $4,
            followup_stream = followup_stream + 1
      where id = $1 and account_id = $2 and followup_stream = $3 and dismissed_at is null
        and (replied_at is not null or stop_reason = 'replied')
      returning followup_stream`,
    [leadId, accountId, row.followup_stream, now],
  );
  if (updated === null) return { type: 'refused', reason: 'not_replied' };
  const stream = updated.followup_stream;

  await insertAuditOnce(
    tx,
    {
      accountId,
      actor: 'owner',
      action: 'lead.followups_resumed',
      level: 'info',
      meta: { leadId, repliedAt: row.replied_at?.toISOString() ?? null, followupStream: stream },
    },
    ['leadId', 'followupStream'],
  );
  const cancelled = await cancelJobsInTx(tx, { leadId, accountId, kinds: ['followup'], reason: 'replied', now });
  const jobs: (JobRow | null)[] = [];
  for (const target of targets) {
    jobs.push(
      await insertJob(tx, {
        kind: 'followup',
        accountId,
        leadId,
        dedupeKey: followUpDedupeKey(leadId, target.n, stream),
        payload: { leadId, n: target.n, followupStream: stream },
        runAt: target.runAt,
        now,
        seq: target.n,
      }),
    );
  }
  return { type: 'resumed', followupStream: stream, jobs, targets, cancelled };
}

/** "Resume follow-ups" on one of the owner's leads (D-42). */
export async function resumeFollowUps(deps: Deps, scope: OwnerScope, leadId: string): Promise<ResumeFollowUpsResult> {
  const accountId = scope.accountId;
  const now = deps.clock.now();
  const outcome = await deps.db.tx((tx) => resumeInTx(tx, accountId, leadId, now));
  if (outcome.type === 'refused') {
    if (outcome.reason === 'unschedulable') raiseAlert('followup_schedule_failed', { accountId, leadId, errorCode: outcome.errorCode });
    log.info('follow-ups not resumed', { event: 'lead.followups_resume_refused', accountId, leadId, reason: outcome.reason });
    return { type: 'refused', reason: outcome.reason };
  }
  await cancelScheduledMessages(deps, outcome.cancelled);
  await publishJobs(deps, outcome.jobs);
  log.info('follow-ups resumed', { event: 'lead.followups_resumed', accountId, leadId, count: outcome.targets.length });
  return {
    type: 'resumed',
    followupStream: outcome.followupStream,
    scheduled: outcome.targets.map((target) => ({ n: target.n, runAt: target.runAt })),
  };
}
