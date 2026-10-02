// The simulation's stages in run order (PLAN §13). Each milestone appends its stages here and
// enables its checks; earlier stages stay as they are.
//
//   M1  boot      fakes + in-memory PGlite (migrated) + FakeClock, fixture portal loaded; no checks
//   M3  pre-run   the real onboarding 09:00–09:04:30 through the route handlers, page views and
//                 action bodies (replaced M2's seed helper); background done by 09:06
//   M2  day-0     submissions #1-#6 from 10:00, webhooks and cron polls; intake + classification checks;
//                 since M4 also the drafts, the 4 new_lead emails and the owner's Send taps (10:12, 10:30, 10:40)
//   M4  day-0-emails  10:42 edit link (GET + POST), 10:43 dismiss link (GET; the test lead dismissed),
//                 10:44 every link resolves; at 10:45 the emails, clicks, follow-up rows and statuses
//   M5  day-1     Wed 10:00 the owner sends #5's reply (logged 10:01); statuses
//   M5  day-2     Thu follow-up 1 ×4 (#1 #2 #6 #5), sends confirmed from HubSpot, honest notes; statuses
//   M5  day-3     Fri 14:00 #6 replies in HubSpot; nothing sent; statuses
//   M5  day-5     Sun follow-up 2 ×3 (#1 #2 #5) + reply_detected ×1 (#6), every job finished; statuses
//   M6  monday    Mon 08:00 the due-check → weekly_report ×1, the FULL metrics JSON (PLAN §13); 09:30 the
//                 owner opens the dashboard from the report
//   M6  wednesday Wed 12:00 no emails, final statuses, outbox 15, every job finished; the dashboard's
//                 statuses and #6's lead page with "Resume follow-ups"
//   M3  test-lead the onboarding test lead's exclusions (since M6 also the dashboard and the metrics)
//   M7  daily-maintenance  the week's 03:17 UTC ticks ran the real daily cron and one account_daily
//                 job a day, each done, none sending anything, the refresh reading only finished leads
//
// DAILY_CAP_STAGES is a separate variant run (MAX_DRAFTED_LEADS_PER_DAY=1, its own outbox directory):
// boot, the same pre-run, then Day 0 with the cap (daily-cap.ts). The M7 variants are separate runs
// too, each into its own outbox directory: BILLING_STAGES (subscribe during the trial → authenticated
// → past the trial end → charged → active), LAPSE_STAGES (no subscription → inactive at the trial end,
// one billing_inactive email, nothing read after it) (billing.ts) and DISCONNECT_STAGES (Disconnect →
// purge 30 days later, tombstones only) (disconnect.ts).
import { BILLING_VARIANT_STAGES, LAPSE_VARIANT_STAGES } from './billing';
import { DAILY_MAINTENANCE_STAGE } from './daily';
import { DAILY_CAP_STAGE } from './daily-cap';
import { runDay0 } from './day0';
import { runDay0Emails } from './day0-emails';
import { FOLLOW_UP_STAGES } from './followups';
import { runPreRun } from './pre-run';
import { DISCONNECT_VARIANT_STAGES } from './disconnect';
import { checkTestLeadExclusions } from './test-lead';
import type { Simulation, Stage } from './types';
import { WEEK_END_STAGES } from './week-end';

const boot: Stage = {
  id: 'boot',
  milestone: 'M1',
  async run(sim: Simulation): Promise<void> {
    const versions = await sim.db.query<{ version: string }>('select version from fake._migrations order by version');
    sim.record('step', 'db.migrated', { versions: versions.map((row) => row.version) });

    const hubspot = sim.fakes.hubspot;
    const state = hubspot.snapshot();
    const loggedEmails = state.emails.filter((email) => email.direction === 'EMAIL').length;
    sim.record('step', 'portal.loaded', {
      portalId: state.portal.portalId,
      timeZone: state.portal.timeZone,
      uiDomain: state.portal.uiDomain,
      ownerLoggingMode: hubspot.loggingMode(),
      forms: state.forms.map((form) => form.name),
      contacts: state.contacts.length,
      historicalSubmissions: state.submissions.length,
      loggedOwnerSends: loggedEmails,
      installed: hubspot.isInstalled(),
    });

    sim.record('step', 'fakes.ready', {
      ports: ['clock', 'hubspot', 'llm', 'mailer', 'scheduler', 'billing', 'webFetcher', 'auth'],
      pendingJobs: sim.fakes.scheduler.pending().length,
    });
  },
};

/** The real onboarding (PLAN §13 pre-run, §15 M3); it replaced M2's seed helper. */
const preRun: Stage = {
  id: 'pre-run',
  milestone: 'M3',
  run: runPreRun,
};

const day0: Stage = {
  id: 'day-0',
  milestone: 'M2',
  run: runDay0,
};

/** Day 0's emails and action links (PLAN §13 Day 0 row, §15 M4 "new_lead ×4; all three action links work; clicks recorded"). */
const day0Emails: Stage = {
  id: 'day-0-emails',
  milestone: 'M4',
  run: runDay0Emails,
};

export const BOOT_STAGE: Stage = boot;

const testLead: Stage = {
  id: 'test-lead',
  milestone: 'M3',
  run: checkTestLeadExclusions,
};

export const STAGES: readonly Stage[] = [boot, preRun, day0, day0Emails, ...FOLLOW_UP_STAGES, ...WEEK_END_STAGES, testLead, DAILY_MAINTENANCE_STAGE];

/** The daily-cap variant (M6, D-68's gate): the same onboarding, then Day 0 with one drafted lead a day. */
export const DAILY_CAP_STAGES: readonly Stage[] = [boot, preRun, DAILY_CAP_STAGE];

/** The billing variant (M7): the same onboarding, a subscription during the trial, active after it. */
export const BILLING_STAGES: readonly Stage[] = [boot, preRun, ...BILLING_VARIANT_STAGES];

/** The lapse variant (M7): the same onboarding, no subscription, inactive at the trial's end. */
export const LAPSE_STAGES: readonly Stage[] = [boot, preRun, ...LAPSE_VARIANT_STAGES];

/** The disconnect variant (M7): the same onboarding and Day 0, Disconnect, the purge 30 days later. */
export const DISCONNECT_STAGES: readonly Stage[] = [boot, preRun, ...DISCONNECT_VARIANT_STAGES];
