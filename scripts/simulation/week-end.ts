// Simulation stage 6, Monday to Wednesday (PLAN §13 calendar, §15 M6, D-17, D-37, D-39), America/New_York:
//   monday     Mon 2026-10-12 08:00  the hourly due-check (12:00 UTC) finds the account due and creates
//                                    the report row and its `weekly_report` job (staggered 0–10 min);
//                                    the job refreshes the signals, stores the metrics and sends
//                                    `weekly_report` ×1 for [Mon 10-05 08:00, Mon 10-12 08:00). The
//                                    FULL metrics JSON is asserted against PLAN §13's table. At 09:30
//                                    the owner opens the dashboard from the report (the proxy renews
//                                    the session, so it lasts into Wednesday).
//   wednesday  Wed 2026-10-14 12:00  no emails since Monday; the final statuses (#1 #2 #5 no reply,
//                                    #3 #4 filtered, #6 replied); the outbox is exactly 15 emails
//                                    (2 + 4 + 4 + 4 + 1); every job finished. The owner's dashboard
//                                    lists the 6 leads with those statuses; #6's lead page (with its
//                                    refresh on view) offers "Resume follow-ups", the page the
//                                    reply_detected email links to (D-68/D-73's M6 gate).
// Statuses and controls come from the same read models the pages render (views/dashboard), for the
// owner's session (requireOwner); no page is clicked, so nothing changes the expected outbox.
import { isDeepStrictEqual } from 'node:util';
import { DateTime } from 'luxon';
import { WEEKLY_REPORT_HONESTY_LINE, weeklyReportSubject } from '@/emails/WeeklyReport';
import type { FakeSentMail } from '@/server/adapters/fake/mailer';
import { leadStatusLabel } from '@/server/domain/lead-status';
import type { LeadDisplayStatus } from '@/server/domain/types';
import { leadPagePath } from '@/server/services/leads/reply-detected-notification';
import { dashboardView, leadDetailView, refreshLeadSignals, type DashboardView } from '@/server/views/dashboard';
import { DAY0_SUBMISSIONS, day0LeadId, day0Submission } from './day0-scenario';
import { ownerPageScope } from './owner-session';
import { shownLocal, statusOf } from './status';
import type { Simulation, Stage } from './types';

/** The due-check's hour: Monday 08:00 in the portal's zone (12:00 UTC in October). */
const MONDAY_DUE = '2026-10-12T08:00:00';
/** The report job waits 15 min after 08:00 for late intake (D-77), then its 0–10 min stagger. */
const REPORT_GRACE_MS = 15 * 60_000;
/** …plus a few limiter seconds. */
const REPORT_WINDOW_MS = REPORT_GRACE_MS + 11 * 60_000;
/**
 * The owner opens the dashboard from the report's "Open your dashboard" link. The session from
 * Tuesday 09:00:30 lasts 7 days and the proxy renews it inside its last day, so this view (23.5 h
 * before it ends) keeps the owner signed in through Wednesday.
 */
const MONDAY_DASHBOARD = '2026-10-12T09:30:00';
const WEDNESDAY = '2026-10-14T12:00:00';
const WEEK_START = '2026-10-12';

/** PLAN §13 "Expected final statuses (Wednesday)". */
const FINAL_STATUSES: Readonly<Record<number, LeadDisplayStatus>> = { 1: 'no_reply', 2: 'no_reply', 3: 'filtered', 4: 'filtered', 5: 'no_reply', 6: 'replied' };
/** The lead who replied (#6) and the one whose send was never confirmed (#2). */
const REPLIER = 6;
const WAITING = 2;

/** PLAN §13 "Expected outbox: 15 emails" (pre-run 2, Day 0 4, Day 2 4, Day 5 4, Monday 1), in send order. */
const EXPECTED_OUTBOX = [
  'magic_link:none',
  'inbox_test:none',
  'new_lead:L1',
  'new_lead:L2',
  'new_lead:L6',
  'new_lead:L5',
  'follow_up:L1',
  'follow_up:L2',
  'follow_up:L6',
  'follow_up:L5',
  'follow_up:L1',
  'follow_up:L2',
  'reply_detected:L6',
  'follow_up:L5',
  'weekly_report:none',
] as const;

