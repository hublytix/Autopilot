import 'server-only';
import { DateTime } from 'luxon';
import { FOLLOW_UP_DAYS } from '@/server/domain/followup-schedule';
import { isAllowed, shiftToAllowed, type QuietHoursSettings } from '@/server/domain/quiet-hours';
import type { Db } from '@/server/db';
import { targetAtOf } from '@/server/jobs/rows';
import { log } from '@/server/obs/log';
import { followUpDedupeKey } from './schedule';
import { quietHoursOf, type QuietHoursColumns } from './settings';

// What the follow-up job reads about its lead before any HubSpot call (PLAN §9.5 step 2, §8.5,
// D-33): the lead's current follow-up stream, the account's zone and its CURRENT quiet-hours
// settings (a job whose time the settings now forbid is re-targeted, never sent). Ids, times and
// settings only.

export interface FollowUpLead {
  readonly id: string;
  readonly accountId: string;
  readonly isTest: boolean;
  readonly followupStream: number;
  readonly fu1NotifiedAt: Date | null;
  readonly fu2NotifiedAt: Date | null;
  /** The zone the account's local times are read in: `accounts.timezone`, UTC when unknown or unusable. */
  readonly zone: string;
  readonly quietHours: QuietHoursSettings;
}

interface LeadRow extends QuietHoursColumns {
  id: string;
  account_id: string;
  is_test: boolean;
  followup_stream: number;
  fu1_notified_at: Date | null;
  fu2_notified_at: Date | null;
  timezone: string | null;
}

function usableZone(timezone: string | null, accountId: string, now: Date): string {
  if (timezone === null) return 'UTC';
  if (DateTime.fromJSDate(now, { zone: timezone }).isValid) return timezone;
  // As the "notified" rows and the daily cap do: the portal's local time is unknown, so UTC.
  log.warn('account timezone unusable for follow-ups: using UTC', { event: 'followup.zone_fallback', accountId });
  return 'UTC';
}

/** The job's lead with its account's settings; null when the lead is gone (or not in `accountId`). */
export async function loadFollowUpLead(db: Db, leadId: string, accountId: string | null, now: Date): Promise<FollowUpLead | null> {
  const row = await db.maybeOne<LeadRow>(
    `select l.id, l.account_id, l.is_test, l.followup_stream, l.fu1_notified_at, l.fu2_notified_at, a.timezone,
            s.quiet_start_hour, s.quiet_end_hour, s.skip_weekends
       from leads l
       join accounts a on a.id = l.account_id
       left join settings s on s.account_id = l.account_id
      where l.id = $1 and ($2::uuid is null or l.account_id = $2::uuid)`,
    [leadId, accountId],
  );
  if (row === null) return null;
  const quietHours = quietHoursOf(row);
  return {
    id: row.id,
    accountId: row.account_id,
    isTest: row.is_test,
    followupStream: row.followup_stream,
    fu1NotifiedAt: row.fu1_notified_at,
    fu2NotifiedAt: row.fu2_notified_at,
    zone: usableZone(row.timezone, row.account_id, now),
    quietHours,
  };
}

/** D-33 at fire time: null when a follow-up may go now; else the next allowed time (PLAN §8.3 step 5 re-target). */
export function quietHoursRetarget(lead: Pick<FollowUpLead, 'accountId' | 'zone' | 'quietHours'>, now: Date): Date | null {
  if (isAllowed(now, lead.quietHours, lead.zone)) return null;
  return shiftToAllowed(DateTime.fromJSDate(now, { zone: lead.zone }), lead.quietHours, lead.accountId).at;
}

/** How soon fu2 looks again while fu1 of its stream has not run (it may be about to). */
export const FU2_RECHECK_MS = 60 * 60 * 1000;

interface PendingJobRow {
  run_at: Date;
  payload: Record<string, unknown>;
}

/**
 * Follow-up 2 never overtakes follow-up 1 of its stream (M5's resume spacing, D-42/D-66 open point
 * (1)): while fu1's job is still scheduled or running, fu2 is re-targeted to fu1's target plus the
 * original gap (3 calendar days in the portal's zone), at least FU2_RECHECK_MS from now, shifted out
 * of quiet hours. Null when fu1's job has finished (sent, skipped, failed or cancelled).
 */
export async function fu2WaitsForFu1(
  db: Db,
  lead: Pick<FollowUpLead, 'id' | 'accountId' | 'zone' | 'quietHours'>,
  input: { followupStream: number; jobId: string; now: Date },
): Promise<Date | null> {
  const fu1 = await db.maybeOne<PendingJobRow>(
    `select run_at, payload from scheduled_jobs
      where lead_id = $1 and kind = 'followup' and dedupe_key = $2 and id <> $3 and status in ('scheduled', 'running')`,
    [lead.id, followUpDedupeKey(lead.id, 1, input.followupStream), input.jobId],
  );
  if (fu1 === null) return null;
  const fu1Target = targetAtOf(fu1) ?? fu1.run_at;
  const gapDays = FOLLOW_UP_DAYS[2] - FOLLOW_UP_DAYS[1];
  const afterGap = DateTime.fromJSDate(fu1Target, { zone: lead.zone }).plus({ days: gapDays });
  const recheck = DateTime.fromJSDate(new Date(input.now.getTime() + FU2_RECHECK_MS), { zone: lead.zone });
  const target = afterGap.toMillis() > recheck.toMillis() ? afterGap : recheck;
  return shiftToAllowed(target, lead.quietHours, lead.accountId).at;
}
