import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getJob } from '@/server/jobs/rows';
import { baselineFigures, baselineView, ensureBaselineStarted, median, percentWithout } from '@/server/services/baseline';
import { useTestDb as setUpTestDb } from '../db/harness';
import { createOnboardingRig, DAY, HOUR, MINUTE, selectForms, type OnboardingRig } from './support';

// The baseline job (PLAN §9.7, D-38) on the fixture portal: five genuine enquiries between
// 2026-09-10 and 09-29; four got a logged outbound EMAIL after 30 m, 2 h, 5 h and 26 h (median
// 3 h 30 m), one got none (20%). Classification runs in memory; only counts are stored.

const getDb = setUpTestDb();

let rig: OnboardingRig;

beforeEach(async () => {
  rig = await createOnboardingRig(getDb());
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface BaselineRow {
  status: string;
  submissions_read: number;
  leads_counted: number;
  median_seconds_to_first_outbound: number | null;
  without_outbound_count: number | null;
  percent_available: boolean;
}

async function baselines(): Promise<BaselineRow[]> {
  return getDb().query(
    `select status, submissions_read, leads_counted, median_seconds_to_first_outbound, without_outbound_count, percent_available
       from baselines where account_id = $1 order by created_at`,
    [rig.accountId],
  );
}

/** Starts the baseline and delivers its job (and any retries QStash would make) until none is queued. */
async function runBaseline(): Promise<void> {
  expect(await ensureBaselineStarted(rig.scope, rig.deps)).toBe('started');
  for (let guard = 0; guard < 10; guard += 1) {
    const next = rig.fakes.scheduler.nextRunAt();
    if (next === null) return;
    if (next.getTime() > rig.clock.now().getTime()) rig.clock.set(next);
    await rig.fakes.scheduler.runDue(rig.clock.now());
  }
  throw new Error('baseline job never finished');
}

async function jobStatus(): Promise<string> {
  const row = await getDb().one<{ id: string }>(
    `select id from scheduled_jobs where account_id = $1 and kind = 'baseline' order by created_at desc, id desc limit 1`,
    [rig.accountId],
  );
  return (await getJob(getDb(), row.id))?.status ?? 'missing';
}

describe('baseline figures', () => {
  it('takes the middle value, or the mean of the two middle values', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1800, 7200, 18000, 93600])).toBe(12600);
    expect(median([])).toBeNull();
  });

  it('gives a median only from 3 measured leads, and counts the leads without one', () => {
    expect(baselineFigures([600, null, 1200])).toEqual({ leadsCounted: 3, medianSecondsToFirstOutbound: null, withoutOutboundCount: 1 });
    expect(baselineFigures([600, 900, 1200, null])).toEqual({ leadsCounted: 4, medianSecondsToFirstOutbound: 900, withoutOutboundCount: 1 });
    expect(percentWithout(1, 5)).toBe(20);
    expect(percentWithout(1, 3)).toBe(33);
    expect(percentWithout(0, 0)).toBeNull();
  });
});

