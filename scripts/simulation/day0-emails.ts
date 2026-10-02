// Simulation stage 4, Day 0's emails and action links (PLAN §13 Day 0 row, §15 M4, D-26, D-50),
// Tue 2026-10-06 America/New_York, after the Day 0 stage (intake, drafts, emails, the owner's taps):
//   10:42  the owner opens "Edit first" on #1's email (GET), changes the reply and submits it
//          (POST): a 200 result with a Gmail compose link built from the edited text; nothing of
//          the edited text is stored or logged
//   10:43  the owner opens "Not a real lead" on #1's email (GET only: the confirmation page; no
//          scenario lead is ever dismissed), and dismisses the onboarding test lead from the inbox
//          check email (GET, POST, a second POST changes nothing)
//   10:44  every new_lead email's links are opened once more without counting (HEAD on the send
//          links, the edit and dismiss pages' GET): each token resolves
//   10:45  checks: exactly 4 new_lead emails (after the 2 pre-run ones), subjects with first names,
//          to the notify address with Reply-To = the owner, the three buttons + the mailto link;
//          clicks on #1 #2 #6 and not #5; 2 follow-up rows per notified lead (Thu and Sun, at the
//          email's local time: weekends allowed, 10:00 is never quiet); no email for #3 and #4;
//          the statuses deriveLeadStatus gives at 10:45.
import { DateTime } from 'luxon';
import { newLeadSubject } from '@/server/domain/subject';
import type { LeadDisplayStatus } from '@/server/domain/types';
import { dismissPageState, editPageState, handleSendLink, submitDismissForm, submitEditForm } from '@/server/http/action-links';
import { DAY0_NOTIFIED, DAY0_SUBMISSIONS, day0LeadId, day0Submission } from './day0-scenario';
import { DAY0_OWNER_TAPS, newLeadEmailOf } from './day0-owner';
import { DESKTOP_UA, emailActionLinks, OWNER_IP } from './owner-browser';
import { shownLocal, statusOf } from './status';
import type { Simulation } from './types';

/** When the stage's checks run (statuses "as of 10:45"). */
export const DAY0_EMAILS_END = '2026-10-06T10:45:00';
const EDIT_AT = '2026-10-06T10:42:00';
const DISMISS_AT = '2026-10-06T10:43:00';
const PROBE_AT = '2026-10-06T10:44:00';

/** The lead whose edit and dismiss links the owner opens. */
const EDITED_LEAD = 1;
/** A sentence only the edited reply has: it must reach the compose link and nowhere else. */
const EDIT_MARKER = 'I can be there Thursday morning at half past eight.';

/** What the owner sees on 10:45 (D-32 codes). */
const EXPECTED_STATUS: Readonly<Record<number, LeadDisplayStatus>> = {
  1: 'send_clicked',
  2: 'send_clicked',
  3: 'filtered',
  4: 'filtered',
  5: 'drafted',
  6: 'send_clicked',
};

const BUTTON_LABELS = ['Send from my email', 'Edit first', 'Not a real lead', 'Open in default mail app'] as const;

function ownerHeaders(sim: Simulation, post: boolean): Headers {
  const headers = new Headers({ 'user-agent': DESKTOP_UA, 'x-real-ip': OWNER_IP });
  if (post) {
    headers.set('origin', new URL(sim.deps.env.APP_URL).origin);
    headers.set('sec-fetch-site', 'same-origin');
  }
  return headers;
}

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(entries)) data.append(name, value);
  return data;
}

/** Runs `fn` with the log lines it writes copied aside (the logger writes to console.log/error). */
async function withLogLines<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const { log: originalLog, error: originalError } = console;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
    originalLog(...args);
  };
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
    originalError(...args);
  };
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function tokenUses(sim: Simulation, leadId: string | null): Promise<Record<string, number>> {
  if (leadId === null) return {};
  const rows = await sim.db.query<{ purpose: string; use_count: number }>('select purpose, use_count from public.action_tokens where lead_id = $1', [leadId]);
  return Object.fromEntries(rows.map((row) => [row.purpose, row.use_count]));
}

