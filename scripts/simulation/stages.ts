// The simulation's stages in run order (PLAN §13). Each milestone appends its stages here and
// enables its checks; earlier stages stay as they are.
//
//   M1  boot      fakes + in-memory PGlite (migrated) + FakeClock, fixture portal loaded; no checks
//   M2  seed      install through the fake consent and the real OAuth callback (branch a), then the
//                 rest of onboarding by direct inserts; active at 09:04:30 (M3 replaces it: pre-run)
//   M2  day-0     submissions #1-#6 from 10:00, webhooks and cron polls; intake + classification checks
//   M4+ day 0 emails, day 1 … Wednesday, final checks (PLAN §13 calendar)
import { runDay0 } from './day0';
import { seedActiveAccount } from './seed';
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

/** M2 seed helper, replaced by M3's real onboarding (PLAN §15 M2, D-50). */
const seed: Stage = {
  id: 'seed',
  milestone: 'M2',
  run: seedActiveAccount,
};

const day0: Stage = {
  id: 'day-0',
  milestone: 'M2',
  run: runDay0,
};

export const BOOT_STAGE: Stage = boot;

export const STAGES: readonly Stage[] = [boot, seed, day0];
