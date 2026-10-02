// The simulation's stages in run order (PLAN §13). Each milestone appends its stages here and
// enables its checks; earlier stages stay as they are.
//
//   M1  boot      fakes + in-memory PGlite (migrated) + FakeClock, fixture portal loaded; no checks
//   M2+ pre-run (install, onboarding), day 0 … Wednesday, final checks (PLAN §13 calendar)
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

export const STAGES: readonly Stage[] = [boot];
