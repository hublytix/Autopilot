// Simulation stage 5, Days 1–5 (PLAN §13 calendar, §15 M5, D-39), America/New_York, after Day 0:
//   day-1  Wed 10:00  the owner taps "Send from my email" on #5's new_lead email; HubSpot logs the
//                     send at 10:01 (23 h 30 m after the submission: the M6 report's third reply time)
//   day-2  Thu ≈10:00–10:36  follow-up 1 for #1 #2 #6 #5, each at its own T0 + 2 days (weekends
//                     allowed, 10:xx is never quiet: no shift); the job reads the contact first, so the
//                     owner's logged sends are confirmed (#1 Tue 10:13, #5 Wed 10:01, #6 Tue 10:41)
//                     and only #2's follow-up says "We couldn't confirm in HubSpot that your first
//                     reply was sent" (D-34); the owner logs everything, so no replies-not-logged note
//   day-3  Fri 14:00  #6 replies (INCOMING_EMAIL from #6's address, hs_timestamp Fri 14:00): nothing
//                     reads it and nothing is sent until a follow-up job comes due
//   day-5  Sun ≈10:00–10:36  follow-up 2 for #1 #2 #5; #6's fu2 job finds the reply → markReplied
//                     (replied_at = Fri 14:00) → reply_detected, follow-ups stopped, no job left
// After each step the statuses deriveLeadStatus gives (D-32) are checked. The daily 03:17 UTC ticks
// on Wed–Sun are recorded as no-ops until M7 (run.ts), the hourly due-checks until M6.
import { DateTime } from 'luxon';
import { FIRST_SEND_UNCONFIRMED_NOTE, REPLIES_NOT_LOGGED_NOTE, REPLIES_UNKNOWN_NOTE } from '@/emails/components/HonestNotes';
import { followUpSubject } from '@/emails/FollowUp';
import { replyDetectedSubject } from '@/emails/ReplyDetected';
import type { FakeSentMail } from '@/server/adapters/fake/mailer';
import type { LeadDisplayStatus } from '@/server/domain/types';
import { DAY0_NOTIFIED, DAY0_SUBMISSIONS, day0LeadId, day0Submission } from './day0-scenario';
import { ownerSends, tapSend, type Day0OwnerTap } from './day0-owner';
import { emailActionLinks } from './owner-browser';
import { shownLocal, statusOf } from './status';
import type { Simulation, Stage } from './types';

/** Day 1: the owner sends #5's reply from the new_lead email (PLAN §13 "logged at 10:01"). */
const DAY1_TAP: Day0OwnerTap = { n: 5, tapAt: '2026-10-07T10:00:00', sentAt: '2026-10-07T10:01:00' };
const DAY1_END = '2026-10-07T10:05:00';
const DAY2_END = '2026-10-08T10:45:00';
const REPLY_AT = '2026-10-09T14:00:00';
const DAY3_END = '2026-10-09T14:05:00';
const DAY5_END = '2026-10-11T10:45:00';

/** The lead who replies on Friday (#6). */
const REPLIER = 6;
/** The lead whose first reply is never logged in HubSpot (#2). */
const UNCONFIRMED = 2;
/** Follow-ups go out in T0 order: #1 10:00, #2 10:05, #6 10:20, #5 10:35 (the new_lead emails' times). */
const T0_ORDER = [1, 2, 6, 5] as const;
/** When HubSpot logged each owner send (`send_confirmed_at`, D-08: HubSpot's event time); #2: never. */
const CONFIRMED_SENDS: Readonly<Record<number, string | null>> = {
  1: '2026-10-06T10:13:00',
  2: null,
  5: '2026-10-07T10:01:00',
  6: '2026-10-06T10:41:00',
};

const STATUSES: Readonly<Record<'day1' | 'day2' | 'day3' | 'day5', Readonly<Record<number, LeadDisplayStatus>>>> = {
  // Nothing has read HubSpot since Tuesday: a tapped link is a click, never a confirmed send (law 3).
  day1: { 1: 'send_clicked', 2: 'send_clicked', 3: 'filtered', 4: 'filtered', 5: 'send_clicked', 6: 'send_clicked' },
  // The fu1 jobs confirmed #1 #5 #6 from HubSpot's logged EMAILs; #2 was never sent.
  day2: { 1: 'send_confirmed', 2: 'send_clicked', 3: 'filtered', 4: 'filtered', 5: 'send_confirmed', 6: 'send_confirmed' },
  // #6's reply is logged in HubSpot, but nothing has read it yet.
  day3: { 1: 'send_confirmed', 2: 'send_clicked', 3: 'filtered', 4: 'filtered', 5: 'send_confirmed', 6: 'send_confirmed' },
  // fu2 went out today for #1 #2 #5 (under 2 days ago: not "no reply" yet); #6 replied.
  day5: { 1: 'send_confirmed', 2: 'send_clicked', 3: 'filtered', 4: 'filtered', 5: 'send_confirmed', 6: 'replied' },
};