/** Every table (the app's and the fake schema's) with a row whose text contains `needle`. */
async function tablesContaining(sim: Simulation, needle: string): Promise<string[]> {
  const tables = await sim.db.query<{ table_schema: string; table_name: string }>(
    `select table_schema, table_name from information_schema.tables
      where table_schema in ('public', 'fake') and table_type = 'BASE TABLE' order by table_schema, table_name`,
  );
  const hits: string[] = [];
  for (const { table_schema: schema, table_name: table } of tables) {
    const found = await sim.db.query(`select 1 from "${schema}"."${table}" t where t::text like $1 limit 1`, [`%${needle}%`]);
    if (found.length > 0) hits.push(`${schema}.${table}`);
  }
  return hits;
}

// ---------------------------------------------------------------------------------------------
// 10:42 "Edit first" on #1
// ---------------------------------------------------------------------------------------------

async function editReply(sim: Simulation): Promise<void> {
  const { deps } = sim;
  const ref = `L${EDITED_LEAD}`;
  const leadId = await day0LeadId(sim, EDITED_LEAD);
  const mail = await newLeadEmailOf(sim, EDITED_LEAD);
  const token = mail === undefined ? null : emailActionLinks(mail.text).edit;
  if (leadId === null || token === null) {
    sim.check(`day0.${ref}.edit_link_present`, false, 'no edit link');
    return;
  }
  const draft = await sim.db.one<{ subject: string | null; body: string | null }>(`select subject, body from public.drafts where lead_id = $1 and kind = 'initial'`, [leadId]);
  const settings = await sim.db.one<{ bcc_address: string | null }>('select s.bcc_address from public.settings s join public.leads l on l.account_id = s.account_id where l.id = $1', [leadId]);
  const before = await tokenUses(sim, leadId);

  const page = await editPageState(deps, token, ownerHeaders(sim, false));
  const view = page.type === 'edit' ? page.view : null;
  const afterGet = await tokenUses(sim, leadId);
  sim.check(
    `day0.${ref}.edit_page_shows_the_draft_and_records_nothing`,
    view !== null &&
      view.subject === draft.subject &&
      view.body === draft.body &&
      view.recipient === day0Submission(EDITED_LEAD).email &&
      view.recipientValid &&
      view.bcc === settings.bcc_address &&
      view.leadMessage !== null &&
      afterGet.edit === before.edit,
    view === null ? `page ${page.type}` : `edit uses ${before.edit ?? 0} → ${afterGet.edit ?? 0}`,
  );
  if (view === null) return;

  // The owner adds a sentence and shortens the subject, then taps "Use this reply".
  const subject = 'Your shut-off valve quote';
  const body = view.body.replace(/\n\nThanks,/u, `\n\n${EDIT_MARKER}\n\nThanks,`);
  const { result, lines } = await withLogLines(() => submitEditForm(deps, token, { headers: ownerHeaders(sim, true), formData: form({ subject, body }) }));
  const reply = result.type === 'ready' ? result.reply : null;
  const sendUrl = reply?.sendUrl ?? '';
  sim.check(
    `day0.${ref}.edit_post_answers_a_gmail_link_built_from_the_edited_text`,
    reply !== null &&
      body.includes(EDIT_MARKER) &&
      sendUrl.startsWith('https://mail.google.com/') &&
      sendUrl.includes(encodeURIComponent(EDIT_MARKER)) &&
      sendUrl.includes(encodeURIComponent(subject)) &&
      reply.sendTarget === 'Gmail' &&
      reply.mailtoUrl?.startsWith('mailto:') === true &&
      reply.hints.length === 0,
    reply === null ? `result ${result.type}` : `target ${reply.sendTarget ?? 'none'}, hints ${reply.hints.map((hint) => hint.code).join(', ') || 'none'}`,
  );

  const stored = await tablesContaining(sim, EDIT_MARKER);
  const draftAfter = await sim.db.one<{ subject: string | null; body: string | null }>(`select subject, body from public.drafts where lead_id = $1 and kind = 'initial'`, [leadId]);
  const logged = lines.some((line) => line.includes(EDIT_MARKER) || line.includes(token));
  sim.check(
    `day0.${ref}.edited_text_neither_stored_nor_logged`,
    stored.length === 0 && draftAfter.subject === draft.subject && draftAfter.body === draft.body && !logged && lines.some((line) => line.includes('action_link.edit')),
    `tables ${stored.join(', ') || 'none'}, draft unchanged ${String(draftAfter.body === draft.body)}, logged ${String(logged)}`,
  );
  // The POST is the owner's action (D-26): it counts on the edit token; the first click (10:12) stays.
  const afterPost = await tokenUses(sim, leadId);
  sim.check(`day0.${ref}.edit_post_counts_on_the_edit_token`, afterPost.edit === (before.edit ?? 0) + 1, `edit uses ${afterPost.edit ?? 0}`);
  sim.record('step', 'new_lead.edited_by_owner', { lead: ref, result: result.type, target: reply?.sendTarget ?? null, hints: reply?.hints.length ?? null });
}