/** The scenario's lead ids by submission number, and the reverse map to refs. */
async function scenarioLeads(sim: Simulation): Promise<{ ids: Map<number, string>; refs: Map<string, string> }> {
  const ids = new Map<number, string>();
  const refs = new Map<string, string>();
  for (const submission of DAY0_SUBMISSIONS) {
    const id = await day0LeadId(sim, submission.n);
    if (id === null) continue;
    ids.set(submission.n, id);
    refs.set(id, `L${submission.n}`);
  }
  return { ids, refs };
}

function mailRef(refs: ReadonlyMap<string, string>, mail: FakeSentMail): string {
  if (mail.lead === undefined) return 'none';
  return refs.get(mail.lead) ?? 'other';
}

function listed(refs: ReadonlyMap<string, string>, mails: readonly FakeSentMail[]): string {
  return mails.map((mail) => `${mail.kind}:${mailRef(refs, mail)}`).join(', ') || 'none';
}

/** The contact's record page as PLAN §13 expects it in the report (`https://{uiDomain}/contacts/{portal}/record/0-1/{contact}`). */
function recordUrl(sim: Simulation, n: number): string | null {
  const contactId = sim.fakes.hubspot.contactIdByEmail(day0Submission(n).email);
  const { portalId, uiDomain } = sim.fakes.hubspot.portal;
  return contactId === null ? null : `https://${uiDomain}/contacts/${portalId}/record/0-1/${contactId}`;
}

/** PLAN §13 "Expected weekly metrics", as the stored JSON with the waiting lead named by its ref. */
function expectedMetrics(sim: Simulation): unknown {
  const minutes = (n: number): number => n * 60;
  return {
    version: 1,
    period: { start: sim.local('2026-10-05T08:00:00').toISOString(), end: sim.local(MONDAY_DUE).toISOString() },
    basis: { loggingMode: 'log_all', emailScope: true, sendsLogged: true, repliesLogged: true },
    cohort: {
      leadsIn: 6,
      filtered: 2,
      draftsEmailed: 4,
      // #1, #5 and #6 (HubSpot logged the owner's sends); #2's link was opened, its send never logged.
      sendsConfirmed: 3,
      sendLinkOpenedNotConfirmed: 1,
      // 13 m (#1), 21 m (#6), 23 h 30 m (#5): the median is 21 m.
      medianTimeToFirstReply: { seconds: minutes(21), samples: 3 },
      waiting: { count: 1, leads: [{ leadId: `L${WAITING}`, submittedAt: sim.local(day0Submission(WAITING).at).toISOString(), recordUrl: recordUrl(sim, WAITING) }], more: 0 },
      // The report's refresh read every notified lead in full.
      unchecked: 0,
    },
    // #6's reply (Fri); follow-up 1 ×4 (Thu) + follow-up 2 ×3 (Sun).
    events: { repliesFromLeads: 1, followUpsDrafted: 7 },
    // Baseline 3 h 30 m and 20% (1 of 5); this week 21 m and 25% (#2 of #1 #2 #5 #6).
    comparison: {
      baseline: 'ok',
      baselineMedianSeconds: minutes(210),
      baselinePercentWithoutReply: 20,
      medianSeconds: minutes(21),
      percentWithoutReply: 25,
      population: 4,
      withoutReply: 1,
    },
  };
}

/** The stored metrics with each waiting lead's id replaced by its ref (summary.json never holds ids). */
function withRefs(metrics: unknown, refs: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(metrics)) return metrics.map((item) => withRefs(item, refs));
  if (metrics === null || typeof metrics !== 'object') return metrics;
  return Object.fromEntries(
    Object.entries(metrics).map(([key, value]) => [key, key === 'leadId' && typeof value === 'string' ? (refs.get(value) ?? 'not_a_scenario_lead') : withRefs(value, refs)]),
  );
}

/** Leaf paths where two JSON values differ (ids, numbers, instants and URLs only: no content). */
function differences(actual: unknown, expected: unknown, path = ''): string[] {
  if (isDeepStrictEqual(actual, expected)) return [];
  const bothObjects = actual !== null && expected !== null && typeof actual === 'object' && typeof expected === 'object';
  if (!bothObjects || Array.isArray(actual) !== Array.isArray(expected)) return [`${path || '.'}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`];
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  return [...keys].flatMap((key) =>
    differences((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], `${path}.${key}`),
  );
}