describe('the baseline job', () => {
  it('measures the fixture portal: 5 leads, median 3 h 30 m, 1 without a logged email (20%)', async () => {
    await selectForms(rig);
    await runBaseline();
    expect(await baselines()).toEqual([
      {
        status: 'ok',
        submissions_read: 5,
        leads_counted: 5,
        median_seconds_to_first_outbound: 3.5 * 3600,
        without_outbound_count: 1,
        percent_available: true,
      },
    ]);
    expect(await jobStatus()).toBe('done');
    const view = await baselineView(getDb(), rig.accountId);
    expect(view).toMatchObject({ state: 'done', reason: null, percentWithout: 20 });
  });

  it('classifies in memory: ai_calls rows without a lead, and no lead or content rows', async () => {
    await selectForms(rig);
    await runBaseline();
    const calls = await getDb().query<{ purpose: string; lead_id: string | null }>(`select purpose, lead_id from ai_calls where account_id = $1`, [rig.accountId]);
    expect(calls).toHaveLength(5);
    expect(calls.every((call) => call.purpose === 'baseline_classify' && call.lead_id === null)).toBe(true);
    expect(await getDb().query(`select id from leads`)).toEqual([]);
    expect(await getDb().query(`select lead_id from lead_messages`)).toEqual([]);
  });

  it('reads only the selected forms', async () => {
    await selectForms(rig, [rig.quote]);
    await runBaseline();
    // Quote form: Tom (2 h) and Sam (26 h): fewer than 3 measured leads, so no median.
    expect(await baselines()).toEqual([
      { status: 'ok', submissions_read: 2, leads_counted: 2, median_seconds_to_first_outbound: null, without_outbound_count: 0, percent_available: true },
    ]);
    // No median, but the share without a logged email is still shown.
    expect(await baselineView(getDb(), rig.accountId)).toMatchObject({ state: 'done', reason: null, percentWithout: 0 });
  });

  it('leaves out a lead whose contact no longer exists, so the share is over the leads it could check', async () => {
    const tom = rig.hubspot.contactIdByEmail('tom.reyes@example.org');
    if (tom === null) throw new Error('fixture contact missing');
    rig.hubspot.deleteContact(tom);
    await selectForms(rig);
    await runBaseline();
    // Tom (2 h) is gone: 30 m, 5 h and 26 h measured, one lead without a logged email.
    expect(await baselines()).toEqual([
      { status: 'ok', submissions_read: 5, leads_counted: 4, median_seconds_to_first_outbound: 5 * 3600, without_outbound_count: 1, percent_available: true },
    ]);
    expect(await baselineView(getDb(), rig.accountId)).toMatchObject({ state: 'done', reason: null, percentWithout: 25 });
  });

  it('stores "unavailable" when the 270 s budget runs out', async () => {
    await selectForms(rig);
    // Each page of submissions takes 271 s of Clock time: the budget is spent before the second form.
    const listSubmissions = rig.hubspot.listSubmissions.bind(rig.hubspot);
    vi.spyOn(rig.hubspot, 'listSubmissions').mockImplementation(async (...args) => {
      rig.clock.advance(271_000);
      return listSubmissions(...args);
    });
    await runBaseline();
    expect(await baselines()).toEqual([
      { status: 'unavailable', submissions_read: 0, leads_counted: 0, median_seconds_to_first_outbound: null, without_outbound_count: null, percent_available: false },
    ]);
    expect(await jobStatus()).toBe('done');
    expect(await baselineView(getDb(), rig.accountId)).toMatchObject({ state: 'done', reason: 'not_readable', percentWithout: null });
    expect(await getDb().query(`select id from ai_calls`)).toEqual([]);
  });

  it('says "Not enough data" above 500 submissions, without classifying any', async () => {
    await selectForms(rig);
    const start = rig.clock.now().getTime() - 20 * DAY;
    for (let index = 0; index < 501; index += 1) {
      rig.hubspot.submitForm({ formId: rig.contactUs, email: `visitor${index}@example.com`, message: 'Hello', at: new Date(start + index * MINUTE) });
    }
    await runBaseline();
    const [row] = await baselines();
    expect(row?.status).toBe('insufficient');
    expect(row?.submissions_read).toBeGreaterThan(500);
    expect(row?.leads_counted).toBe(0);
    expect(await getDb().query(`select id from ai_calls`)).toEqual([]);
    expect(await baselineView(getDb(), rig.accountId)).toMatchObject({ state: 'done', reason: 'too_many_submissions', percentWithout: null });
  });

  it('is unavailable without the email scope, keeping the lead count', async () => {
    await getDb().query(`update hubspot_connections set scopes = array_remove(scopes, 'sales-email-read') where id = $1`, [rig.connectionId]);
    await selectForms(rig);
    await runBaseline();
    expect(await baselines()).toEqual([
      { status: 'unavailable', submissions_read: 5, leads_counted: 5, median_seconds_to_first_outbound: null, without_outbound_count: null, percent_available: false },
    ]);
    expect(await baselineView(getDb(), rig.accountId)).toMatchObject({ state: 'done', reason: 'not_readable', percentWithout: null });
  });

  it('is unavailable when HubSpot refuses the email reads for a missing scope', async () => {
    rig.hubspot.setGrantedScopes(['oauth', 'crm.objects.contacts.read', 'forms']);
    await selectForms(rig);
    await runBaseline();
    expect((await baselines())[0]?.status).toBe('unavailable');
    expect(await jobStatus()).toBe('done');
  });

  it('says "Not enough logged history" when the portal logged no outbound email in 30 days', async () => {
    // Two months later the fixture's emails are outside the window; three new enquiries are not.
    rig.clock.advance(60 * DAY);
    await selectForms(rig);
    for (let index = 0; index < 3; index += 1) {
      rig.hubspot.submitForm({ formId: rig.contactUs, email: `new${index}@example.com`, message: 'Can you fix a leak?', at: new Date(rig.clock.now().getTime() - (index + 1) * DAY) });
    }
    await runBaseline();
    expect(await baselines()).toEqual([
      { status: 'insufficient', submissions_read: 3, leads_counted: 3, median_seconds_to_first_outbound: null, without_outbound_count: null, percent_available: false },
    ]);
    expect(await baselineView(getDb(), rig.accountId)).toMatchObject({ reason: 'no_logged_email' });
  });

  it('counts only a sent EMAIL to the lead after the submission', async () => {
    rig.clock.advance(60 * DAY);
    await selectForms(rig);
    const now = rig.clock.now().getTime();
    const leads = ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com'];
    leads.forEach((email, index) => rig.hubspot.submitForm({ formId: rig.contactUs, email, message: 'Leaking pipe', at: new Date(now - (10 - index) * DAY) }));
    const submittedA = now - 10 * DAY;
    rig.hubspot.logOwnerSend({ to: 'a@example.com', at: new Date(submittedA - HOUR) }); // before the submission: ignored
    rig.hubspot.logOwnerSend({ to: 'a@example.com', at: new Date(submittedA + 2 * HOUR) });
    rig.hubspot.logOwnerSend({ to: 'b@example.com', at: new Date(now - 9 * DAY + HOUR), status: 'BOUNCED' }); // not a confirmed send
    rig.hubspot.logOwnerSend({ to: 'c@example.com', at: new Date(now - 8 * DAY + 3 * HOUR) });
    rig.hubspot.logOwnerSend({ to: 'd@example.com', at: new Date(now - 7 * DAY + 4 * HOUR) });
    await runBaseline();
    expect(await baselines()).toEqual([
      { status: 'ok', submissions_read: 4, leads_counted: 4, median_seconds_to_first_outbound: 3 * 3600, without_outbound_count: 1, percent_available: true },
    ]);
  });

  it('leaves spam out of the lead count', async () => {
    await selectForms(rig);
    rig.hubspot.submitForm({ formId: rig.contactUs, email: 'promo@example.com', message: 'Buy backlinks now, click here', at: new Date(rig.clock.now().getTime() - DAY) });
    await runBaseline();
    expect((await baselines())[0]).toMatchObject({ submissions_read: 6, leads_counted: 5 });
  });

  it('retries a HubSpot outage, and stores "unavailable" when it never recovers', async () => {
    await selectForms(rig);
    rig.hubspot.injectFailure('listSubmissions', { kind: 'server_error', times: 50 });
    await runBaseline();
    expect(await baselines()).toEqual([
      { status: 'unavailable', submissions_read: 0, leads_counted: 0, median_seconds_to_first_outbound: null, without_outbound_count: null, percent_available: false },
    ]);
    expect(await jobStatus()).toBe('failed');
  });

  it('recovers from a brief HubSpot outage on a later delivery', async () => {
    await selectForms(rig);
    rig.hubspot.injectFailure('listSubmissions', { kind: 'server_error', times: 1 });
    await runBaseline();
    expect(await baselines()).toHaveLength(1);
    expect((await baselines())[0]).toMatchObject({ status: 'ok', leads_counted: 5 });
  });

  it('skips the job when the connection was revoked meanwhile, storing nothing', async () => {
    await selectForms(rig);
    expect(await ensureBaselineStarted(rig.scope, rig.deps)).toBe('started');
    expect(await baselineView(getDb(), rig.accountId)).toEqual({ state: 'running' });
    await getDb().query(`update hubspot_connections set status = 'revoked', access_token_enc = null, refresh_token_enc = null where id = $1`, [rig.connectionId]);
    await rig.fakes.scheduler.runDue(rig.clock.now());
    expect(await jobStatus()).toBe('skipped');
    expect(await baselines()).toEqual([]);
    expect(await baselineView(getDb(), rig.accountId)).toEqual({ state: 'not_started' });
  });
});