// ---------------------------------------------------------------------------------------------
// 10:43 "Not a real lead": opened on #1 (never confirmed), confirmed on the test lead
// ---------------------------------------------------------------------------------------------

interface DismissState {
  dismissed_at: Date | null;
  stop_reason: string | null;
  use_count: number | null;
  scheduled: number;
}

async function dismissStateOf(sim: Simulation, leadId: string): Promise<DismissState> {
  return sim.db.one<DismissState>(
    `select l.dismissed_at, l.stop_reason,
            (select t.use_count from public.action_tokens t where t.lead_id = l.id and t.purpose = 'dismiss') as use_count,
            (select count(*)::int from public.scheduled_jobs j where j.lead_id = l.id and j.status = 'scheduled') as scheduled
       from public.leads l where l.id = $1`,
    [leadId],
  );
}

async function openDismiss(sim: Simulation): Promise<void> {
  const { deps } = sim;
  const ref = `L${EDITED_LEAD}`;
  const leadId = await day0LeadId(sim, EDITED_LEAD);
  const mail = await newLeadEmailOf(sim, EDITED_LEAD);
  const token = mail === undefined ? null : emailActionLinks(mail.text).dismiss;
  if (leadId === null || token === null) {
    sim.check(`day0.${ref}.dismiss_link_present`, false, 'no dismiss link');
    return;
  }
  const before = await dismissStateOf(sim, leadId);
  const page = await dismissPageState(deps, token, ownerHeaders(sim, false));
  const after = await dismissStateOf(sim, leadId);
  sim.check(
    `day0.${ref}.dismiss_page_asks_and_changes_nothing`,
    page.type === 'confirm' && after.dismissed_at === null && after.stop_reason === null && after.use_count === 0 && after.scheduled === before.scheduled && after.scheduled === 2,
    `page ${page.type}, dismissed ${String(after.dismissed_at !== null)}, uses ${after.use_count ?? 'none'}, follow-ups ${after.scheduled}`,
  );
  sim.record('step', 'new_lead.dismiss_page_opened', { lead: ref, page: page.type });

  // The inbox check's test lead: "'Not a real lead' only marks this test lead" (the email says so).
  const testMail = sim.fakes.mailer.sent.find((sent) => sent.kind === 'inbox_test');
  const testToken = testMail === undefined ? null : emailActionLinks(testMail.text).dismiss;
  const test = await sim.db.maybeOne<{ id: string }>('select id from public.leads where is_test');
  if (testToken === null || test === null) {
    sim.check('day0.test_lead_dismiss_link_present', false, 'no inbox_test dismiss link');
    return;
  }
  const confirm = await dismissPageState(deps, testToken, ownerHeaders(sim, false));
  const first = await submitDismissForm(deps, testToken, ownerHeaders(sim, true));
  const second = await submitDismissForm(deps, testToken, ownerHeaders(sim, true));
  const done = await dismissPageState(deps, testToken, ownerHeaders(sim, false));
  const state = await dismissStateOf(sim, test.id);
  sim.check(
    'day0.test_lead_dismissed_once_from_the_inbox_test_email',
    confirm.type === 'confirm' &&
      first === 'dismissed' &&
      second === 'unchanged' &&
      done.type === 'dismissed' &&
      state.dismissed_at?.getTime() === sim.clock.nowMs() &&
      state.stop_reason === 'test_lead' &&
      state.use_count === 1,
    `pages ${confirm.type} → ${done.type}, posts ${first}, ${second}, stop_reason ${state.stop_reason ?? 'null'}, uses ${state.use_count ?? 'none'}`,
  );
  sim.record('step', 'inbox_test.dismissed_by_owner', { first, second });
}

