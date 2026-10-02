import 'server-only';
import { z } from 'zod';
import type { FollowUpNumber } from '@/server/domain/followup-schedule';
import type { Db } from '@/server/db';
import { insertAuditOnce } from '@/server/services/audit/audit-log';

// The lead-page note of a follow-up that could not be sent (PLAN §8.3 step 6: `followup` → a
// lead-page note, no email; D-15). A code in `audit_log` (ids and the stream only, law 4), one per
// lead, follow-up and stream however often the failure path runs. The follow-up number is part of the
// action code (`lead.followup1_failed`, `lead.followup2_failed`), so the meta keeps to the allow-listed
// `leadId` and `followupStream`. The M6 lead page reads them with loadFollowUpNotes and says it in
// plain words; the admin already had the `job_failed` alert with the error code.

export const FOLLOW_UP_FAILED_ACTIONS = {
  1: 'lead.followup1_failed',
  2: 'lead.followup2_failed',
} as const satisfies Readonly<Record<FollowUpNumber, string>>;

export interface FollowUpNoteInput {
  readonly accountId: string;
  readonly leadId: string;
  readonly n: FollowUpNumber;
  readonly followupStream: number;
}

/** Writes the note once; true when this call wrote it. */
export async function recordFollowUpFailedNote(db: Db, input: FollowUpNoteInput): Promise<boolean> {
  return insertAuditOnce(
    db,
    {
      accountId: input.accountId,
      actor: 'system',
      action: FOLLOW_UP_FAILED_ACTIONS[input.n],
      level: 'warn',
      meta: { leadId: input.leadId, followupStream: input.followupStream },
    },
    ['leadId', 'followupStream'],
  );
}

export interface FollowUpNote {
  /** The follow-up that was not sent. */
  readonly n: FollowUpNumber;
  readonly followupStream: number;
  /** When it was recorded (`audit_log.at`). */
  readonly at: Date;
}

const noteRow = z.object({ action: z.string(), followup_stream: z.coerce.number().int().nonnegative(), at: z.date() });

/** The lead's follow-up notes, oldest first (the M6 lead page; the caller scopes `accountId` to the owner). */
export async function loadFollowUpNotes(db: Db, input: { accountId: string; leadId: string }): Promise<FollowUpNote[]> {
  const rows = await db.query(
    `select action, meta ->> 'followupStream' as followup_stream, at from audit_log
      where account_id = $1 and action = any($2::text[]) and meta ->> 'leadId' = $3
      order by at, id`,
    [input.accountId, Object.values(FOLLOW_UP_FAILED_ACTIONS), input.leadId],
  );
  return rows.map((raw) => {
    const row = noteRow.parse(raw);
    return { n: row.action === FOLLOW_UP_FAILED_ACTIONS[2] ? 2 : 1, followupStream: row.followup_stream, at: row.at };
  });
}
