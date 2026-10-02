// Simulation stage 7a (PLAN §13 "daily at 03:17 UTC", §15 M7): since M7 the main week's daily
// ticks run the real daily maintenance (`/api/cron/daily`: retention and prunes, the
// billing-tombstone reconcile, one `account_daily` job per account) and each account_daily job runs
// through the scheduler: the introspection probe, the account details, the subscription reconcile
// (none in this week), the re-encryption check, the orphan and purge checks, and the signal refresh
// of the leads whose follow-ups are over. None of it may send anything or change the week: the
// outbox stays exactly the 15 emails and the statuses stay as PLAN §13 says (the `wednesday` stage
// checks both). This stage, last in the run, checks the ticks and the jobs themselves.
import type { Simulation, Stage, TimelineEntry } from './types';

/** The week's 03:17 UTC ticks: Wed 10-07 to Wed 10-14. */
const EXPECTED_TICK_DATES = ['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14'];
/**
 * Leads the daily refresh reads in full each day: none while every notified lead still has a
 * follow-up scheduled (until Sunday's follow-up 2), then #1, #2 and #5 (#6 has both its send and its
 * reply recorded, so there is nothing left to learn; #3 and #4 were never emailed).
 */
const EXPECTED_LEADS_READ = [0, 0, 0, 0, 0, 3, 3, 3];

function day(entry: TimelineEntry): string {
  return entry.at.slice(0, 10);
}

async function checkDailyMaintenance(sim: Simulation): Promise<void> {
  const timeline = sim.entries();
  const ticks = timeline.filter((entry) => entry.name === 'cron.daily');
  sim.check(
    'daily.ticks_every_day_at_0317_utc_through_the_real_route',
    ticks.map(day).join(',') === EXPECTED_TICK_DATES.join(',') &&
      ticks.every((entry) => entry.at.endsWith('T03:17:00.000Z') && entry.detail?.httpStatus === 200 && entry.detail.status === 'ran' && entry.detail.errors === 0),
    ticks.map((entry) => `${day(entry)} ${String(entry.detail?.httpStatus)} ${String(entry.detail?.status)}`).join(', '),
  );
  sim.check(
    'daily.one_account_daily_job_per_day_for_the_account',
    ticks.every((entry) => entry.detail?.accounts === 1 && entry.detail.jobsCreated === 1),
    ticks.map((entry) => `${day(entry)} accounts ${String(entry.detail?.accounts)} created ${String(entry.detail?.jobsCreated)}`).join(', '),
  );

  const jobs = timeline.filter((entry) => entry.name === 'job.account_daily');
  sim.check(
    'daily.every_account_daily_job_done_right_after_its_tick',
    jobs.length === EXPECTED_TICK_DATES.length &&
      jobs.every((entry, i) => day(entry) === EXPECTED_TICK_DATES[i] && entry.detail?.jobStatus === 'done' && entry.detail.retried === 0),
    jobs.map((entry) => `${entry.at} ${String(entry.detail?.jobStatus)}`).join(', '),
  );
  sim.check(
    'daily.account_daily_sends_nothing',
    jobs.every((entry) => entry.detail?.emailsSent === 0),
    jobs.map((entry) => `${day(entry)} ${String(entry.detail?.emailsSent)}`).join(', '),
  );
  const read = jobs.map((entry) => entry.detail?.leadsRead ?? null);
  sim.check(
    'daily.signal_refresh_reads_only_leads_whose_follow_ups_are_over',
    read.join(',') === EXPECTED_LEADS_READ.join(','),
    read.map((n, i) => `${EXPECTED_TICK_DATES[i] ?? '?'} ${String(n)}`).join(', '),
  );

  // Retention ran each day and found nothing of the week's content due (it is purged after 30 days;
  // the test lead's content went with the 5-minute guard after 24 hours).
  sim.check(
    'daily.retention_keeps_the_weeks_content',
    ticks.every((entry) => entry.detail?.leadMessagesDeleted === 0 && entry.detail.draftsPurged === 0),
    ticks.map((entry) => `${day(entry)} messages ${String(entry.detail?.leadMessagesDeleted)} drafts ${String(entry.detail?.draftsPurged)}`).join(', '),
  );
  const content = await sim.db.one<{ messages: number; drafts: number }>(
    `select (select count(*)::int from public.lead_messages m join public.leads l on l.id = m.lead_id where not l.is_test) as messages,
            (select count(*)::int from public.drafts d join public.leads l on l.id = d.lead_id where not l.is_test and d.body is not null) as drafts`,
  );
  sim.check('daily.lead_content_still_stored_within_30_days', content.messages === 6 && content.drafts > 0, `messages ${content.messages}, drafts ${content.drafts}`);
}

export const DAILY_MAINTENANCE_STAGE: Stage = { id: 'daily-maintenance', milestone: 'M7', run: checkDailyMaintenance };