// ---------------------------------------------------------------------------------------------
// 10:44 every link resolves (without counting)
// ---------------------------------------------------------------------------------------------

interface ProbeResult {
  readonly n: number;
  readonly ok: boolean;
  readonly detail: string;
}

async function probeLinks(sim: Simulation, probes: ProbeResult[]): Promise<void> {
  const { deps } = sim;
  for (const n of DAY0_NOTIFIED) {
    const mail = await newLeadEmailOf(sim, n);
    const links = mail === undefined ? null : emailActionLinks(mail.text);
    if (links === null || links.send === null || links.edit === null || links.dismiss === null || links.mailto === null) {
      probes.push({ n, ok: false, detail: 'links missing' });
      continue;
    }
    // HEAD never counts as a click (D-26) and the two GET pages record nothing.
    const head = (token: string, query: string) =>
      handleSendLink(
        new Request(`${deps.env.APP_URL}/a/${token}/send${query}`, { method: 'HEAD', headers: { 'user-agent': DESKTOP_UA, 'x-real-ip': OWNER_IP } }),
        deps,
        token,
      );
    const send = await head(links.send, '');
    const mailto = await head(links.mailto, '?via=mailto');
    const edit = await editPageState(deps, links.edit, ownerHeaders(sim, false));
    const dismiss = await dismissPageState(deps, links.dismiss, ownerHeaders(sim, false));
    const location = send.headers.get('location');
    const sendHost = location === null ? null : new URL(location).host;
    const ok =
      links.mailto === links.send && send.status === 302 && sendHost === 'mail.google.com' && mailto.status === 200 && edit.type === 'edit' && dismiss.type === 'confirm';
    probes.push({ n, ok, detail: `send ${send.status}, mailto ${mailto.status}, edit ${edit.type}, dismiss ${dismiss.type}` });
  }
  sim.record('step', 'new_lead.links_probed', { emails: probes.length, resolved: probes.filter((probe) => probe.ok).length });
}

// ---------------------------------------------------------------------------------------------
// 10:45 checks
// ---------------------------------------------------------------------------------------------

