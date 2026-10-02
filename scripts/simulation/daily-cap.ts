// The daily-cap variant (PLAN §13 setup + Day 0, D-36, D-63, D-68's M6 gate): the same onboarding
// and Day 0 submissions with MAX_DRAFTED_LEADS_PER_DAY=1, run separately (`outbox/daily-cap/`), so
// the main scenario's outbox and summary are unchanged. #1 (10:00) takes the day's only slot and is
// drafted; #2 (10:05) is over the limit: `deferred`, and the day's one `lead_cap` email goes out
// ("the rest of today's leads are listed on your dashboard"); #6 and #5 are deferred without a
// second email; #3 and #4 are filtered as before. The owner's dashboard then lists the deferred
// leads as "Not processed" (over the daily limit), with the cap banner: the promise the email makes.
import type { FakeSentMail } from '@/server/adapters/fake/mailer';
import type { LeadDisplayStatus } from '@/server/domain/types';
import { dashboardView } from '@/server/views/dashboard';
import { scheduleDay0Submissions } from './day0';
import { DAY0_SUBMISSIONS, day0LeadId } from './day0-scenario';
import { ownerPageScope } from './owner-session';
import { shownLocal } from './status';
import type { Simulation, Stage } from './types';

export const DAILY_CAP_SCENARIO = 'brightside-plumbing-daily-cap';
/** The variant's only change to the fake-mode environment. */
export const DAILY_CAP_ENV: Readonly<Record<string, string>> = { MAX_DRAFTED_LEADS_PER_DAY: '1' };

const END = '2026-10-06T10:45:00';
/** Over the limit from #2 on (in the order lead_process reaches them: #2 10:05, #6 10:20, #5 10:35). */
const DEFERRED = [2, 5, 6] as const;
const EXPECTED: Readonly<Record<number, { state: string; status: LeadDisplayStatus }>> = {
  1: { state: 'notified', status: 'drafted' },
  2: { state: 'deferred', status: 'not_processed' },
  3: { state: 'filtered', status: 'filtered' },
  4: { state: 'filtered', status: 'filtered' },
  5: { state: 'deferred', status: 'not_processed' },
  6: { state: 'deferred', status: 'not_processed' },
};

function refOf(refs: ReadonlyMap<string, string>, mail: FakeSentMail): string {
  return mail.lead === undefined ? 'none' : (refs.get(mail.lead) ?? 'other');
}

async function runDailyCapDay0(sim: Simulation): Promise<void> {
  scheduleDay0Submissions(sim);
  await sim.travel.advanceTo(sim.local(END));

  const refs = new Map<string, string>();
  const ids = new Map<number, string>();
  for (const submission of DAY0_SUBMISSIONS) {
    const id = await day0LeadId(sim, submission.n);
    if (id === null) continue;
    ids.set(submission.n, id);
    refs.set(id, `L${submission.n}`);
  }

  const rows = await sim.db.query<{ id: string; processing_state: string }>(`select id, processing_state from public.leads where account_id = $1 and not is_test`, [sim.scenario.accountId]);
  const states = DAY0_SUBMISSIONS.map((submission) => `L${submission.n} ${rows.find((row) => row.id === ids.get(submission.n))?.processing_state ?? 'missing'}`);
  sim.check(
    'cap.one_drafted_lead_the_rest_deferred',
    rows.length === 6 && DAY0_SUBMISSIONS.every((submission) => rows.find((row) => row.id === ids.get(submission.n))?.processing_state === EXPECTED[submission.n]?.state),
    states.join(', '),
  );

  // Exactly one lead_cap email for the day (key cap:{acct}:{local date}), when #2 went over the limit.
  const outbox = sim.fakes.mailer.sent.map((mail) => `${mail.kind}:${refOf(refs, mail)}`);
  sim.check('cap.outbox_is_magic_link_inbox_test_new_lead_L1_lead_cap', outbox.join(',') === 'magic_link:none,inbox_test:none,new_lead:L1,lead_cap:none', outbox.join(', '));
  const capMails = sim.fakes.mailer.sent.filter((mail) => mail.kind === 'lead_cap');
  const capMail = capMails[0];
  const reservations = await sim.db.query<{ status: string }>(`select status from public.notifications_sent where kind = 'lead_cap' and account_id = $1`, [sim.scenario.accountId]);
  sim.check(
    'cap.exactly_one_lead_cap_email_when_L2_went_over',
    capMails.length === 1 &&
      capMail !== undefined &&
      capMail.sentAt.getTime() === sim.local('2026-10-06T10:05:00').getTime() &&
      capMail.to.join(',') === sim.scenario.ownerEmail &&
      capMail.text.includes('listed on your dashboard') &&
      reservations.length === 1 &&
      reservations[0]?.status === 'sent',
    `${capMails.length} email(s) at ${capMail === undefined ? 'none' : shownLocal(sim, capMail.sentAt)}, ${reservations.length} reservation(s)`,
  );
  const drafts = await sim.db.query<{ lead_id: string }>(
    `select d.lead_id from public.drafts d join public.leads l on l.id = d.lead_id where d.account_id = $1 and not l.is_test`,
    [sim.scenario.accountId],
  );
  sim.check(
    'cap.no_draft_for_a_deferred_lead',
    drafts.length === 1 && drafts[0]?.lead_id === ids.get(1),
    drafts.map((draft) => refs.get(draft.lead_id) ?? 'other').join(', ') || 'none',
  );

  // The owner's dashboard lists the deferred leads as "Not processed" (over the daily limit).
  const scope = await ownerPageScope(sim, '/dashboard');
  const view = scope === null ? null : await dashboardView(scope, sim.deps);
  const seen = DAY0_SUBMISSIONS.map((submission) => {
    const lead = view?.leads.find((candidate) => candidate.id === ids.get(submission.n));
    return { n: submission.n, lead };
  });
  sim.check(
    'cap.dashboard_lists_deferred_leads_as_not_processed',
    view !== null &&
      view.leads.length === 6 &&
      seen.every(({ n, lead }) => lead !== undefined && lead.status === EXPECTED[n]?.status) &&
      DEFERRED.every((n) => {
        const lead = seen.find((entry) => entry.n === n)?.lead;
        return lead?.statusLabel === 'Not processed' && lead.notProcessed === 'daily_cap';
      }),
    seen.map(({ n, lead }) => `L${n} ${lead === undefined ? 'missing' : `${lead.statusLabel}${lead.notProcessed === null ? '' : ` (${lead.notProcessed})`}`}`).join(', '),
  );
  const cap = view?.banners.find((banner) => banner.type === 'daily_cap');
  sim.check(
    'cap.dashboard_says_todays_limit_is_reached',
    cap !== undefined && cap.type === 'daily_cap' && cap.reachedToday && cap.limit === 1 && cap.deferredToday === DEFERRED.length && cap.deferredEarlier === 0,
    cap === undefined || cap.type !== 'daily_cap' ? 'no daily-cap banner' : `limit ${cap.limit}, today ${cap.deferredToday}, earlier ${cap.deferredEarlier}`,
  );
  sim.record('step', 'dashboard.opened_by_owner', { from: 'lead_cap', leads: view?.leads.length ?? 0 });
}

export const DAILY_CAP_STAGE: Stage = { id: 'day-0-daily-cap', milestone: 'M6', run: runDailyCapDay0 };