const DAY_MS = 24 * 60 * 60 * 1000;

function local(sim: Simulation, at: Date): DateTime {
  return DateTime.fromJSDate(at, { zone: sim.timeZone });
}

/** The scenario's lead ids by submission number (#1 → its id). */
async function leadIds(sim: Simulation): Promise<Map<number, string>> {
  const ids = new Map<number, string>();
  for (const submission of DAY0_SUBMISSIONS) {
    const id = await day0LeadId(sim, submission.n);
    if (id !== null) ids.set(submission.n, id);
  }
  return ids;
}

function refOf(ids: ReadonlyMap<number, string>, mail: FakeSentMail): string {
  for (const [n, id] of ids) if (mail.lead === id) return `L${n}`;
  return mail.lead === undefined ? 'none' : 'other';
}

function listed(ids: ReadonlyMap<number, string>, mails: readonly FakeSentMail[]): string {
  return mails.map((mail) => `${mail.kind}:${refOf(ids, mail)}`).join(', ') || 'none';
}

async function checkStatuses(sim: Simulation, step: keyof typeof STATUSES, ids: ReadonlyMap<number, string>): Promise<void> {
  const expected = STATUSES[step];
  const seen: string[] = [];
  let ok = true;
  for (const submission of DAY0_SUBMISSIONS) {
    const status = (await statusOf(sim, ids.get(submission.n) ?? null))?.status ?? 'missing';
    seen.push(`L${submission.n} ${status}`);
    if (status !== expected[submission.n]) ok = false;
  }
  sim.check(`${step}.statuses`, ok, seen.join(', '));
}

interface FollowUpLeadRow {
  first_notified_at: Date | null;
  fu1_notified_at: Date | null;
  fu2_notified_at: Date | null;
  send_confirmed_at: Date | null;
  replied_at: Date | null;
  stop_reason: string | null;
  followup_stream: number;
}

async function leadRow(sim: Simulation, leadId: string | undefined): Promise<FollowUpLeadRow | null> {
  if (leadId === undefined) return null;
  return sim.db.maybeOne<FollowUpLeadRow>(
    `select first_notified_at, fu1_notified_at, fu2_notified_at, send_confirmed_at, replied_at, stop_reason, followup_stream
       from public.leads where id = $1`,
    [leadId],
  );
}

interface FollowUpJobRow {
  seq: number;
  status: string;
  run_at: Date;
  cancel_reason: string | null;
}

async function followUpJobs(sim: Simulation, leadId: string | undefined): Promise<FollowUpJobRow[]> {
  if (leadId === undefined) return [];
  return sim.db.query<FollowUpJobRow>(`select seq, status, run_at, cancel_reason from public.scheduled_jobs where lead_id = $1 and kind = 'followup' order by seq`, [
    leadId,
  ]);
}

/**
 * One follow-up email per expected lead, in order, all of follow-up `n`: sent at the lead's T0 + n's
 * days (no quiet-hours shift, a few limiter seconds at most), the subject with the first name, to the
 * notify address with Reply-To = the owner, the three buttons, and D-34's notes as the sends call for.
 */