async function checkEmails(sim: Simulation, probes: readonly ProbeResult[]): Promise<void> {
  const sent = sim.fakes.mailer.sent;
  const ownerEmail = sim.scenario.ownerEmail;
  const kinds = sent.map((mail) => mail.kind);
  sim.check(
    'day0.outbox_is_the_2_pre_run_emails_then_4_new_lead',
    kinds.join(',') === `magic_link,inbox_test,${DAY0_NOTIFIED.map(() => 'new_lead').join(',')}`,
    kinds.join(', '),
  );

  for (const n of DAY0_NOTIFIED) {
    const ref = `L${n}`;
    const submission = day0Submission(n);
    const mail = await newLeadEmailOf(sim, n);
    const count = sent.filter((candidate) => candidate.kind === 'new_lead' && candidate.lead === mail?.lead).length;
    sim.check(`day0.${ref}.one_new_lead_email`, mail !== undefined && count === 1, `${count} new_lead emails`);
    if (mail === undefined) continue;
    sim.check(
      `day0.${ref}.subject_uses_the_first_name`,
      mail.subject === newLeadSubject(submission.firstName) && mail.subject.includes(submission.firstName),
      mail.subject,
    );
    sim.check(
      `day0.${ref}.to_the_notify_address_reply_to_the_owner`,
      ownerEmail !== null && mail.to.join(',') === ownerEmail && mail.replyTo === ownerEmail,
      `to ${mail.to.length} address(es), reply-to ${mail.replyTo === ownerEmail ? 'owner' : 'other'}`,
    );
    const links = emailActionLinks(mail.text);
    const htmlLinks = emailActionLinks(mail.html);
    const labelsInHtml = BUTTON_LABELS.filter((label) => mail.html.includes(label));
    sim.check(
      `day0.${ref}.three_buttons_and_the_mailto_link`,
      links.send !== null &&
        links.edit !== null &&
        links.dismiss !== null &&
        links.mailto === links.send &&
        htmlLinks.send === links.send &&
        htmlLinks.edit === links.edit &&
        htmlLinks.dismiss === links.dismiss &&
        htmlLinks.mailto === links.send &&
        labelsInHtml.length === BUTTON_LABELS.length &&
        new Set([links.send, links.edit, links.dismiss]).size === 3,
      `labels ${labelsInHtml.length}/${BUTTON_LABELS.length}`,
    );
    const probe = probes.find((candidate) => candidate.n === n);
    sim.check(`day0.${ref}.links_resolve`, probe?.ok === true, probe?.detail ?? 'not probed');
  }

  for (const submission of DAY0_SUBMISSIONS.filter((candidate) => !(DAY0_NOTIFIED as readonly number[]).includes(candidate.n))) {
    const leadId = await day0LeadId(sim, submission.n);
    const emails = sent.filter((mail) => leadId !== null && mail.lead === leadId).length;
    const drafts = leadId === null ? 0 : (await sim.db.one<{ n: number }>('select count(*)::int as n from public.drafts where lead_id = $1', [leadId])).n;
    sim.check(`day0.L${submission.n}.filtered_no_email_no_draft`, leadId !== null && emails === 0 && drafts === 0, `${emails} emails, ${drafts} drafts`);
  }
}

async function checkDrafts(sim: Simulation): Promise<void> {
  const draftModel = sim.deps.env.ANTHROPIC_MODEL_DRAFT;
  for (const n of DAY0_NOTIFIED) {
    const leadId = await day0LeadId(sim, n);
    const drafts =
      leadId === null
        ? []
        : await sim.db.query<{ kind: string; validation_ok: boolean; needs_touch: boolean; model: string | null; has_text: boolean }>(
            `select kind, validation_ok, needs_touch, model, (subject is not null and body is not null) as has_text from public.drafts where lead_id = $1`,
            [leadId],
          );
    const draft = drafts[0];
    sim.check(
      `day0.L${n}.one_checked_initial_draft`,
      drafts.length === 1 && draft?.kind === 'initial' && draft.validation_ok && !draft.needs_touch && draft.model === draftModel && draft.has_text,
      draft === undefined ? 'no draft' : `${drafts.length} drafts: ${draft.kind}, ok ${String(draft.validation_ok)}, needs touch ${String(draft.needs_touch)}`,
    );
  }
}

async function checkClicks(sim: Simulation): Promise<void> {
  for (const n of DAY0_NOTIFIED) {
    const ref = `L${n}`;
    const leadId = await day0LeadId(sim, n);
    const lead = leadId === null ? null : await sim.db.maybeOne<{ first_send_clicked_at: Date | null }>('select first_send_clicked_at from public.leads where id = $1', [leadId]);
    const uses = await tokenUses(sim, leadId);
    const tap = DAY0_OWNER_TAPS.find((candidate) => candidate.n === n);
    const expected = tap === undefined ? null : sim.local(tap.tapAt).getTime();
    const actual = lead?.first_send_clicked_at?.getTime() ?? null;
    sim.check(
      tap === undefined ? `day0.${ref}.no_click_recorded` : `day0.${ref}.send_click_recorded_at_the_tap`,
      lead !== null && actual === expected && uses.send === (tap === undefined ? 0 : 1),
      `first_send_clicked_at ${shownLocal(sim, lead?.first_send_clicked_at ?? null)}, send uses ${uses.send ?? 'none'}`,
    );
  }
}

