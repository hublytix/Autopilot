import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Settings } from 'luxon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../../test/db/harness';
import { runSimulation, SIMULATION_START } from './run';
import { BOOT_STAGE, STAGES } from './stages';
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

const BOOT_ONLY: readonly Stage[] = [BOOT_STAGE];

describe('simulation stage 1 (M1)', () => {
  it('boots the fakes on a migrated PGlite at Tue 2026-10-06 09:00 New York and writes summary.json', async () => {
    const summary = await run(null, BOOT_ONLY);

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

  it('names leads by stable refs, not their random ids, in the summary and the outbox files', async () => {
    const summary = await run(null, [...BOOT_ONLY, leadsStage]);
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
    const first = await run(null, [...BOOT_ONLY, leadsStage]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    const second = await run(null, [...BOOT_ONLY, leadsStage]);
    expect(second).toEqual(first);
  });

  it('clears what a previous run left in the outbox, and only that', async () => {
    await writeFile(path.join(outboxDir, '001-new_lead-1.html'), 'old');
    await writeFile(path.join(outboxDir, 'notes.md'), 'keep');
    await run(null, BOOT_ONLY);
    expect((await readdir(outboxDir)).sort()).toEqual(['notes.md', 'summary.json']);
  });

  it('puts Luxon back on its own clock afterwards', async () => {
    const before = Settings.now;
    await run(null, BOOT_ONLY);
    expect(Settings.now).toBe(before);
    expect(SIMULATION_START.toISOString()).toBe('2026-10-06T13:00:00.000Z');
  });
});

describe('simulation stages 2–4 (M2–M4): the real pre-run, Day 0 intake, drafts, new_lead emails and action links', () => {
  it('passes every check: 6 leads, #3 and #4 filtered, #5 found by the 10:35 cron poll, no historical lead, the 2 pre-run emails then new_lead ×4', async () => {
    const summary = await run(null);
    expect(summary.checks.filter((check) => !check.ok)).toEqual([]);
    expect(summary.ok).toBe(true);
    expect(summary.stages.map((stage) => [stage.id, stage.milestone])).toEqual([
      ['boot', 'M1'],
      ['pre-run', 'M3'],
      ['day-0', 'M2'],
      ['day-0-emails', 'M4'],
      ['test-lead', 'M3'],
    ]);
    expect(summary.leads.map((lead) => [lead.ref, lead.classification, lead.processingState, lead.intakeTrigger, lead.isTest])).toEqual([
      ['L1', 'lead', 'notified', 'webhook', false],
      ['L2', 'unclear', 'notified', 'webhook', false],
      ['L3', 'spam', 'filtered', 'webhook', false],
      ['L4', 'vendor_pitch', 'filtered', 'webhook', false],
      ['L5', 'lead', 'notified', 'cron', false],
      ['L6', 'lead', 'notified', 'webhook', false],
    ]);
    expect(summary.emails.map((email) => [email.seq, email.at, email.kind, email.lead, email.to, email.file])).toEqual([
      [1, '2026-10-06T13:00:00.000Z', 'magic_link', null, ['owner@brightside-plumbing.example'], '001-magic_link'],
      [2, '2026-10-06T13:03:15.000Z', 'inbox_test', null, ['owner@brightside-plumbing.example'], '002-inbox_test'],
      // Day 0: each drafted lead's email as soon as lead_process finishes (#5 after the 10:35 cron poll).
      [3, '2026-10-06T14:00:00.000Z', 'new_lead', 'L1', ['owner@brightside-plumbing.example'], '003-new_lead-L1'],
      [4, '2026-10-06T14:05:00.000Z', 'new_lead', 'L2', ['owner@brightside-plumbing.example'], '004-new_lead-L2'],
      [5, '2026-10-06T14:20:00.000Z', 'new_lead', 'L6', ['owner@brightside-plumbing.example'], '005-new_lead-L6'],
      [6, '2026-10-06T14:35:00.000Z', 'new_lead', 'L5', ['owner@brightside-plumbing.example'], '006-new_lead-L5'],
    ]);
    expect(summary.emails.slice(2).map((email) => email.subject)).toEqual([
      'New lead: Jordan — your reply is ready',
      'New lead: Alex — your reply is ready',
      'New lead: Riley — your reply is ready',
      'New lead: Lena — your reply is ready',
    ]);
    // Every email is in the outbox directory as NNN-<kind>[-<lead ref>].html and .txt.
    expect((await readdir(outboxDir)).sort()).toEqual([
      ...summary.emails.flatMap((email) => [`${email.file}.html`, `${email.file}.txt`]),
      'summary.json',
    ]);
    expect(summary.clock).toEqual({ start: '2026-10-06T13:00:00.000Z', end: '2026-10-06T14:45:00.000Z' });
    // No database id (account, lead, job, user) anywhere; the fixture's form ids are UUID-shaped but fixed.
    expect(JSON.stringify(summary).replaceAll(/b1f0c6a2-3d4e-4f50-8a61-7b2c9d0e1f0[1-3]/g, 'form')).not.toMatch(UUID);
  });

  it('runs the pre-run owner steps at the PLAN §13 times, with the background work done by 09:06', async () => {
    const summary = await run(null);
    const preRun = summary.timeline.filter((entry) => entry.stage === 'pre-run' && entry.kind !== 'tick');
    expect(preRun.map((entry) => [entry.local.slice(15), entry.name])).toEqual([
      ['09:00:00', 'install.completed'],
      ['09:00:00', 'onboarding_email.submitted'],
      ['09:00:30', 'owner.bound'],
      ['09:01:00', 'brief.generation_requested'],
      ['09:01:00', 'job.brief_generate'],
      ['09:01:30', 'forms.selected'],
      ['09:02:00', 'preferences.saved'],
      ['09:03:00', 'brief.saved'],
      ['09:03:15', 'inbox_check.started'],
      ['09:03:15', 'test_lead.created'],
      ['09:03:30', 'inbox_test.sent_by_owner'],
      ['09:04:15', 'job.inbox_check'],
      ['09:04:30', 'onboarding.completed'],
      // The baseline job waits for the per-portal limiter's next one-second window (FakeClock).
      ['09:04:31', 'job.baseline'],
      ['09:05:00', 'inbox_test.reply_from_test_address'],
      ['09:05:15', 'job.inbox_check'],
    ]);
    expect(preRun.find((entry) => entry.name === 'owner.bound')?.detail).toMatchObject({ via: 'magic_link', freshCookieJar: true, next: '/onboarding/brief' });
    expect(preRun.find((entry) => entry.name === 'forms.selected')?.detail).toEqual({ selected: ['Contact us', 'Request a quote'], unticked: ['Newsletter signup'] });
    expect(preRun.filter((entry) => entry.kind === 'job').every((entry) => entry.detail?.jobStatus === 'done')).toBe(true);
    // The test lead is in no list: not in leads[], and its timeline entry names no lead.
    expect(summary.leads.some((lead) => lead.isTest)).toBe(false);
    expect(preRun.find((entry) => entry.name === 'test_lead.created')?.detail).toEqual({ trigger: 'inbox_check' });
    expect(summary.checks.filter((check) => check.stage === 'pre-run' || check.stage === 'test-lead').map((check) => check.id)).toEqual(
      expect.arrayContaining([
        'prerun.owner_foreground_steps_within_5_minutes',
        'prerun.outbox_is_exactly_magic_link_and_inbox_test',
        'prerun.magic_link_on_fresh_cookie_jar_binds_owner',
        'prerun.floors_at_onboarding_complete_0904_30',
        'prerun.inbox_check_both_legs_log_all',
        'prerun.baseline_3h30m_and_20_percent',
        'prerun.no_historical_lead',
        'test_lead.absent_from_leads',
        'test_lead.no_lead_or_followup_jobs',
      ]),
    );
  });

  it('records every tick and intake trigger in time order, events before ticks at the same instant', async () => {
    const summary = await run(null);
    const times = summary.timeline.map((entry) => entry.at);
    expect([...times].sort()).toEqual(times);

    const polls = summary.timeline.filter((entry) => entry.name === 'cron.poll').map((entry) => entry.local.slice(15, 20));
    expect(polls).toEqual(['09:00', '09:05', '09:10', '09:15', '09:20', '09:25', '09:30', '09:35', '09:40', '09:45', '09:50', '09:55',
      '10:00', '10:05', '10:10', '10:15', '10:20', '10:25', '10:30', '10:35', '10:40', '10:45']);
    expect(summary.timeline.filter((entry) => entry.name === 'cron.weekly_report').map((entry) => entry.local.slice(15, 20))).toEqual(['09:00', '10:00']);

    const intake = summary.timeline.filter((entry) => entry.name === 'lead.created').map((entry) => [entry.local.slice(15, 20), entry.detail?.lead, entry.detail?.trigger]);
    expect(intake).toEqual([
      ['10:00', 'L1', 'webhook'],
      ['10:05', 'L2', 'webhook'],
      ['10:10', 'L3', 'webhook'],
      ['10:15', 'L4', 'webhook'],
      ['10:20', 'L6', 'webhook'],
      ['10:35', 'L5', 'cron'],
    ]);
    // At 10:00 the webhook and its portal_poll job come before the cron poll of the same minute.
    const at1000 = summary.timeline.filter((entry) => entry.local.endsWith('10:00:00')).map((entry) => entry.name);
    expect(at1000).toEqual([
      'portal.form_submitted',
      'webhook.object_creation',
      'job.portal_poll',
      'lead.created',
      'job.lead_process',
      'cron.poll',
      'cron.weekly_report',
    ]);
    expect(summary.timeline.filter((entry) => entry.name === 'webhook.object_creation')).toHaveLength(5);
  });

  it('runs the Day 0 owner steps at the PLAN §13 times: three Send taps (clicks), an edit, a dismiss page, every link resolving', async () => {
    const summary = await run(null);
    const owner = summary.timeline.filter(
      (entry) => (entry.stage === 'day-0' || entry.stage === 'day-0-emails') && entry.kind === 'step' && entry.name !== 'portal.form_submitted',
    );
    expect(owner.map((entry) => [entry.local.slice(15), entry.name, entry.detail?.lead ?? null])).toEqual([
      ['10:12:00', 'new_lead.send_tapped', 'L1'],
      ['10:13:00', 'new_lead.reply_sent_by_owner', 'L1'],
      ['10:30:00', 'new_lead.send_tapped', 'L2'],
      ['10:40:00', 'new_lead.send_tapped', 'L6'],
      ['10:41:00', 'new_lead.reply_sent_by_owner', 'L6'],
      ['10:42:00', 'new_lead.edited_by_owner', 'L1'],
      ['10:43:00', 'new_lead.dismiss_page_opened', 'L1'],
      ['10:43:00', 'inbox_test.dismissed_by_owner', null],
      ['10:44:00', 'new_lead.links_probed', null],
    ]);
    expect(owner.filter((entry) => entry.name === 'new_lead.send_tapped').every((entry) => entry.detail?.composeHost === 'mail.google.com')).toBe(true);
    const day0 = summary.checks.filter((check) => check.stage === 'day-0-emails');
    expect(day0.every((check) => check.ok)).toBe(true);
    expect(day0.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        'day0.outbox_is_the_2_pre_run_emails_then_4_new_lead',
        'day0.L1.send_click_recorded_at_the_tap',
        'day0.L2.send_click_recorded_at_the_tap',
        'day0.L6.send_click_recorded_at_the_tap',
        'day0.L5.no_click_recorded',
        'day0.L1.edited_text_neither_stored_nor_logged',
        'day0.L1.dismiss_page_asks_and_changes_nothing',
        'day0.L5.two_follow_ups_thu_and_sun_at_the_email_time',
        'day0.statuses_at_1045',
      ]),
    );
    expect(day0.find((check) => check.id === 'day0.statuses_at_1045')?.detail).toBe(
      'L1 send_clicked, L2 send_clicked, L3 filtered, L4 filtered, L6 send_clicked, L5 drafted',
    );
    // No lead is dismissed; the onboarding test lead (dismissed from its own email) is in no list.
    expect(summary.leads.map((lead) => lead.stopReason)).toEqual([null, null, null, null, null, null]);
  });

  it('produces the same summary with the system time set to 2030 (it never reads the wall clock)', async () => {
    const baseline = await run(null);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    const in2030 = await run('2030');
    expect(in2030.systemTime).toBe('2030');
    expect(in2030.ok).toBe(true);
    expect({ ...in2030, systemTime: null }).toEqual(baseline);
  });
});
