import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Settings } from 'luxon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../../test/db/harness';
import { runSimulation, SIMULATION_START } from './run';
import { STAGES } from './stages';
import type { SimulationSummary, Stage } from './types';

let outboxDir: string;

beforeEach(async () => {
  outboxDir = await mkdtemp(path.join(tmpdir(), 'autopilot-sim-'));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(outboxDir, { recursive: true, force: true });
});

async function run(systemTime: string | null, stages: readonly Stage[] = STAGES): Promise<SimulationSummary> {
  const db = await createTestDb();
  try {
    return await runSimulation({ outboxDir, systemTime, db, stages });
  } finally {
    await db.close();
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Two leads inserted in reverse submission order (so neither insertion order nor their random ids
 * match the summary order) and an email tagged with the second lead's id, as M2+ stages will do.
 */
const leadsStage: Stage = {
  id: 'leads',
  milestone: 'M2',
  async run(sim) {
    const now = sim.clock.now();
    const account = await sim.db.one<{ id: string }>(
      `insert into public.accounts
         (hubspot_portal_id, processing_state_changed_at, trial_started_at, trial_ends_at, last_install_at, created_at)
       values ('1234567', $1, $1, $1, $1, $1) returning id`,
      [now],
    );
    const insert = (contactId: string, minutesAgo: number) =>
      sim.db.one<{ id: string }>(
        `insert into public.leads (account_id, hubspot_contact_id, form_id, submitted_at, intake_trigger, received_at)
         values ($1, $2, 'form-quote', $3, 'webhook', $4) returning id`,
        [account.id, contactId, new Date(now.getTime() - minutesAgo * 60_000), now],
      );
    const later = await insert('502', 1);
    await insert('501', 2);
    await sim.deps.mailer.send({
      to: ['owner@brightside-plumbing.example'],
      subject: 'New lead',
      html: '<p>Draft</p>',
      text: 'Draft',
      tags: [
        { name: 'kind', value: 'new_lead' },
        { name: 'lead', value: later.id },
      ],
      idempotencyKey: `sim:new_lead:${later.id}`,
    });
    sim.record('step', 'leads.seeded');
  },
};

describe('simulation stage 1 (M1)', () => {
  it('boots the fakes on a migrated PGlite at Tue 2026-10-06 09:00 New York and writes summary.json', async () => {
    const summary = await run(null);

    expect(summary).toMatchObject({
      scenario: 'brightside-plumbing-week',
      systemTime: null,
      clock: { start: '2026-10-06T13:00:00.000Z', end: '2026-10-06T13:00:00.000Z' },
      stages: [{ id: 'boot', milestone: 'M1', steps: 3, checks: 0 }],
      emails: [],
      leads: [],
      weeklyReport: null,
      checks: [],
      ok: true,
    });
    expect(summary.timeline.map((entry) => entry.name)).toEqual(['db.migrated', 'portal.loaded', 'fakes.ready']);
    expect(summary.timeline[0]).toMatchObject({ at: '2026-10-06T13:00:00.000Z', local: 'Tue 2026-10-06 09:00:00', stage: 'boot' });
    expect(summary.timeline[1]?.detail).toMatchObject({
      portalId: '1234567',
      timeZone: 'America/New_York',
      uiDomain: 'app.hubspot.com',
      ownerLoggingMode: 'log_all',
      forms: ['Contact us', 'Request a quote', 'Newsletter signup'],
      historicalSubmissions: 5,
      installed: false,
    });

    const written: unknown = JSON.parse(await readFile(path.join(outboxDir, 'summary.json'), 'utf8'));
    expect(written).toEqual(summary);
  });

  it('produces the same summary with the system time set to 2030 (it never reads the wall clock)', async () => {
    const baseline = await run(null);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    const in2030 = await run('2030');
    expect(in2030.systemTime).toBe('2030');
    expect({ ...in2030, systemTime: null }).toEqual(baseline);
  });

  it('names leads by stable refs, not their random ids, in the summary and the outbox files', async () => {
    const summary = await run(null, [...STAGES, leadsStage]);
    expect(summary.leads.map((lead) => [lead.ref, lead.hubspotContactId])).toEqual([
      ['L1', '501'],
      ['L2', '502'],
    ]);
    expect(summary.emails).toEqual([
      {
        seq: 1,
        at: '2026-10-06T13:00:00.000Z',
        kind: 'new_lead',
        lead: 'L2',
        to: ['owner@brightside-plumbing.example'],
        subject: 'New lead',
        file: '001-new_lead-L2',
      },
    ]);
    expect((await readdir(outboxDir)).sort()).toEqual(['001-new_lead-L2.html', '001-new_lead-L2.txt', 'summary.json']);
    expect(JSON.stringify(summary)).not.toMatch(UUID);
  });

  it('produces the same summary twice once leads exist, even with the system time set to 2030', async () => {
    const first = await run(null, [...STAGES, leadsStage]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    const second = await run(null, [...STAGES, leadsStage]);
    expect(second).toEqual(first);
  });

  it('clears what a previous run left in the outbox, and only that', async () => {
    await writeFile(path.join(outboxDir, '001-new_lead-1.html'), 'old');
    await writeFile(path.join(outboxDir, 'notes.md'), 'keep');
    await run(null);
    expect((await readdir(outboxDir)).sort()).toEqual(['notes.md', 'summary.json']);
  });

  it('puts Luxon back on its own clock afterwards', async () => {
    const before = Settings.now;
    await run(null);
    expect(Settings.now).toBe(before);
    expect(SIMULATION_START.toISOString()).toBe('2026-10-06T13:00:00.000Z');
  });
});