async function checkFollowUps(sim: Simulation): Promise<void> {
  for (const n of DAY0_NOTIFIED) {
    const ref = `L${n}`;
    const leadId = await day0LeadId(sim, n);
    const lead = leadId === null ? null : await sim.db.maybeOne<{ first_notified_at: Date | null }>('select first_notified_at from public.leads where id = $1', [leadId]);
    const jobs =
      leadId === null
        ? []
        : await sim.db.query<{ seq: number; status: string; run_at: Date; payload: Record<string, unknown> }>(
            `select seq, status, run_at, payload from public.scheduled_jobs where lead_id = $1 and kind = 'followup' order by seq`,
            [leadId],
          );
    const t0 = lead?.first_notified_at ?? null;
    const local = (at: Date) => DateTime.fromJSDate(at, { zone: sim.timeZone });
    const ok =
      t0 !== null &&
      jobs.length === 2 &&
      jobs.every((job, index) => {
        const days = index === 0 ? 2 : 5;
        const expected = local(t0).plus({ days }).toJSDate();
        const at = local(job.run_at);
        const minutes = at.hour * 60 + at.minute;
        return (
          job.seq === index + 1 &&
          job.status === 'scheduled' &&
          job.run_at.getTime() === expected.getTime() &&
          job.payload.targetAt === job.run_at.toISOString() &&
          job.payload.n === index + 1 &&
          at.toFormat('ccc') === (index === 0 ? 'Thu' : 'Sun') &&
          minutes >= 10 * 60 &&
          minutes <= 10 * 60 + 36
        );
      });
    sim.check(
      `day0.${ref}.two_follow_ups_thu_and_sun_at_the_email_time`,
      ok,
      `T0 ${shownLocal(sim, t0)}; ${jobs.map((job) => `fu${job.seq} ${shownLocal(sim, job.run_at)} ${job.status}`).join(', ') || 'no follow-ups'}`,
    );
  }
  const filtered = await sim.db.one<{ n: number }>(
    `select count(*)::int as n from public.scheduled_jobs j join public.leads l on l.id = j.lead_id where j.kind = 'followup' and l.processing_state <> 'notified'`,
  );
  sim.check('day0.no_follow_ups_for_leads_not_emailed', filtered.n === 0, `${filtered.n} follow-ups`);
}

async function checkStatuses(sim: Simulation): Promise<void> {
  const seen: string[] = [];
  let ok = true;
  for (const submission of DAY0_SUBMISSIONS) {
    const result = await statusOf(sim, await day0LeadId(sim, submission.n));
    const status = result?.status ?? 'missing';
    seen.push(`L${submission.n} ${status}`);
    if (status !== EXPECTED_STATUS[submission.n]) ok = false;
  }
  sim.check('day0.statuses_at_1045', ok, seen.join(', '));
}

/** Schedules the owner's 10:42–10:44 steps, runs them, then checks the Day 0 emails at 10:45. */
export async function runDay0Emails(sim: Simulation): Promise<void> {
  sim.travel.at(sim.local(EDIT_AT), 'edit #1', () => editReply(sim));
  sim.travel.at(sim.local(DISMISS_AT), 'dismiss page #1 + test lead', () => openDismiss(sim));
  const probes: ProbeResult[] = [];
  sim.travel.at(sim.local(PROBE_AT), 'probe the links', () => probeLinks(sim, probes));
  await sim.travel.advanceTo(sim.local(DAY0_EMAILS_END));

  await checkEmails(sim, probes);
  await checkDrafts(sim);
  await checkClicks(sim);
  await checkFollowUps(sim);
  await checkStatuses(sim);
}
