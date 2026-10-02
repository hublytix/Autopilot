import 'server-only';
import { z } from 'zod';
import { FOLLOW_UP_NUMBERS, type FollowUpNumber } from '@/server/domain/followup-schedule';
import type { JobRow } from '@/server/jobs/types';

// Which follow-up a `followup` job is for (PLAN §8.2): the payload `{leadId, n, followupStream}`
// (+ `targetAt`) that the "notified" transaction and "Resume follow-ups" write, else the parts of
// its dedupe key `lead:{id}:fu:{n}:s{followup_stream}`. `n` is kept as scheduled: a number other
// than 1 or 2 is the `max_followups` stop (PLAN §6.2), not a malformed job.

export interface FollowUpRef {
  readonly leadId: string;
  readonly n: number;
  readonly followupStream: number;
}

const payloadSchema = z.object({
  leadId: z.uuid().optional(),
  n: z.number().int().optional(),
  followupStream: z.number().int().nonnegative().optional(),
});

const KEY = /^lead:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):fu:(\d{1,9}):s(\d{1,9})$/i;

/** The follow-up the job is for; null when neither the payload nor the key says. */
export function followUpRefOf(job: Pick<JobRow, 'leadId' | 'payload' | 'dedupeKey'>): FollowUpRef | null {
  const parsed = payloadSchema.safeParse(job.payload);
  const payload = parsed.success ? parsed.data : {};
  const key = KEY.exec(job.dedupeKey);
  const leadId = job.leadId ?? payload.leadId ?? key?.[1];
  const n = payload.n ?? (key?.[2] === undefined ? undefined : Number(key[2]));
  const followupStream = payload.followupStream ?? (key?.[3] === undefined ? undefined : Number(key[3]));
  if (leadId === undefined || n === undefined || followupStream === undefined) return null;
  return { leadId, n, followupStream };
}

/** `n` as a follow-up number, or null when the job asks for a third one (or more). */
export function asFollowUpNumber(n: number): FollowUpNumber | null {
  return FOLLOW_UP_NUMBERS.find((candidate) => candidate === n) ?? null;
}

/** `fu1` / `fu2` (the draft kind, and the follow-up's code in logs). */
export function followUpLabel(n: FollowUpNumber): 'fu1' | 'fu2' {
  return n === 1 ? 'fu1' : 'fu2';
}