interface ReportRow {
  week_start: string;
  timezone: string;
  period_start: Date;
  period_end: Date;
  status: string;
  attempts: number;
  metrics: unknown;
}

interface ReportJobRow {
  status: string;
  created_at: Date;
  run_at: Date;
  attempts: number;
}

// ---------------------------------------------------------------------------------------------
// Monday: the report
// ---------------------------------------------------------------------------------------------

async function ownerOpensDashboard(sim: Simulation, refs: ReadonlyMap<string, string>): Promise<void> {
  const scope = await ownerPageScope(sim, '/dashboard');
  const view = scope === null ? null : await dashboardView(scope, sim.deps);
  const listedRefs = view?.leads.map((lead) => refs.get(lead.id) ?? 'other') ?? [];
  sim.check(
    'monday.owner_opens_the_dashboard_from_the_report',
    scope !== null && scope.accountId === sim.scenario.accountId && view !== null && view.onboardingComplete && [...listedRefs].sort().join(',') === 'L1,L2,L3,L4,L5,L6',
    `signed in ${String(scope !== null)}, listed ${listedRefs.join(', ') || 'none'}`,
  );
  sim.record('step', 'dashboard.opened_by_owner', { from: 'weekly_report', leads: view?.leads.length ?? 0 });
}

async function runMonday(sim: Simulation): Promise<void> {
  const emailsBefore = sim.fakes.mailer.sent.length;
  const { refs } = await scenarioLeads(sim);
  sim.travel.at(sim.local(MONDAY_DASHBOARD), 'owner opens the dashboard', () => ownerOpensDashboard(sim, refs));
  await sim.travel.advanceTo(sim.local(MONDAY_DASHBOARD));

  const accountId = sim.scenario.accountId;
  const dueAt = sim.local(MONDAY_DUE);
  const reports = await sim.db.query<ReportRow>(
    `select week_start::text as week_start, timezone, period_start, period_end, status, attempts, metrics from public.weekly_reports where account_id = $1`,
    [accountId],
  );
  const report = reports[0];
  sim.check(
    'monday.one_report_for_the_week_of_mon_10_12',
    reports.length === 1 &&
      report?.week_start === WEEK_START &&
      report.timezone === sim.timeZone &&
      report.period_start.getTime() === sim.local('2026-10-05T08:00:00').getTime() &&
      report.period_end.getTime() === dueAt.getTime() &&
      report.status === 'sent' &&
      report.attempts === 0,
    report === undefined
      ? `${reports.length} reports`
      : `${reports.length} report(s): week ${report.week_start}, ${report.timezone}, [${shownLocal(sim, report.period_start)}, ${shownLocal(sim, report.period_end)}), ${report.status}, attempts ${report.attempts}`,
  );

  // The due-check created it at the 08:00 local tick (no earlier tick did: the row is unique per
  // week), and the job ran once, 15 min later (late intake, D-77) plus its stagger.
  const jobs = await sim.db.query<ReportJobRow>(`select status, created_at, run_at, attempts from public.scheduled_jobs where kind = 'weekly_report' and account_id = $1`, [accountId]);
  const job = jobs[0];
  const staggerMs = job === undefined ? null : job.run_at.getTime() - job.created_at.getTime();
  sim.check(
    'monday.due_check_at_0800_local_creates_one_staggered_job',
    jobs.length === 1 &&
      job?.created_at.getTime() === dueAt.getTime() &&
      staggerMs !== null &&
      staggerMs >= REPORT_GRACE_MS &&
      staggerMs <= REPORT_GRACE_MS + 10 * 60_000 &&
      job.status === 'done',
    job === undefined ? 'no job' : `created ${shownLocal(sim, job.created_at)}, runs ${Math.round((staggerMs ?? 0) / 1000)} s later, ${job.status}`,
  );

  // PLAN §13 "Monday: weekly_report ×1, covering [Mon 10-05 08:00, Mon 10-12 08:00)".
  const sent = sim.fakes.mailer.sent.slice(emailsBefore);
  const mail = sent.find((candidate) => candidate.kind === 'weekly_report');
  const sentAfterMs = mail === undefined ? null : mail.sentAt.getTime() - dueAt.getTime();
  sim.check(
    'monday.one_weekly_report_email_after_0800',
    sent.length === 1 && mail !== undefined && sentAfterMs !== null && sentAfterMs >= REPORT_GRACE_MS && sentAfterMs < REPORT_WINDOW_MS,
    `${listed(refs, sent)} at ${mail === undefined ? 'none' : shownLocal(sim, mail.sentAt)}`,
  );
  if (mail !== undefined) {
    const ownerEmail = sim.scenario.ownerEmail;
    sim.check(
      'monday.report_to_the_owner_with_reply_to_the_owner',
      ownerEmail !== null && mail.to.join(',') === ownerEmail && mail.replyTo === ownerEmail,
      `to ${mail.to.length} address(es), reply-to ${mail.replyTo === ownerEmail ? 'owner' : 'other'}`,
    );
    const subject = weeklyReportSubject(sim.deps.env.PRODUCT_NAME, 'Mon 5 Oct – Mon 12 Oct');
    sim.check('monday.report_subject_names_the_week', mail.subject === subject, mail.subject);
    const waitingLink = recordUrl(sim, WAITING);
    const lines = [
      `From Mon 5 Oct, 08:00 to Mon 12 Oct, 08:00 (${sim.timeZone}).`,
      'Leads in: 6',
      'Filtered (spam etc.): 2',
      'Drafts emailed to you: 4',
      'Your sends confirmed in HubSpot: 3',
      'Send link opened, not confirmed: 1',
      'Median time to your first reply (logged in HubSpot): 21 min',
      'Leads still waiting for your reply (nothing logged in HubSpot): 1',
      `Lead submitted Tue 6 Oct, 10:05`,
      'Replies from leads: 1',
      'Follow-ups drafted: 7',
      // "Compared with your baseline": the median, then the % (PLAN §13's headline comparison).
      'Baseline: 3 h 30 min · This week: 21 min',
      'Baseline: 20% · This week: 25%',
      WEEKLY_REPORT_HONESTY_LINE,
    ];
    const missing = lines.filter((line) => !mail.text.includes(line));
    sim.check('monday.report_email_states_the_period_and_counts', missing.length === 0, missing.length === 0 ? `${lines.length} lines found` : `missing: ${missing.join(' | ')}`);
    // #2 is listed by its submission time and record link only (no name: law 4); no other lead is.
    const otherLinks = DAY0_SUBMISSIONS.filter((submission) => submission.n !== WAITING)
      .map((submission) => recordUrl(sim, submission.n))
      .filter((url): url is string => url !== null && mail.html.includes(`href="${url}"`));
    sim.check(
      `monday.report_lists_L${WAITING}_waiting_with_its_record_link`,
      waitingLink !== null && mail.html.includes(`href="${waitingLink}"`) && otherLinks.length === 0 && !mail.text.includes(day0Submission(WAITING).firstName),
      `L${WAITING} link ${String(waitingLink !== null && mail.html.includes(`href="${waitingLink}"`))}, other record links ${otherLinks.length}`,
    );
  }

  // The FULL metrics JSON (PLAN §13 "the full JSON is asserted"), the waiting lead named by its ref.
  const metrics = report === undefined ? null : withRefs(report.metrics, refs);
  const diff = differences(metrics, expectedMetrics(sim));
  sim.check('monday.weekly_metrics_json_exactly_as_plan_13', metrics !== null && diff.length === 0, diff.length === 0 ? 'equal' : diff.join('; '));
  sim.setWeeklyReport(metrics);

  // The report's own refresh read HubSpot for the week's notified leads (D-17: signals first).
  const checked = await sim.db.query<{ id: string; signals_checked_at: Date | null }>(
    `select id, signals_checked_at from public.leads where account_id = $1 and not is_test and first_notified_at is not null order by submitted_at`,
    [accountId],
  );
  const refreshed = checked.filter((row) => row.signals_checked_at !== null && row.signals_checked_at.getTime() >= dueAt.getTime());
  sim.check(
    'monday.report_refreshed_the_notified_leads_first',
    checked.length === 4 && refreshed.length === 4,
    checked.map((row) => `${refs.get(row.id) ?? 'other'} ${shownLocal(sim, row.signals_checked_at)}`).join(', '),
  );
}