async function checkFollowUpEmails(
  sim: Simulation,
  step: 'day2' | 'day5',
  n: 1 | 2,
  mails: readonly FakeSentMail[],
  ids: ReadonlyMap<number, string>,
): Promise<void> {
  const ownerEmail = sim.scenario.ownerEmail;
  const followUps = mails.filter((mail) => mail.kind === 'follow_up');
  for (const leadN of T0_ORDER) {
    if (n === 2 && leadN === REPLIER) continue;
    const ref = `L${leadN}`;
    const leadId = ids.get(leadN);
    const mail = followUps.find((candidate) => candidate.lead === leadId);
    const count = followUps.filter((candidate) => candidate.lead === leadId).length;
    const row = await leadRow(sim, leadId);
    const t0 = row?.first_notified_at ?? null;
    const due = t0 === null ? null : local(sim, t0).plus({ days: n === 1 ? 2 : 5 });
    const sentAt = mail === undefined ? null : local(sim, mail.sentAt);
    const stamped = n === 1 ? row?.fu1_notified_at : row?.fu2_notified_at;
    const delayMs = sentAt === null || due === null ? null : sentAt.toMillis() - due.toMillis();
    sim.check(
      `${step}.${ref}.follow_up_${n}_at_t0_plus_${n === 1 ? 2 : 5}_days`,
      mail !== undefined &&
        count === 1 &&
        delayMs !== null &&
        delayMs >= 0 &&
        delayMs < 2 * 60 * 1000 &&
        sentAt?.toFormat('ccc') === (n === 1 ? 'Thu' : 'Sun') &&
        stamped?.getTime() === mail.sentAt.getTime(),
      `${count} email(s) at ${sentAt?.toFormat('ccc HH:mm:ss') ?? 'none'} (due ${due?.toFormat('ccc HH:mm:ss') ?? 'unknown'}), fu${n}_notified_at ${shownLocal(sim, stamped ?? null)}`,
    );
    if (mail === undefined) continue;
    const firstName = day0Submission(leadN).firstName;
    sim.check(`${step}.${ref}.follow_up_${n}_subject`, mail.subject === followUpSubject(n, firstName), mail.subject);
    const links = emailActionLinks(mail.text);
    sim.check(
      `${step}.${ref}.follow_up_${n}_to_the_owner_with_three_buttons`,
      ownerEmail !== null &&
        mail.to.join(',') === ownerEmail &&
        mail.replyTo === ownerEmail &&
        links.send !== null &&
        links.edit !== null &&
        links.dismiss !== null &&
        links.mailto === links.send &&
        new Set([links.send, links.edit, links.dismiss]).size === 3,
      `to ${mail.to.length} address(es), reply-to ${mail.replyTo === ownerEmail ? 'owner' : 'other'}, buttons ${[links.send, links.edit, links.dismiss].filter((link) => link !== null).length}`,
    );
    const unconfirmedNote = mail.text.includes(FIRST_SEND_UNCONFIRMED_NOTE);
    sim.check(
      leadN === UNCONFIRMED ? `${step}.${ref}.follow_up_${n}_says_the_first_reply_is_unconfirmed` : `${step}.${ref}.follow_up_${n}_has_no_unconfirmed_note`,
      unconfirmedNote === (leadN === UNCONFIRMED),
      `unconfirmed-send note ${unconfirmedNote ? 'present' : 'absent'}`,
    );
  }
  const loggingNotes = followUps.filter((mail) => mail.text.includes(REPLIES_NOT_LOGGED_NOTE) || mail.text.includes(REPLIES_UNKNOWN_NOTE));
  sim.check(`${step}.no_replies_not_logged_note`, followUps.length > 0 && loggingNotes.length === 0, `${loggingNotes.length} of ${followUps.length} with a logging note`);
}

/** One checked follow-up draft per emailed follow-up, on the draft model; AI calls only for those drafts. */
async function checkDrafts(sim: Simulation, step: 'day2' | 'day5', n: 1 | 2, ids: ReadonlyMap<number, string>, aiCallsBefore: number): Promise<void> {
  const kind = n === 1 ? 'fu1' : 'fu2';
  const expectedLeads = T0_ORDER.filter((leadN) => n === 1 || leadN !== REPLIER);
  const drafts = await sim.db.query<{ lead_id: string; validation_ok: boolean; needs_touch: boolean; model: string | null }>(
    `select lead_id, validation_ok, needs_touch, model from public.drafts where kind = $1`,
    [kind],
  );
  const draftModel = sim.deps.env.ANTHROPIC_MODEL_DRAFT;
  const ok =
    drafts.length === expectedLeads.length &&
    expectedLeads.every((leadN) => drafts.some((draft) => draft.lead_id === ids.get(leadN) && draft.validation_ok && !draft.needs_touch && draft.model === draftModel));
  sim.check(`${step}.one_checked_${kind}_draft_per_follow_up`, ok, `${drafts.length} ${kind} drafts for ${expectedLeads.length} follow-ups`);
  const calls = (await sim.db.query<{ purpose: string; model: string; outcome: string }>(`select purpose, model, outcome from public.ai_calls order by created_at, purpose`)).slice(
    aiCallsBefore,
  );
  sim.check(
    `${step}.one_followup_call_per_draft_on_the_draft_model`,
    calls.length === expectedLeads.length && calls.every((call) => call.purpose === 'followup' && call.model === draftModel && call.outcome === 'ok'),
    calls.map((call) => `${call.purpose}:${call.model}:${call.outcome}`).join(', ') || 'none',
  );
}

