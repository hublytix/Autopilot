// The simulation's stages in run order (PLAN §13). Each milestone appends its stages here and
// enables its checks; earlier stages stay as they are.
//
//   M1  boot      fakes + in-memory PGlite (migrated) + FakeClock, fixture portal loaded; no checks
//   M3  pre-run   the real onboarding 09:00–09:04:30 through the route handlers, page views and
//                 action bodies (replaced M2's seed helper); background done by 09:06
//   M2  day-0     submissions #1-#6 from 10:00, webhooks and cron polls; intake + classification checks
//   M4+ day 0 emails, day 1 … Wednesday (PLAN §13 calendar), inserted before `test-lead`
//   M3  test-lead the onboarding test lead's exclusions, checked last
import { runDay0 } from './day0';
import { runPreRun } from './pre-run';
import { checkTestLeadExclusions } from './test-lead';
import type { Simulation, Stage } from './types';

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

export const BOOT_STAGE: Stage = boot;

const testLead: Stage = {
  id: 'test-lead',
  milestone: 'M3',
  run: checkTestLeadExclusions,
};

export const STAGES: readonly Stage[] = [boot, preRun, day0, testLead];