// ---------------------------------------------------------------------------------------------
// Wednesday: no emails, final statuses, the dashboard
// ---------------------------------------------------------------------------------------------

function statusLine(view: DashboardView, refs: ReadonlyMap<string, string>): string {
  return [...view.leads]
    .map((lead) => ({ ref: refs.get(lead.id) ?? 'other', lead }))
    .sort((a, b) => a.ref.localeCompare(b.ref))
    .map(({ ref, lead }) => `${ref} ${lead.status}`)
    .join(', ');
}

async function checkDashboard(sim: Simulation, ids: ReadonlyMap<number, string>, refs: ReadonlyMap<string, string>): Promise<void> {
  const scope = await ownerPageScope(sim, '/dashboard');
  sim.check('wednesday.owner_still_signed_in', scope !== null && scope.accountId === sim.scenario.accountId, scope === null ? 'no session' : 'signed in');
  if (scope === null) return;

  // /dashboard: the 6 leads, each with one status (D-32) in the owner's words; the test lead is in no list.
  const view = await dashboardView(scope, sim.deps);
  const expected = Object.entries(FINAL_STATUSES)
    .map(([n, status]) => `L${n} ${status}`)
    .join(', ');
  const labelsOk = view.leads.every((lead) => lead.statusLabel === leadStatusLabel(lead.status));
  sim.check(
    'wednesday.dashboard_lists_the_6_leads_with_their_final_statuses',
    view.leads.length === 6 && statusLine(view, refs) === expected && labelsOk && view.leads.every((lead) => lead.recordUrl !== null && lead.notProcessed === null),
    `${view.leads.length} listed: ${statusLine(view, refs)}`,
  );
  sim.check(
    'wednesday.dashboard_status_card_active_no_warning_banners',
    view.status.state === 'active' && view.banners.length === 0,
    `${view.status.state}, banners ${view.banners.map((banner) => banner.type).join(', ') || 'none'}`,
  );

  // #6's lead page: the refresh on view reads HubSpot (nothing new, nothing sent), then the page
  // offers "Resume follow-ups" (the lead replied; follow-ups are on and the account is active).
  const replierId = ids.get(REPLIER) ?? '';
  const pageScope = await ownerPageScope(sim, leadPagePath(replierId));
  if (pageScope === null) return;
  const emailsBefore = sim.fakes.mailer.sent.length;
  const refresh = await refreshLeadSignals(pageScope, sim.deps, replierId, {
    signal: new AbortController().signal,
    applyOptions: {
      sleep: async (ms) => {
        sim.clock.advance(ms);
      },
    },
  });
  const detail = await leadDetailView(pageScope, sim.deps, replierId);
  sim.check(
    `wednesday.L${REPLIER}.lead_page_refresh_reads_hubspot_and_sends_nothing`,
    refresh.type === 'checked' && refresh.emailsAvailable && refresh.replied && !refresh.markedReplied && sim.fakes.mailer.sent.length === emailsBefore,
    `${refresh.type}${refresh.type === 'checked' ? ` (emails ${String(refresh.emailsAvailable)}, replied ${String(refresh.replied)}, newly ${String(refresh.markedReplied)})` : ''}, emails ${sim.fakes.mailer.sent.length - emailsBefore}`,
  );
  const repliedEvent = detail?.timeline.find((event) => event.kind === 'lead_replied');
  sim.check(
    `wednesday.L${REPLIER}.lead_page_offers_resume_follow_ups`,
    detail !== null &&
      detail.status === 'replied' &&
      detail.controls.resumeFollowUps === 'available' &&
      detail.controls.realLead === null &&
      detail.controls.dismiss &&
      detail.stopReason === 'replied' &&
      repliedEvent?.at === 'Fri 9 Oct, 14:00',
    detail === null
      ? 'not found'
      : `${detail.status}, resume ${detail.controls.resumeFollowUps ?? 'none'}, real lead ${detail.controls.realLead ?? 'none'}, reply ${repliedEvent?.at ?? 'none'}`,
  );

  // The reply_detected email's "resume follow-ups" line links to that page (D-73).
  const replyMail = sim.fakes.mailer.sent.find((mail) => mail.kind === 'reply_detected');
  const pageUrl = `${sim.deps.env.APP_URL}${leadPagePath(replierId)}`;
  sim.check(
    `wednesday.L${REPLIER}.reply_detected_email_links_the_lead_page`,
    replyMail !== undefined && replyMail.lead === replierId && replyMail.text.includes(pageUrl) && /resume follow-ups/i.test(replyMail.text),
    replyMail === undefined ? 'no reply_detected email' : `links the lead page ${String(replyMail.text.includes(pageUrl))}`,
  );

  // The other pages: no Resume (no reply); "This is a real lead" only on the filtered #3 and #4.
  const controls: string[] = [];
  let ok = true;
  for (const submission of DAY0_SUBMISSIONS) {
    if (submission.n === REPLIER) continue;
    const leadView = await leadDetailView(pageScope, sim.deps, ids.get(submission.n) ?? '');
    const filtered = FINAL_STATUSES[submission.n] === 'filtered';
    controls.push(`L${submission.n} ${leadView?.controls.realLead ?? 'none'}/${leadView?.controls.resumeFollowUps ?? 'none'}`);
    if (leadView === null || leadView.controls.resumeFollowUps !== null || leadView.controls.realLead !== (filtered ? 'available' : null)) ok = false;
  }
  sim.check('wednesday.real_lead_only_on_filtered_leads_resume_only_on_the_replier', ok, controls.join(', '));
}

