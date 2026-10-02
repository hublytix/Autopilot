import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Settings } from 'luxon';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../../test/db/harness';
import { DAILY_CAP_ENV, DAILY_CAP_SCENARIO } from './daily-cap';
import { runSimulation, SIMULATION_START } from './run';
import { BOOT_STAGE, DAILY_CAP_STAGES, STAGES } from './stages';
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

// The full run takes a while (eight simulated days of 5-minute polls), so the stage 2–7 tests share
// one run (and its outbox directory); the 2030 run is the only other full run.
describe('simulation stages 2–7 (M2–M7): the real pre-run, Day 0 intake, drafts, new_lead emails, action links, follow-ups, the reply, the Monday report, the dashboard and the daily maintenance', () => {
  let fullDir: string;
  let summary: SimulationSummary;

  beforeAll(async () => {
    fullDir = await mkdtemp(path.join(tmpdir(), 'autopilot-sim-full-'));
    const db = await createTestDb();
    try {
      summary = await runSimulation({ outboxDir: fullDir, systemTime: null, db, stages: STAGES });
    } finally {
      await db.close();
    }
  }, 300_000);

  afterAll(async () => {
    await rm(fullDir, { recursive: true, force: true });
  });

  it('passes every check: 6 leads, #3 and #4 filtered, #5 found by the 10:35 cron poll, no historical lead, then 2 pre-run emails, new_lead ×4, follow_up ×4, follow_up ×3 + reply_detected, weekly_report ×1', async () => {
    expect(summary.checks.filter((check) => !check.ok)).toEqual([]);
    expect(summary.ok).toBe(true);
    expect(summary.stages.map((stage) => [stage.id, stage.milestone])).toEqual([
      ['boot', 'M1'],
      ['pre-run', 'M3'],
      ['day-0', 'M2'],
      ['day-0-emails', 'M4'],
      ['day-1', 'M5'],
      ['day-2', 'M5'],
      ['day-3', 'M5'],
      ['day-5', 'M5'],
      ['monday', 'M6'],
      ['wednesday', 'M6'],
      ['test-lead', 'M3'],
      ['daily-maintenance', 'M7'],
    ]);
    expect(summary.leads.map((lead) => [lead.ref, lead.classification, lead.processingState, lead.intakeTrigger, lead.isTest, lead.stopReason])).toEqual([
      ['L1', 'lead', 'notified', 'webhook', false, null],
      ['L2', 'unclear', 'notified', 'webhook', false, null],
      ['L3', 'spam', 'filtered', 'webhook', false, null],
      ['L4', 'vendor_pitch', 'filtered', 'webhook', false, null],
      ['L5', 'lead', 'notified', 'cron', false, null],
      // No lead is dismissed; #6's fu2 job recorded the reply.
      ['L6', 'lead', 'notified', 'webhook', false, 'replied'],
    ]);
    const owner = ['owner@brightside-plumbing.example'];
    expect(summary.emails.map((email) => [email.seq, email.at, email.kind, email.lead, email.to, email.file])).toEqual([
      [1, '2026-10-06T13:00:00.000Z', 'magic_link', null, owner, '001-magic_link'],
      [2, '2026-10-06T13:03:15.000Z', 'inbox_test', null, owner, '002-inbox_test'],
      // Day 0: each drafted lead's email as soon as lead_process finishes (#5 after the 10:35 cron poll).
      [3, '2026-10-06T14:00:00.000Z', 'new_lead', 'L1', owner, '003-new_lead-L1'],
      [4, '2026-10-06T14:05:00.000Z', 'new_lead', 'L2', owner, '004-new_lead-L2'],
      [5, '2026-10-06T14:20:00.000Z', 'new_lead', 'L6', owner, '005-new_lead-L6'],
      [6, '2026-10-06T14:35:00.000Z', 'new_lead', 'L5', owner, '006-new_lead-L5'],
      // Day 2 (Thu): follow-up 1 at each lead's T0 + 2 days, no quiet-hours shift.
      [7, '2026-10-08T14:00:00.000Z', 'follow_up', 'L1', owner, '007-follow_up-L1'],
      [8, '2026-10-08T14:05:00.000Z', 'follow_up', 'L2', owner, '008-follow_up-L2'],
      [9, '2026-10-08T14:20:00.000Z', 'follow_up', 'L6', owner, '009-follow_up-L6'],
      [10, '2026-10-08T14:35:00.000Z', 'follow_up', 'L5', owner, '010-follow_up-L5'],
      // Day 5 (Sun): follow-up 2, and #6's job finds Friday's reply instead.
      [11, '2026-10-11T14:00:00.000Z', 'follow_up', 'L1', owner, '011-follow_up-L1'],
      [12, '2026-10-11T14:05:00.000Z', 'follow_up', 'L2', owner, '012-follow_up-L2'],
      [13, '2026-10-11T14:20:00.000Z', 'reply_detected', 'L6', owner, '013-reply_detected-L6'],
      [14, '2026-10-11T14:35:00.000Z', 'follow_up', 'L5', owner, '014-follow_up-L5'],
      // Monday: the report, after the due-check at 08:00 local and the portal's stagger.
      [15, '2026-10-12T12:15:03.000Z', 'weekly_report', null, owner, '015-weekly_report'],
    ]);
    expect(summary.emails.slice(2).map((email) => email.subject)).toEqual([
      'New lead: Jordan — your reply is ready',
      'New lead: Alex — your reply is ready',
      'New lead: Riley — your reply is ready',
      'New lead: Lena — your reply is ready',
      'Follow-up 1 for Jordan — your draft is ready',
      'Follow-up 1 for Alex — your draft is ready',
      'Follow-up 1 for Riley — your draft is ready',
      'Follow-up 1 for Lena — your draft is ready',
      'Follow-up 2 for Jordan — your draft is ready',
      'Follow-up 2 for Alex — your draft is ready',
      'Riley replied — follow-ups stopped',
      'Follow-up 2 for Lena — your draft is ready',
      'Hublytix Autopilot weekly report: Mon 5 Oct – Mon 12 Oct',
    ]);
    // Every email is in the outbox directory as NNN-<kind>[-<lead ref>].html and .txt.
    expect((await readdir(fullDir)).sort()).toEqual([
      ...summary.emails.flatMap((email) => [`${email.file}.html`, `${email.file}.txt`]),
      'summary.json',
    ]);
    // Only #2's follow-ups say the first reply is unconfirmed; nobody gets the replies-not-logged note (log_all).
    const unconfirmed = await Promise.all(
      summary.emails.filter((email) => email.kind === 'follow_up').map(async (email) => [email.file, (await readFile(path.join(fullDir, `${email.file}.txt`), 'utf8')).includes("We couldn't confirm in HubSpot that your first reply was sent.")]),
    );
    expect(unconfirmed.filter(([, has]) => has).map(([file]) => file)).toEqual(['008-follow_up-L2', '012-follow_up-L2']);
    expect(summary.clock).toEqual({ start: '2026-10-06T13:00:00.000Z', end: '2026-10-14T16:00:00.000Z' });
    // No database id (account, lead, job, user) anywhere; the fixture's form ids are UUID-shaped but fixed.
    expect(JSON.stringify(summary).replaceAll(/b1f0c6a2-3d4e-4f50-8a61-7b2c9d0e1f0[1-3]/g, 'form')).not.toMatch(UUID);
  });

  it('runs the pre-run owner steps at the PLAN §13 times, with the background work done by 09:06', () => {
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

  it('records every tick and intake trigger in time order, events before ticks at the same instant', () => {
    const times = summary.timeline.map((entry) => entry.at);
    expect([...times].sort()).toEqual(times);

    const day0Polls = summary.timeline.filter((entry) => entry.name === 'cron.poll' && entry.local.startsWith('Tue')).map((entry) => entry.local.slice(15, 20));
    expect(day0Polls.slice(0, 22)).toEqual(['09:00', '09:05', '09:10', '09:15', '09:20', '09:25', '09:30', '09:35', '09:40', '09:45', '09:50', '09:55',
      '10:00', '10:05', '10:10', '10:15', '10:20', '10:25', '10:30', '10:35', '10:40', '10:45']);
    // Every 5 minutes from Tue 09:00 to Wed 10-14 12:00 local, none missed.
    expect(summary.timeline.filter((entry) => entry.name === 'cron.poll')).toHaveLength((8 * 24 * 60 + 180) / 5 + 1);
    // The hourly due-check (M6): nothing is due until Monday 08:00 local, which creates the report;
    // the rest of Monday finds it existing; Tuesday and Wednesday are not due. The daily 03:17 UTC
    // run (M7) goes through the real route: one account_daily job a day, done, sending nothing.
    const weekly = summary.timeline.filter((entry) => entry.name === 'cron.weekly_report');
    expect(weekly.slice(0, 2).map((entry) => entry.local.slice(15, 20))).toEqual(['09:00', '10:00']);
    expect(weekly).toHaveLength(8 * 24 + 4);
    expect(weekly.every((entry) => entry.detail?.httpStatus === 200 && entry.detail.errors === 0)).toBe(true);
    const created = weekly.filter((entry) => entry.detail?.created === 1);
    expect(created.map((entry) => [entry.local, entry.detail?.published])).toEqual([['Mon 2026-10-12 08:00:00', 1]]);
    const existing = weekly.filter((entry) => entry.detail?.existing === 1).map((entry) => entry.local.slice(15, 20));
    expect(existing).toEqual(['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '21:00', '22:00', '23:00']);
    expect(weekly.filter((entry) => entry.detail?.due === 1)).toHaveLength(16);
    const daily = summary.timeline.filter((entry) => entry.name === 'cron.daily');
    expect(daily.map((entry) => entry.at.slice(0, 10))).toEqual(['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14']);
    expect(daily.every((entry) => entry.at.endsWith('T03:17:00.000Z'))).toBe(true);
    expect(daily.every((entry) => entry.detail?.httpStatus === 200 && entry.detail.status === 'ran' && entry.detail.errors === 0 && entry.detail.jobsCreated === 1)).toBe(true);
    const dailyJobs = summary.timeline.filter((entry) => entry.name === 'job.account_daily');
    expect(dailyJobs.map((entry) => [entry.at, entry.detail?.jobStatus, entry.detail?.emailsSent, entry.detail?.leadsRead])).toEqual(
      daily.map((entry, i) => [entry.at, 'done', 0, i < 5 ? 0 : 3]),
    );
    expect(summary.checks.filter((check) => check.stage === 'daily-maintenance').map((check) => [check.id, check.ok])).toEqual([
      ['daily.ticks_every_day_at_0317_utc_through_the_real_route', true],
      ['daily.one_account_daily_job_per_day_for_the_account', true],
      ['daily.every_account_daily_job_done_right_after_its_tick', true],
      ['daily.account_daily_sends_nothing', true],
      ['daily.signal_refresh_reads_only_leads_whose_follow_ups_are_over', true],
      ['daily.retention_keeps_the_weeks_content', true],
      ['daily.lead_content_still_stored_within_30_days', true],
    ]);

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
    const at1000 = summary.timeline.filter((entry) => entry.local === 'Tue 2026-10-06 10:00:00').map((entry) => entry.name);
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

  it('runs the Day 0 owner steps at the PLAN §13 times: three Send taps (clicks), an edit, a dismiss page, every link resolving', () => {
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
  });

  it('runs Days 1–5 at the PLAN §13 times: #5 sent Wed, follow-up 1 Thu, #6 replies Fri, follow-up 2 and the reply detected Sun', () => {
    const steps = summary.timeline.filter((entry) => entry.stage.startsWith('day-') && !entry.stage.startsWith('day-0') && entry.kind === 'step');
    expect(steps.map((entry) => [entry.local.slice(0, 3) + entry.local.slice(15), entry.name, entry.detail?.lead ?? null])).toEqual([
      ['Wed10:00:00', 'new_lead.send_tapped', 'L5'],
      ['Wed10:01:00', 'new_lead.reply_sent_by_owner', 'L5'],
      ['Fri14:00:00', 'lead.replied_in_hubspot', 'L6'],
    ]);
    const followUpJobs = summary.timeline.filter((entry) => entry.name === 'job.followup').map((entry) => [entry.local.slice(0, 3) + entry.local.slice(15), entry.detail?.lead, entry.detail?.jobStatus]);
    expect(followUpJobs).toEqual([
      ['Thu10:00:00', 'L1', 'done'],
      ['Thu10:05:00', 'L2', 'done'],
      ['Thu10:20:00', 'L6', 'done'],
      ['Thu10:35:00', 'L5', 'done'],
      ['Sun10:00:00', 'L1', 'done'],
      ['Sun10:05:00', 'L2', 'done'],
      ['Sun10:20:00', 'L6', 'done'],
      ['Sun10:35:00', 'L5', 'done'],
    ]);
    const statuses = Object.fromEntries(summary.checks.filter((check) => check.id.endsWith('.statuses')).map((check) => [check.id, check.detail]));
    expect(statuses).toEqual({
      'day1.statuses': 'L1 send_clicked, L2 send_clicked, L3 filtered, L4 filtered, L6 send_clicked, L5 send_clicked',
      'day2.statuses': 'L1 send_confirmed, L2 send_clicked, L3 filtered, L4 filtered, L6 send_confirmed, L5 send_confirmed',
      'day3.statuses': 'L1 send_confirmed, L2 send_clicked, L3 filtered, L4 filtered, L6 send_confirmed, L5 send_confirmed',
      'day5.statuses': 'L1 send_confirmed, L2 send_clicked, L3 filtered, L4 filtered, L6 replied, L5 send_confirmed',
    });
    expect(summary.checks.find((check) => check.id === 'day2.send_confirmed_at_from_hubspot')?.detail).toBe('L1 Tue 10:13:00, L2 null, L5 Wed 10:01:00, L6 Tue 10:41:00');
    expect(summary.checks.find((check) => check.id === 'day5.L6.replied_at_is_the_reply_time')?.detail).toBe('replied_at Fri 14:00:00, stop_reason replied');
    expect(summary.checks.filter((check) => check.stage.startsWith('day-') && !check.stage.startsWith('day-0')).map((check) => check.id)).toEqual(
      expect.arrayContaining([
        'day3.nothing_sent',
        'day5.reply_detected_only_for_the_replier',
        'day5.L6.follow_ups_stopped_no_further_jobs',
        'day5.every_job_done_cancelled_or_skipped',
        'day5.outbox_is_14_emails_2_4_4_4',
        'day2.L2.follow_up_1_says_the_first_reply_is_unconfirmed',
        'day5.L2.follow_up_2_says_the_first_reply_is_unconfirmed',
        'day2.no_replies_not_logged_note',
        'day5.no_replies_not_logged_note',
      ]),
    );
  });

  it('runs Monday and Wednesday at the PLAN §13 times: the report with the exact metrics JSON, no emails after it, the final statuses and the dashboard', () => {
    // PLAN §13 "Expected weekly metrics" (the full JSON), the waiting lead named by its ref.
    expect(summary.weeklyReport).toEqual({
      version: 1,
      period: { start: '2026-10-05T12:00:00.000Z', end: '2026-10-12T12:00:00.000Z' },
      basis: { loggingMode: 'log_all', emailScope: true, sendsLogged: true, repliesLogged: true },
      cohort: {
        leadsIn: 6,
        filtered: 2,
        draftsEmailed: 4,
        sendsConfirmed: 3,
        sendLinkOpenedNotConfirmed: 1,
        medianTimeToFirstReply: { seconds: 21 * 60, samples: 3 },
        waiting: { count: 1, leads: [{ leadId: 'L2', submittedAt: '2026-10-06T14:05:00.000Z', recordUrl: 'https://app.hubspot.com/contacts/1234567/record/0-1/1003' }], more: 0 },
        unchecked: 0,
      },
      events: { repliesFromLeads: 1, followUpsDrafted: 7 },
      comparison: { baseline: 'ok', baselineMedianSeconds: 3.5 * 3600, baselinePercentWithoutReply: 20, medianSeconds: 21 * 60, percentWithoutReply: 25, population: 4, withoutReply: 1 },
    });
    // (The daily maintenance's own account_daily jobs are checked by the daily-maintenance stage.)
    const steps = summary.timeline.filter((entry) => (entry.stage === 'monday' || entry.stage === 'wednesday') && entry.kind !== 'tick' && entry.name !== 'job.account_daily');
    expect(steps.map((entry) => [entry.local, entry.name, entry.detail?.jobStatus ?? entry.detail?.from ?? null])).toEqual([
      ['Mon 2026-10-12 08:15:03', 'job.weekly_report', 'done'],
      ['Mon 2026-10-12 09:30:00', 'dashboard.opened_by_owner', 'weekly_report'],
    ]);
    const m6 = summary.checks.filter((check) => check.stage === 'monday' || check.stage === 'wednesday');
    expect(m6.every((check) => check.ok)).toBe(true);
    expect(m6.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        'monday.due_check_at_0800_local_creates_one_staggered_job',
        'monday.one_weekly_report_email_after_0800',
        'monday.weekly_metrics_json_exactly_as_plan_13',
        'wednesday.no_emails_since_monday',
        'wednesday.final_statuses',
        'wednesday.outbox_is_15_emails_2_4_4_4_1',
        'wednesday.every_job_done_cancelled_or_skipped',
        'wednesday.dashboard_lists_the_6_leads_with_their_final_statuses',
        'wednesday.L6.lead_page_offers_resume_follow_ups',
        'wednesday.L6.reply_detected_email_links_the_lead_page',
      ]),
    );
    expect(summary.checks.find((check) => check.id === 'wednesday.final_statuses')?.detail).toBe(
      'L1 no_reply, L2 no_reply, L3 filtered, L4 filtered, L6 replied, L5 no_reply',
    );
    expect(summary.checks.filter((check) => check.stage === 'test-lead').map((check) => check.id)).toEqual(
      expect.arrayContaining(['test_lead.absent_from_the_dashboard', 'test_lead.absent_from_every_weekly_report', 'test_lead.never_read_for_signals']),
    );
  });

  it('produces the same summary with the system time set to 2030 (it never reads the wall clock)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    const in2030 = await run('2030');
    expect(in2030.systemTime).toBe('2030');
    expect(in2030.ok).toBe(true);
    expect({ ...in2030, systemTime: null }).toEqual(summary);
  }, 300_000);
});

describe('the daily-cap variant (M6, MAX_DRAFTED_LEADS_PER_DAY=1)', () => {
  it('drafts #1 only, defers #2 #5 #6 with exactly one lead_cap email, and lists them on the dashboard as Not processed', async () => {
    const db = await createTestDb();
    let summary: SimulationSummary;
    try {
      summary = await runSimulation({ outboxDir, systemTime: null, db, stages: DAILY_CAP_STAGES, scenario: DAILY_CAP_SCENARIO, env: DAILY_CAP_ENV });
    } finally {
      await db.close();
    }
    expect(summary.checks.filter((check) => !check.ok)).toEqual([]);
    expect(summary.scenario).toBe('brightside-plumbing-daily-cap');
    expect(summary.emails.map((email) => [email.kind, email.lead])).toEqual([
      ['magic_link', null],
      ['inbox_test', null],
      ['new_lead', 'L1'],
      ['lead_cap', null],
    ]);
    expect(summary.leads.map((lead) => [lead.ref, lead.processingState])).toEqual([
      ['L1', 'notified'],
      ['L2', 'deferred'],
      ['L3', 'filtered'],
      ['L4', 'filtered'],
      ['L5', 'deferred'],
      ['L6', 'deferred'],
    ]);
    expect(summary.checks.find((check) => check.id === 'cap.dashboard_lists_deferred_leads_as_not_processed')?.detail).toBe(
      'L1 Drafted, L2 Not processed (daily_cap), L3 Filtered, L4 Filtered, L6 Not processed (daily_cap), L5 Not processed (daily_cap)',
    );
    expect(summary.weeklyReport).toBeNull();
  }, 300_000);
});
