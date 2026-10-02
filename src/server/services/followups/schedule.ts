import 'server-only';
import { errorCode } from '@/server/domain/errors';
import { followUpTargets, type FollowUpNumber, type FollowUpTarget } from '@/server/domain/followup-schedule';
import { STREAM_ENDED_STOP } from '@/server/domain/stops';
import type { Db } from '@/server/db';
import { insertJob } from '@/server/jobs/outbox';
import { raiseAlert } from '@/server/jobs/alert';
import type { JobRow } from '@/server/jobs/types';
import { log } from '@/server/obs/log';
import { inPortalZone, quietHoursOf, type QuietHoursColumns } from './settings';

// The two follow-up job rows of the "notified" transaction (brief §5.6, PLAN §8.2, §8.5, §9.3 step 6,
// D-14, D-33). Called inside the transaction that marks the lead's first email sent, with
// T0 = `first_notified_at`: follow-up n runs at shiftToAllowed(T0 + n's days in the portal's zone),
// key `lead:{id}:fu:{n}:s{followup_stream}`, payload ids + `targetAt` (insertJob adds it; a target
// beyond the QStash maximum delay hops). The rows are published after commit by the caller.
//
// No rows when:
// - the lead is a test lead (D-14: test leads never get follow-ups);
// - follow-ups are off in the settings: the lead's `stop_reason` becomes `followups_off`, so it can
//   reach "No reply from lead (none logged)" (D-32) even if follow-ups are switched on later;
// - the lead is already stopped (dismissed, privacy deletion, …) by the time its email was sent.
// The follow-up handler itself (stops, signals, drafts) is M5's.

export type FollowUpScheduleResult =
  | { readonly type: 'scheduled'; readonly targets: readonly FollowUpTarget[]; readonly jobs: readonly (JobRow | null)[] }
  | { readonly type: 'test_lead' }
  | { readonly type: 'followups_off' }
  | { readonly type: 'stopped' }
  | { readonly type: 'lead_missing' }
  /** The targets could not be computed (the admin was alerted); no rows, and the stream's end stored (max_followups). */
  | { readonly type: 'unschedulable' };

/** PLAN §8.2's key (without the env prefix) for follow-up `n` of the lead's `followupStream`. */
export function followUpDedupeKey(leadId: string, n: FollowUpNumber, followupStream: number): string {
  return `lead:${leadId}:fu:${n}:s${followupStream}`;
}

export interface ScheduleFollowUpsInput {
  readonly accountId: string;
  readonly leadId: string;
  /** T0: the lead's `first_notified_at`. */
  readonly firstNotifiedAt: Date;
  /** `$now`. */
  readonly now: Date;
}

interface ScheduleRow extends QuietHoursColumns {
  is_test: boolean;
  followup_stream: number;
  stop_reason: string | null;
  dismissed_at: Date | null;
  timezone: string | null;
  followups_enabled: boolean | null;
}

/**
 * Inserts the lead's two follow-up job rows inside `tx` (the "notified" transaction), or records why
 * there are none. Never throws for a schedule it cannot compute: that is alerted and the email's
 * `sent` transaction still commits.
 */
export async function scheduleFollowUpsInTx(tx: Db, input: ScheduleFollowUpsInput): Promise<FollowUpScheduleResult> {
  const row = await tx.maybeOne<ScheduleRow>(
    `select l.is_test, l.followup_stream, l.stop_reason, l.dismissed_at, a.timezone,
            s.followups_enabled, s.quiet_start_hour, s.quiet_end_hour, s.skip_weekends
       from leads l
       join accounts a on a.id = l.account_id
       left join settings s on s.account_id = l.account_id
      where l.id = $1 and l.account_id = $2`,
    [input.leadId, input.accountId],
  );
  if (row === null) return { type: 'lead_missing' };
  if (row.is_test) return { type: 'test_lead' };
  if (row.dismissed_at !== null || row.stop_reason !== null) return { type: 'stopped' };
  if (row.followups_enabled === false) {
    await tx.query(`update leads set stop_reason = 'followups_off' where id = $1 and account_id = $2 and stop_reason is null`, [
      input.leadId,
      input.accountId,
    ]);
    return { type: 'followups_off' };
  }

  const settings = quietHoursOf(row);
  let targets: readonly FollowUpTarget[];
  try {
    targets = inPortalZone(row.timezone, input.accountId, (zone) => followUpTargets(input.firstNotifiedAt, settings, zone, input.accountId));
  } catch (error) {
    // No follow-up will come: the stream's end is recorded now (as a job that ends without its email
    // does, D-70), so the lead can still read "No reply from lead" instead of "follow-ups pending"
    // forever (D-73). Inside the "notified" transaction, which still commits.
    await tx.query(`update leads set stop_reason = $3 where id = $1 and account_id = $2 and stop_reason is null and not is_test`, [
      input.leadId,
      input.accountId,
      STREAM_ENDED_STOP,
    ]);
    raiseAlert('followup_schedule_failed', { accountId: input.accountId, leadId: input.leadId, errorCode: errorCode(error) });
    return { type: 'unschedulable' };
  }

  const jobs: (JobRow | null)[] = [];
  for (const target of targets) {
    jobs.push(
      await insertJob(tx, {
        kind: 'followup',
        accountId: input.accountId,
        leadId: input.leadId,
        dedupeKey: followUpDedupeKey(input.leadId, target.n, row.followup_stream),
        payload: { leadId: input.leadId, n: target.n, followupStream: row.followup_stream },
        runAt: target.runAt,
        now: input.now,
        seq: target.n,
      }),
    );
  }
  log.info('follow-ups scheduled', {
    event: 'followup.scheduled',
    accountId: input.accountId,
    leadId: input.leadId,
    count: jobs.filter((job) => job !== null).length,
  });
  return { type: 'scheduled', targets, jobs };
}