async function runWednesday(sim: Simulation): Promise<void> {
  const emailsBefore = sim.fakes.mailer.sent.length;
  await sim.travel.advanceTo(sim.local(WEDNESDAY));
  const { ids, refs } = await scenarioLeads(sim);

  const sent = sim.fakes.mailer.sent.slice(emailsBefore);
  sim.check('wednesday.no_emails_since_monday', sent.length === 0, listed(refs, sent));

  // PLAN §13 "Expected final statuses (Wednesday)", from the rows (D-32 through deriveLeadStatus).
  const seen: string[] = [];
  let statusesOk = true;
  for (const submission of DAY0_SUBMISSIONS) {
    const status = (await statusOf(sim, ids.get(submission.n) ?? null))?.status ?? 'missing';
    seen.push(`L${submission.n} ${status}`);
    if (status !== FINAL_STATUSES[submission.n]) statusesOk = false;
  }
  sim.check('wednesday.final_statuses', statusesOk, seen.join(', '));
  const fifth = await sim.db.maybeOne<{ intake_trigger: string; send_confirmed_at: Date | null }>(`select intake_trigger, send_confirmed_at from public.leads where id = $1`, [
    ids.get(5) ?? null,
  ]);
  sim.check('wednesday.L5.intake_trigger_cron_send_confirmed', fifth?.intake_trigger === 'cron' && fifth.send_confirmed_at !== null, `intake_trigger ${fifth?.intake_trigger ?? 'none'}`);

  // PLAN §13 "Expected outbox: 15 emails".
  const outbox = sim.fakes.mailer.sent.map((mail) => `${mail.kind}:${mailRef(refs, mail)}`);
  sim.check('wednesday.outbox_is_15_emails_2_4_4_4_1', outbox.join(',') === EXPECTED_OUTBOX.join(','), `${outbox.length}: ${outbox.join(', ')}`);
  const monday = sim.fakes.mailer.sent.filter((mail) => mail.kind === 'weekly_report');
  sim.check(
    'wednesday.the_only_weekly_report_went_on_monday',
    monday.length === 1 && monday[0] !== undefined && DateTime.fromJSDate(monday[0].sentAt, { zone: sim.timeZone }).toFormat('ccc yyyy-LL-dd') === 'Mon 2026-10-12',
    monday.map((mail) => shownLocal(sim, mail.sentAt)).join(', ') || 'none',
  );

  // PLAN §13: every scheduled_jobs row ends done, cancelled or skipped; nothing is left in QStash.
  const unfinished = await sim.db.query<{ kind: string; status: string }>(
    `select kind, status from public.scheduled_jobs where status not in ('done', 'cancelled', 'skipped') order by kind, status`,
  );
  sim.check('wednesday.every_job_done_cancelled_or_skipped', unfinished.length === 0, unfinished.map((row) => `${row.kind}:${row.status}`).join(', ') || 'all finished');
  const pending = sim.fakes.scheduler.pending();
  sim.check('wednesday.no_pending_deliveries', pending.length === 0, `${pending.length} queued`);

  await checkDashboard(sim, ids, refs);
}

export const WEEK_END_STAGES: readonly Stage[] = [
  { id: 'monday', milestone: 'M6', run: runMonday },
  { id: 'wednesday', milestone: 'M6', run: runWednesday },
];