async function aiCallCount(sim: Simulation): Promise<number> {
  return (await sim.db.one<{ n: number }>('select count(*)::int as n from public.ai_calls')).n;
}

// ---------------------------------------------------------------------------------------------
// Day 1, Wed: the owner sends #5's reply
// ---------------------------------------------------------------------------------------------

async function runDay1(sim: Simulation): Promise<void> {
  const emailsBefore = sim.fakes.mailer.sent.length;
  sim.travel.at(sim.local(DAY1_TAP.tapAt), 'send tap #5', () => tapSend(sim, DAY1_TAP, 'day1'));
  if (DAY1_TAP.sentAt !== null) sim.travel.at(sim.local(DAY1_TAP.sentAt), 'owner sends #5', () => ownerSends(sim, DAY1_TAP, 'day1'));
  await sim.travel.advanceTo(sim.local(DAY1_END));

  const ids = await leadIds(sim);
  const lead = await sim.db.maybeOne<{ first_send_clicked_at: Date | null }>('select first_send_clicked_at from public.leads where id = $1', [ids.get(5) ?? null]);
  sim.check(
    'day1.L5.send_click_recorded_at_the_tap',
    lead?.first_send_clicked_at?.getTime() === sim.local(DAY1_TAP.tapAt).getTime(),
    `first_send_clicked_at ${shownLocal(sim, lead?.first_send_clicked_at ?? null)}`,
  );
  const sent = sim.fakes.mailer.sent.slice(emailsBefore);
  sim.check('day1.no_emails', sent.length === 0, listed(ids, sent));
  await checkStatuses(sim, 'day1', ids);
}

// ---------------------------------------------------------------------------------------------
// Day 2, Thu: follow-up 1 ×4
// ---------------------------------------------------------------------------------------------

async function runDay2(sim: Simulation): Promise<void> {
  const emailsBefore = sim.fakes.mailer.sent.length;
  const aiCallsBefore = await aiCallCount(sim);
  await sim.travel.advanceTo(sim.local(DAY2_END));

  const ids = await leadIds(sim);
  const sent = sim.fakes.mailer.sent.slice(emailsBefore);
  sim.check(
    'day2.four_follow_up_1_emails_in_t0_order',
    sent.length === T0_ORDER.length && sent.every((mail) => mail.kind === 'follow_up') && sent.map((mail) => refOf(ids, mail)).join(',') === T0_ORDER.map((n) => `L${n}`).join(','),
    listed(ids, sent),
  );
  await checkFollowUpEmails(sim, 'day2', 1, sent, ids);
  await checkDrafts(sim, 'day2', 1, ids, aiCallsBefore);

  // D-08: the job read each contact before drafting; send_confirmed_at is HubSpot's own send time.
  const confirmed: string[] = [];
  let ok = true;
  for (const n of DAY0_NOTIFIED) {
    const row = await leadRow(sim, ids.get(n));
    const expected = CONFIRMED_SENDS[n] ?? null;
    const actual = row?.send_confirmed_at ?? null;
    confirmed.push(`L${n} ${shownLocal(sim, actual)}`);
    if ((expected === null ? null : sim.local(expected).getTime()) !== (actual?.getTime() ?? null)) ok = false;
  }
  sim.check('day2.send_confirmed_at_from_hubspot', ok, confirmed.join(', '));

  // Follow-up 1 done, follow-up 2 still waiting for Sunday (the same local time, T0 + 5 days).
  const waiting: string[] = [];
  let jobsOk = true;
  for (const n of DAY0_NOTIFIED) {
    const jobs = await followUpJobs(sim, ids.get(n));
    const row = await leadRow(sim, ids.get(n));
    const t0 = row?.first_notified_at ?? null;
    const fu2Due = t0 === null ? null : local(sim, t0).plus({ days: 5 }).toMillis();
    waiting.push(`L${n} ${jobs.map((job) => `fu${job.seq} ${job.status}`).join('/')}`);
    if (!(jobs.length === 2 && jobs[0]?.status === 'done' && jobs[1]?.status === 'scheduled' && jobs[1].run_at.getTime() === fu2Due)) jobsOk = false;
  }
  sim.check('day2.fu1_done_and_fu2_scheduled_for_sunday', jobsOk, waiting.join(', '));
  await checkStatuses(sim, 'day2', ids);
}