describe('starting the baseline', () => {
  it('waits for a selected form', async () => {
    expect(await ensureBaselineStarted(rig.scope, rig.deps)).toBe('no_forms');
    expect(await getDb().query(`select id from scheduled_jobs where kind = 'baseline'`)).toEqual([]);
  });

  it('starts one job per account, keyed by the local date and the start number', async () => {
    await selectForms(rig);
    expect(await ensureBaselineStarted(rig.scope, rig.deps)).toBe('started');
    expect(await ensureBaselineStarted(rig.scope, rig.deps)).toBe('already_started');
    const jobs = await getDb().query<{ dedupe_key: string }>(`select dedupe_key from scheduled_jobs where kind = 'baseline'`);
    expect(jobs).toEqual([{ dedupe_key: `baseline:${rig.accountId}:2026-10-06:1` }]);
  });

  it('starts again the same day after a revoke skipped the first job and the owner reconnected', async () => {
    await selectForms(rig);
    expect(await ensureBaselineStarted(rig.scope, rig.deps)).toBe('started');
    const tokens = await getDb().one<{ access_token_enc: string; refresh_token_enc: string }>(
      `select access_token_enc, refresh_token_enc from hubspot_connections where id = $1`,
      [rig.connectionId],
    );
    await getDb().query(`update hubspot_connections set status = 'revoked', access_token_enc = null, refresh_token_enc = null where id = $1`, [rig.connectionId]);
    await rig.fakes.scheduler.runDue(rig.clock.now());
    expect(await jobStatus()).toBe('skipped');
    expect(await ensureBaselineStarted(rig.scope, rig.deps)).toBe('not_connected');

    // Reconnected within the same local day.
    rig.clock.advance(10 * MINUTE);
    await getDb().query(`update hubspot_connections set status = 'active', access_token_enc = $2, refresh_token_enc = $3 where id = $1`, [
      rig.connectionId,
      tokens.access_token_enc,
      tokens.refresh_token_enc,
    ]);
    await runBaseline();
    expect(await baselines()).toEqual([
      { status: 'ok', submissions_read: 5, leads_counted: 5, median_seconds_to_first_outbound: 3.5 * 3600, without_outbound_count: 1, percent_available: true },
    ]);
    const jobs = await getDb().query<{ dedupe_key: string; status: string }>(
      `select dedupe_key, status from scheduled_jobs where kind = 'baseline' order by created_at, dedupe_key`,
    );
    expect(jobs).toEqual([
      { dedupe_key: `baseline:${rig.accountId}:2026-10-06:1`, status: 'skipped' },
      { dedupe_key: `baseline:${rig.accountId}:2026-10-06:2`, status: 'done' },
    ]);
    expect(await ensureBaselineStarted(rig.scope, rig.deps)).toBe('already_started');
  });

  it('does not start again once a baseline exists', async () => {
    await selectForms(rig);
    await runBaseline();
    rig.clock.advance(DAY);
    expect(await ensureBaselineStarted(rig.scope, rig.deps)).toBe('already_started');
  });

  it('does not start without an active connection', async () => {
    await selectForms(rig);
    await getDb().query(`update hubspot_connections set status = 'revoked', access_token_enc = null, refresh_token_enc = null where id = $1`, [rig.connectionId]);
    expect(await ensureBaselineStarted(rig.scope, rig.deps)).toBe('not_connected');
  });
});