// ---------------------------------------------------------------------------------------------
// Day 3, Fri: #6 replies
// ---------------------------------------------------------------------------------------------

async function leadReplies(sim: Simulation): Promise<void> {
  const logged = sim.fakes.hubspot.logLeadReply({ from: day0Submission(REPLIER).email, at: sim.clock.now() });
  sim.check(`day3.L${REPLIER}.reply_logged_in_hubspot`, logged !== null, logged === null ? 'not logged' : 'logged');
  sim.record('step', 'lead.replied_in_hubspot', { lead: `L${REPLIER}`, loggedInHubSpot: logged !== null });
}

async function runDay3(sim: Simulation): Promise<void> {
  const emailsBefore = sim.fakes.mailer.sent.length;
  sim.travel.at(sim.local(REPLY_AT), `reply from #${REPLIER}`, () => leadReplies(sim));
  await sim.travel.advanceTo(sim.local(DAY3_END));

  const ids = await leadIds(sim);
  const sent = sim.fakes.mailer.sent.slice(emailsBefore);
  sim.check('day3.nothing_sent', sent.length === 0, listed(ids, sent));
  // Only a follow-up job (or M6's refresh) reads the contact: the reply waits for Sunday's fu2 job.
  const row = await leadRow(sim, ids.get(REPLIER));
  sim.check(`day3.L${REPLIER}.reply_not_read_yet`, row !== null && row.replied_at === null && row.stop_reason === null, `replied_at ${shownLocal(sim, row?.replied_at ?? null)}`);
  await checkStatuses(sim, 'day3', ids);
}

// ---------------------------------------------------------------------------------------------
// Day 5, Sun: follow-up 2 ×3 and reply_detected ×1
// ---------------------------------------------------------------------------------------------

async function runDay5(sim: Simulation): Promise<void> {
  const emailsBefore = sim.fakes.mailer.sent.length;
  const aiCallsBefore = await aiCallCount(sim);
  await sim.travel.advanceTo(sim.local(DAY5_END));

  const ids = await leadIds(sim);
  const sent = sim.fakes.mailer.sent.slice(emailsBefore);
  const expected = T0_ORDER.map((n) => `${n === REPLIER ? 'reply_detected' : 'follow_up'}:L${n}`).join(', ');
  sim.check('day5.three_follow_up_2_emails_and_one_reply_detected', listed(ids, sent) === expected, listed(ids, sent));
  await checkFollowUpEmails(sim, 'day5', 2, sent, ids);
  await checkDrafts(sim, 'day5', 2, ids, aiCallsBefore);

  // #6: the fu2 job read the reply (D-08: replied_at is HubSpot's time), stopped and said so.
  const replierId = ids.get(REPLIER);
  const replier = await leadRow(sim, replierId);
  const replyMail = sent.find((mail) => mail.kind === 'reply_detected');
  const allReplyDetected = sim.fakes.mailer.sent.filter((mail) => mail.kind === 'reply_detected');
  sim.check(
    `day5.L${REPLIER}.replied_at_is_the_reply_time`,
    replier?.replied_at?.getTime() === sim.local(REPLY_AT).getTime() && replier.stop_reason === 'replied',
    `replied_at ${shownLocal(sim, replier?.replied_at ?? null)}, stop_reason ${replier?.stop_reason ?? 'null'}`,
  );
  const fu2Due = replier === null || replier.first_notified_at === null ? null : local(sim, replier.first_notified_at).plus({ days: 5 }).toMillis();
  sim.check(
    `day5.L${REPLIER}.reply_detected_by_the_fu2_job`,
    replyMail !== undefined &&
      fu2Due !== null &&
      replyMail.sentAt.getTime() - fu2Due >= 0 &&
      replyMail.sentAt.getTime() - fu2Due < 2 * 60 * 1000 &&
      replyMail.subject === replyDetectedSubject(day0Submission(REPLIER).firstName) &&
      replyMail.to.join(',') === sim.scenario.ownerEmail &&
      emailActionLinks(replyMail.text).send === null,
    replyMail === undefined ? 'no reply_detected email' : `${local(sim, replyMail.sentAt).toFormat('ccc HH:mm:ss')}: ${replyMail.subject}`,
  );
  sim.check(
    'day5.reply_detected_only_for_the_replier',
    allReplyDetected.length === 1 && allReplyDetected[0]?.lead === replierId,
    `${allReplyDetected.length} reply_detected: ${listed(ids, allReplyDetected)}`,
  );
  const replierJobs = await followUpJobs(sim, replierId);
  const replierDraft = await sim.db.one<{ n: number }>(`select count(*)::int as n from public.drafts where lead_id = $1 and kind = 'fu2'`, [replierId ?? null]);
  const pendingForReplier = await sim.db.one<{ n: number }>(`select count(*)::int as n from public.scheduled_jobs where lead_id = $1 and status in ('scheduled', 'running')`, [
    replierId ?? null,
  ]);
  sim.check(
    `day5.L${REPLIER}.follow_ups_stopped_no_further_jobs`,
    replierJobs.map((job) => job.status).join(',') === 'done,done' && pendingForReplier.n === 0 && replier?.fu2_notified_at === null && replierDraft.n === 0,
    `jobs ${replierJobs.map((job) => `fu${job.seq} ${job.status}`).join(', ')}, pending ${pendingForReplier.n}, fu2 drafts ${replierDraft.n}`,
  );

  // The others got both follow-ups and keep their confirmed send times (LEAST: never moved later).
  for (const n of DAY0_NOTIFIED.filter((candidate) => candidate !== REPLIER)) {
    const row = await leadRow(sim, ids.get(n));
    const jobs = await followUpJobs(sim, ids.get(n));
    const expectedConfirm = CONFIRMED_SENDS[n] ?? null;
    sim.check(
      `day5.L${n}.both_follow_ups_sent_no_stop`,
      row !== null &&
        row.fu1_notified_at !== null &&
        row.fu2_notified_at !== null &&
        row.replied_at === null &&
        row.stop_reason === null &&
        (row.send_confirmed_at?.getTime() ?? null) === (expectedConfirm === null ? null : sim.local(expectedConfirm).getTime()) &&
        jobs.map((job) => job.status).join(',') === 'done,done',
      `fu1 ${shownLocal(sim, row?.fu1_notified_at ?? null)}, fu2 ${shownLocal(sim, row?.fu2_notified_at ?? null)}, stop ${row?.stop_reason ?? 'null'}, jobs ${jobs.map((job) => job.status).join('/')}`,
    );
  }

  // PLAN §13: every scheduled_jobs row ends done, cancelled or skipped; nothing is left in QStash.
  const unfinished = await sim.db.query<{ kind: string; status: string }>(
    `select kind, status from public.scheduled_jobs where status not in ('done', 'cancelled', 'skipped') order by kind, status`,
  );
  sim.check('day5.every_job_done_cancelled_or_skipped', unfinished.length === 0, unfinished.map((row) => `${row.kind}:${row.status}`).join(', ') || 'all finished');
  const pending = sim.fakes.scheduler.pending();
  sim.check('day5.no_pending_deliveries', pending.length === 0, `${pending.length} queued`);

  // PLAN §13 expected outbox so far: pre-run 2, Day 0 4, Day 2 4, Day 5 4.
  const kinds = sim.fakes.mailer.sent.map((mail) => mail.kind);
  const expectedKinds = [
    'magic_link',
    'inbox_test',
    ...DAY0_NOTIFIED.map(() => 'new_lead'),
    ...T0_ORDER.map(() => 'follow_up'),
    ...T0_ORDER.map((n) => (n === REPLIER ? 'reply_detected' : 'follow_up')),
  ];
  sim.check('day5.outbox_is_14_emails_2_4_4_4', kinds.join(',') === expectedKinds.join(','), `${kinds.length}: ${kinds.join(', ')}`);
  const fromSunday = sim.fakes.mailer.sent.filter((mail) => mail.sentAt.getTime() >= sim.local(DAY5_END).getTime() - DAY_MS);
  sim.check('day5.all_four_sent_on_sunday', fromSunday.length === 4 && fromSunday.every((mail) => local(sim, mail.sentAt).toFormat('ccc') === 'Sun'), listed(ids, fromSunday));
  await checkStatuses(sim, 'day5', ids);
}

export const FOLLOW_UP_STAGES: readonly Stage[] = [
  { id: 'day-1', milestone: 'M5', run: runDay1 },
  { id: 'day-2', milestone: 'M5', run: runDay2 },
  { id: 'day-3', milestone: 'M5', run: runDay3 },
  { id: 'day-5', milestone: 'M5', run: runDay5 },
];
