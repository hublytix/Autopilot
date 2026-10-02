import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE_BOOKING_LINK, FIXTURE_SITE_URL } from '@/server/adapters/fake/web-fetcher';
import { buildModelParams } from '@/server/ai/model-params';
import { onAlert, type RaisedAlert } from '@/server/jobs/alert';
import { runJob } from '@/server/jobs/dispatcher';
import { handleFailureCallback } from '@/server/jobs/failure';
import { createJobRegistry, type JobRegistry } from '@/server/jobs/registry';
import { getJob } from '@/server/jobs/rows';
import { createJobTestRig, seedAccount, type JobTestRig } from '@/server/jobs/testing';
import type { JobRow } from '@/server/jobs/types';
import type { Deps } from '@/server/ports';
import type { BriefDraft, GenerateBriefInput, GenerateBriefOptions, LLM, LlmResult } from '@/server/ports/llm';
import type { WebFetcher } from '@/server/ports/web-fetcher';
import { createOwnerScopeForTest, type OwnerScope } from '@/server/services/auth';
import { briefGenerateFailurePath, createBriefGenerateHandler } from '@/server/services/brief/job';
import { BRIEF_JOB_BUDGET_MS, BRIEF_JOBS_PER_DAY, MAX_FAQS, MIN_LLM_BUDGET_MS } from '@/server/services/brief/limits';
import { getLatestBrief } from '@/server/services/brief/repository';
import { briefGenerateDedupeKey, requestBriefGeneration } from '@/server/services/brief/request';
import { EMPTY_BRIEF } from '@/server/services/brief/schema';
import { useTestDb as setUpTestDb } from '../db/harness';

// The brief_generate job end to end (PLAN §8.2, §8.3, §9.7, D-24, D-36, D-47) on PGlite with the
// fixture site (FakeWebFetcher) and the FakeLLM, delivered through the FakeScheduler like fake mode.

const getDb = setUpTestDb();

const DECOY = 'https://discount-plumbing.example/book';

let registry: JobRegistry;
let rig: JobTestRig;
let accountId: string;
let scope: OwnerScope;
let alerts: RaisedAlert[];
let stopAlerts: () => void;

beforeEach(async () => {
  registry = createJobRegistry();
  registry.register('brief_generate', createBriefGenerateHandler());
  registry.registerFailurePath('brief_generate', briefGenerateFailurePath);
  rig = createJobTestRig(getDb(), registry);
  accountId = await seedAccount(getDb(), { now: rig.clock.now(), processingState: 'onboarding' });
  scope = createOwnerScopeForTest(accountId, randomUUID());
  alerts = [];
  stopAlerts = onAlert((alert) => alerts.push(alert));
});

afterEach(() => {
  stopAlerts();
});

async function request(url = FIXTURE_SITE_URL): Promise<string> {
  const result = await requestBriefGeneration(scope, rig.deps, { websiteUrl: url });
  if (!result.ok) throw new Error(`request refused: ${result.reason}`);
  return result.briefJobId;
}

async function briefJob(id: string): Promise<{ status: string; attempts: number; error_code: string | null }> {
  return getDb().one(`select status, attempts, error_code from brief_jobs where id = $1`, [id]);
}

async function scheduledJob(briefJobId: string): Promise<JobRow> {
  const row = await getDb().one<{ id: string }>(`select id from scheduled_jobs where dedupe_key = $1`, [briefGenerateDedupeKey(accountId, briefJobId)]);
  const job = await getJob(getDb(), row.id);
  if (job === null) throw new Error('job missing');
  return job;
}

async function versions(): Promise<{ version: number; source: string; brief: BriefDraft; booking_link_choice: string; booking_link_confirmed: boolean }[]> {
  return getDb().query(`select version, source, brief, booking_link_choice, booking_link_confirmed from brief_versions where account_id = $1 order by version`, [accountId]);
}

/** Delivers whatever is due now, then moves the clock to the next queued delivery (QStash's backoff). */
async function deliverNext(): Promise<void> {
  const next = rig.fakes.scheduler.nextRunAt();
  if (next !== null && next.getTime() > rig.clock.now().getTime()) rig.clock.set(next);
  await rig.fakes.scheduler.runDue(rig.clock.now());
}

/** An LLM whose brief is fixed (the model "says" whatever the test needs); the other methods are unused. */
function fixedBriefLlm(value: BriefDraft): LLM & { inputs: GenerateBriefInput[]; options: GenerateBriefOptions[] } {
  const inputs: GenerateBriefInput[] = [];
  const options: GenerateBriefOptions[] = [];
  const unused = (): never => {
    throw new Error('unused');
  };
  return {
    inputs,
    options,
    classify: unused,
    draft: unused,
    draftFollowUp: unused,
    generateBrief: async (input, opts): Promise<LlmResult<BriefDraft>> => {
      inputs.push(input);
      options.push(opts);
      return { ok: true, value, usage: { inputTokens: 1000, outputTokens: 200 }, stopReason: 'end_turn', model: 'claude-sonnet-5-5' };
    },
  };
}

function modelBrief(overrides: Partial<BriefDraft> = {}): BriefDraft {
  return {
    company_name: 'Brightside Plumbing',
    one_line: 'Family-run plumbers.',
    services: ['Emergency repairs'],
    who_we_serve: 'Homeowners',
    booking_link: FIXTURE_BOOKING_LINK,
    tone: { style: 'friendly', note: '' },
    sign_off_name: 'Dana Whitfield',
    allow_pricing: false,
    never_promise: [],
    faqs: [],
    ...overrides,
  };
}

/** Runs the queued brief job once with `deps` (bypassing the scheduler, so a stub LLM can be used). */
/** The fixture site, but the crawl's first fetch moves the Clock on by `ms` (a slow site). */
function crawlTaking(ms: number): WebFetcher {
  let advanced = false;
  return {
    fetch: async (url, options) => {
      if (!advanced) {
        advanced = true;
        rig.clock.advance(ms);
      }
      return rig.fakes.webFetcher.fetch(url, options);
    },
  };
}

async function runWith(deps: Deps, briefJobId: string): Promise<void> {
  const job = await scheduledJob(briefJobId);
  await runJob(deps, { jobId: job.id, messageId: job.externalId, retried: 0 }, registry);
}

describe('brief_generate: the happy path on the fixture site', () => {
  it('crawls the site, asks the model once and stores a generated version the editor opens with', async () => {
    const id = await request();
    await rig.fakes.scheduler.runDue(rig.clock.now());

    expect(await briefJob(id)).toEqual({ status: 'done', attempts: 1, error_code: null });
    expect((await scheduledJob(id)).status).toBe('done');
    const [stored, ...more] = await versions();
    expect(more).toEqual([]);
    expect(stored).toMatchObject({ version: 1, source: 'generated', booking_link_choice: 'link', booking_link_confirmed: false });
    expect(stored?.brief).toMatchObject({
      company_name: 'Brightside Plumbing',
      booking_link: FIXTURE_BOOKING_LINK,
      sign_off_name: 'Dana Whitfield',
      allow_pricing: false,
    });
    // The fixture FAQ page has 9 questions; the fake model returns all of them.
    expect(stored?.brief.faqs).toHaveLength(MAX_FAQS);

    const state = await getLatestBrief(scope, rig.deps);
    expect(state.form.origin).toBe('generated');
    expect(state.latest?.bookingLinkHost).toBe('cal.example.com');
    expect(state.saved).toBeNull();
    expect(state.job).toMatchObject({ id, status: 'done' });

    const calls = await getDb().query(`select purpose, attempt, outcome, lead_id from ai_calls where account_id = $1`, [accountId]);
    expect(calls).toEqual([{ purpose: 'brief', attempt: 1, outcome: 'ok', lead_id: null }]);
  });

  it('gives the model the homepage and the 8 ranked pages, never nav, scripts, hidden DOM or the injection sample', async () => {
    await request();
    await rig.fakes.scheduler.runDue(rig.clock.now());
    const [call] = rig.fakes.llm.callsFor('brief');
    const input = call?.input as GenerateBriefInput;
    expect(input.pages.map((page) => page.url.replace('https://brightside-plumbing.example', ''))).toEqual([
      '/',
      '/services',
      '/pricing',
      '/about',
      '/contact',
      '/faq',
      '/careers',
      '/blog/1',
      '/blog/2',
    ]);
    const all = input.pages.map((page) => page.text).join('\n');
    for (const fragment of ['Ignore previous', 'ignore previous', '50% discount', 'discount-plumbing', 'deals@', 'Note to', 'dataLayer', 'enable JavaScript', 'Staff area', 'Call the office', 'Internal rota']) {
      expect(all).not.toContain(fragment);
    }
    expect(all).toContain('Book a visit online: https://cal.example.com/brightside/visit');
  });

  it('passes what is left of the job budget as the call timeout', async () => {
    await request();
    await rig.fakes.scheduler.runDue(rig.clock.now());
    expect(rig.fakes.llm.callsFor('brief')[0]?.request).toMatchObject({ attempt: 0, timeoutMs: BRIEF_JOB_BUDGET_MS, maxTokens: 16000 });
  });

  it('subtracts the time the crawl took from the call timeout', async () => {
    const id = await request();
    await runWith({ ...rig.deps, webFetcher: crawlTaking(45_000) }, id);
    expect(rig.fakes.llm.callsFor('brief')[0]?.request).toMatchObject({ attempt: 0, timeoutMs: BRIEF_JOB_BUDGET_MS - 45_000 });
  });

  it('skips the model call when less than 20 s of the budget is left, and the next delivery takes the fallback', async () => {
    const id = await request();
    await runWith({ ...rig.deps, webFetcher: crawlTaking(BRIEF_JOB_BUDGET_MS - MIN_LLM_BUDGET_MS + 1) }, id);
    expect(rig.fakes.llm.callsFor('brief')).toEqual([]);
    expect(await briefJob(id)).toEqual({ status: 'running', attempts: 1, error_code: 'llm_budget_spent' });
    expect((await scheduledJob(id)).status).not.toBe('done');
    expect(await versions()).toEqual([]);

    // The retry starts a fresh budget and uses the fallback parameters (any delivery after the first).
    await deliverNext();
    expect(rig.fakes.llm.callsFor('brief')).toHaveLength(1);
    expect(rig.fakes.llm.callsFor('brief')[0]?.request).toMatchObject({ attempt: 1 });
    expect(await briefJob(id)).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('a redelivery after success does nothing', async () => {
    const id = await request();
    await rig.fakes.scheduler.runDue(rig.clock.now());
    const job = await scheduledJob(id);
    expect(await runJob(rig.deps, { jobId: job.id, messageId: job.externalId, retried: 1 }, registry)).toEqual({ status: 200, outcome: 'already_finished' });
    expect(rig.fakes.llm.callsFor('brief')).toHaveLength(1);
    expect(await versions()).toHaveLength(1);
  });
});

describe('brief_generate: post-processing whatever the model says (D-24, D-47)', () => {
  it('rejects a booking link that only the hidden DOM carries (the decoy), even when the model returns it', async () => {
    const id = await request();
    const llm = fixedBriefLlm(modelBrief({ booking_link: DECOY }));
    await runWith({ ...rig.deps, llm }, id);
    const [stored] = await versions();
    expect(stored?.brief.booking_link).toBeNull();
    expect(stored?.booking_link_choice).toBe('unset');
    // The decoy was never in what the model saw either.
    expect(llm.inputs[0]?.pages.map((page) => page.text).join('\n')).not.toContain('discount-plumbing');
  });

  it('keeps the visible booking link', async () => {
    const id = await request();
    await runWith({ ...rig.deps, llm: fixedBriefLlm(modelBrief()) }, id);
    expect((await versions())[0]?.brief.booking_link).toBe(FIXTURE_BOOKING_LINK);
  });

  it('caps FAQs at 8, forces allow_pricing off and trims never_promise', async () => {
    const id = await request();
    const faqs = Array.from({ length: 12 }, (_, i) => ({ q: `Question ${i}?`, a: `Answer ${i}.` }));
    await runWith({ ...rig.deps, llm: fixedBriefLlm(modelBrief({ faqs, allow_pricing: true, never_promise: ['  Discounts ', '', 'Discounts'] })) }, id);
    const brief = (await versions())[0]?.brief;
    expect(brief?.faqs).toHaveLength(8);
    expect(brief?.allow_pricing).toBe(false);
    expect(brief?.never_promise).toEqual(['Discounts']);
  });
});

describe('brief_generate: deliveries and model parameters (PLAN §9.7, D-24)', () => {
  it('first delivery adaptive / 16000; after a slow first attempt the second delivery uses between_tools / high / 4096', async () => {
    rig.fakes.llm.injectFault('slow', { purpose: 'brief' });
    const id = await request();

    await deliverNext();
    expect(await briefJob(id)).toEqual({ status: 'running', attempts: 1, error_code: 'llm_aborted' });
    expect((await scheduledJob(id)).status).toBe('scheduled');

    await deliverNext();
    expect(await briefJob(id)).toEqual({ status: 'done', attempts: 2, error_code: null });

    const [first, second] = rig.fakes.llm.callsFor('brief');
    expect(first?.request).toMatchObject({ attempt: 0, maxTokens: 16000 });
    expect(first?.outcome).toBe('transient');
    expect(second?.request).toMatchObject({ attempt: 1, maxTokens: 4096 });
    expect(second?.outcome).toBe('ok');

    // What the live adapter sends for those two requests.
    const params = (attempt: number) => buildModelParams({ model: 'claude-sonnet-5-5', purpose: 'brief', attempt: attempt + 1 }).params;
    expect(params(first?.request.attempt ?? -1)).toEqual({ max_tokens: 16000, thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
    expect(params(second?.request.attempt ?? -1)).toEqual({ max_tokens: 4096, thinking: { type: 'between_tools' }, output_config: { effort: 'high' } });

    const calls = await getDb().query(`select attempt, outcome from ai_calls where account_id = $1 order by id`, [accountId]);
    expect(calls).toEqual([
      { attempt: 1, outcome: 'transient' },
      { attempt: 2, outcome: 'ok' },
    ]);
  });

  it('treats max_tokens as the one retry, on the fallback parameters', async () => {
    rig.fakes.llm.injectFault('max_tokens', { purpose: 'brief' });
    const id = await request();
    await deliverNext();
    expect(await briefJob(id)).toMatchObject({ status: 'running', error_code: 'llm_max_tokens' });
    await deliverNext();
    expect(await briefJob(id)).toMatchObject({ status: 'done', attempts: 2 });
    expect(rig.fakes.llm.callsFor('brief').map((call) => call.request.maxTokens)).toEqual([16000, 4096]);
  });

  it('uses the fallback when the job was claimed before, even if the brief job was not counted (a crash)', async () => {
    const id = await request();
    const job = await scheduledJob(id);
    // A first claim that crashed before counting the delivery: the lease expired.
    await getDb().query(`update scheduled_jobs set status = 'running', attempts = 1, attempt_id = $2, lease_until = $3 where id = $1`, [
      job.id,
      randomUUID(),
      new Date(rig.clock.now().getTime() - 1000),
    ]);
    await runJob(rig.deps, { jobId: job.id, messageId: job.externalId, retried: 1 }, registry);
    expect(rig.fakes.llm.callsFor('brief')[0]?.request).toMatchObject({ attempt: 1, maxTokens: 4096 });
  });
});

describe('brief_generate: failures leave the editor empty', () => {
  it('a refusal fails the brief job at once (no retry) and the editor opens empty', async () => {
    rig.fakes.llm.injectFault('refusal', { purpose: 'brief' });
    const id = await request();
    await deliverNext();
    expect(await briefJob(id)).toEqual({ status: 'failed', attempts: 1, error_code: 'llm_refusal' });
    expect((await scheduledJob(id)).status).toBe('done');
    expect(rig.fakes.scheduler.pending()).toEqual([]);
    expect(await versions()).toEqual([]);
    const state = await getLatestBrief(scope, rig.deps);
    expect(state.form).toEqual({ brief: EMPTY_BRIEF, origin: 'empty', version: null });
    expect(state.job).toMatchObject({ id, status: 'failed', errorCode: 'llm_refusal' });
  });

  it('invalid output fails the brief job at once', async () => {
    rig.fakes.llm.injectFault('invalid', { purpose: 'brief' });
    const id = await request();
    await deliverNext();
    expect(await briefJob(id)).toMatchObject({ status: 'failed', error_code: 'llm_invalid_output' });
    expect(rig.fakes.llm.callsFor('brief')).toHaveLength(1);
  });

  it('after the final delivery of a transient failure the failure path fails the brief job', async () => {
    rig.fakes.llm.injectFault('transient', { purpose: 'brief', times: 5 });
    const id = await request();
    for (let delivery = 0; delivery < 5; delivery += 1) await deliverNext();
    expect(await briefJob(id)).toEqual({ status: 'failed', attempts: 5, error_code: 'brief_llm_transient' });
    expect((await scheduledJob(id)).status).toBe('failed');
    expect(rig.fakes.llm.callsFor('brief').map((call) => call.request.attempt)).toEqual([0, 1, 2, 3, 4]);
    expect(alerts.map((alert) => alert.code)).toContain('job_failed');
    expect((await getLatestBrief(scope, rig.deps)).form.origin).toBe('empty');
  });

  it('a fatal configuration error fails the job permanently with an admin alert', async () => {
    rig.fakes.llm.injectFault('fatal', { purpose: 'brief' });
    const id = await request();
    await deliverNext();
    expect(await briefJob(id)).toMatchObject({ status: 'failed', error_code: 'brief_llm_fatal_config' });
    expect((await scheduledJob(id)).status).toBe('failed');
    expect(alerts).toContainEqual(expect.objectContaining({ code: 'job_failed', fields: expect.objectContaining({ errorCode: 'brief_llm_fatal_config' }) as unknown }));
  });

  it('a homepage the SSRF guard refuses fails the brief job without calling the model', async () => {
    const id = await request('https://metadata.example/');
    await deliverNext();
    expect(await briefJob(id)).toMatchObject({ status: 'failed', error_code: 'site_blocked_by_ssrf' });
    expect(rig.fakes.llm.callsFor('brief')).toEqual([]);
  });

  it('a homepage answering 500 is retried, then failed after the final delivery', async () => {
    const id = await request('https://brightside-plumbing.example/broken');
    await deliverNext();
    expect(await briefJob(id)).toMatchObject({ status: 'running', error_code: 'site_http_error' });
    for (let delivery = 1; delivery < 5; delivery += 1) await deliverNext();
    expect(await briefJob(id)).toMatchObject({ status: 'failed', attempts: 5, error_code: 'brief_site_http_error' });
  });

  it('the QStash failure callback runs the same failure path', async () => {
    const id = await request();
    const job = await scheduledJob(id);
    expect(await handleFailureCallback(rig.deps, { jobId: job.id, sourceMessageId: job.externalId ?? '' }, registry)).toBe('won');
    expect(await briefJob(id)).toMatchObject({ status: 'failed', error_code: 'qstash_retries_exhausted' });
  });
});

describe('brief generation limits (D-36)', () => {
  it('allows one generation at a time', async () => {
    const id = await request();
    expect(await requestBriefGeneration(scope, rig.deps, { websiteUrl: FIXTURE_SITE_URL })).toEqual({ ok: false, reason: 'in_progress' });
    await rig.fakes.scheduler.runDue(rig.clock.now());
    expect(await briefJob(id)).toMatchObject({ status: 'done' });
    expect((await requestBriefGeneration(scope, rig.deps, { websiteUrl: FIXTURE_SITE_URL })).ok).toBe(true);
  });

  it('allows 5 per account in any 24 hours (counted from brief_jobs.created_at)', async () => {
    for (let i = 0; i < BRIEF_JOBS_PER_DAY; i += 1) {
      await request();
      await rig.fakes.scheduler.runDue(rig.clock.now());
      rig.clock.advance(60 * 60 * 1000);
    }
    expect(await requestBriefGeneration(scope, rig.deps, { websiteUrl: FIXTURE_SITE_URL })).toEqual({ ok: false, reason: 'daily_limit' });
    expect((await getLatestBrief(scope, rig.deps)).generation).toEqual({ inProgress: false, remainingToday: 0 });
    // 24 h after the first request, one slot is free again.
    rig.clock.advance(19 * 60 * 60 * 1000 + 1);
    expect((await requestBriefGeneration(scope, rig.deps, { websiteUrl: FIXTURE_SITE_URL })).ok).toBe(true);
  });

  it('counts failed generations too', async () => {
    rig.fakes.llm.injectFault('refusal', { purpose: 'brief', times: BRIEF_JOBS_PER_DAY });
    for (let i = 0; i < BRIEF_JOBS_PER_DAY; i += 1) {
      await request();
      await rig.fakes.scheduler.runDue(rig.clock.now());
    }
    expect(await requestBriefGeneration(scope, rig.deps, { websiteUrl: FIXTURE_SITE_URL })).toEqual({ ok: false, reason: 'daily_limit' });
  });

  it('keeps the limits per account', async () => {
    await request();
    const other = await seedAccount(getDb(), { now: rig.clock.now(), processingState: 'onboarding' });
    const otherScope = createOwnerScopeForTest(other, randomUUID());
    expect((await requestBriefGeneration(otherScope, rig.deps, { websiteUrl: FIXTURE_SITE_URL })).ok).toBe(true);
  });

  it('does not block on a generation whose job was cancelled', async () => {
    const id = await request();
    await getDb().query(`update scheduled_jobs set status = 'cancelled' where dedupe_key = $1`, [briefGenerateDedupeKey(accountId, id)]);
    expect((await getLatestBrief(scope, rig.deps)).job).toMatchObject({ id, status: 'failed', errorCode: 'job_lost' });
    expect((await requestBriefGeneration(scope, rig.deps, { websiteUrl: FIXTURE_SITE_URL })).ok).toBe(true);
  });

  it('refuses an address the crawler may not fetch before creating anything', async () => {
    for (const [websiteUrl, reason] of [
      ['localhost', 'site_url_not_allowed'],
      ['http://169.254.169.254/', 'site_url_not_allowed'],
      ['not a website', 'site_url_invalid'],
    ] as const) {
      expect(await requestBriefGeneration(scope, rig.deps, { websiteUrl })).toEqual({ ok: false, reason });
    }
    expect(await getDb().query(`select id from brief_jobs`)).toEqual([]);
    expect(await getDb().query(`select id from scheduled_jobs`)).toEqual([]);
  });

  it('records the address on the brief and publishes the job with ids only', async () => {
    const id = await request('brightside-plumbing.example');
    const job = await scheduledJob(id);
    expect(job).toMatchObject({ kind: 'brief_generate', accountId, payload: { briefJobId: id }, dedupeKey: `brief:${accountId}:${id}` });
    expect(job.externalId).not.toBeNull();
    expect(await getDb().one(`select source_url from briefs where account_id = $1`, [accountId])).toEqual({ source_url: FIXTURE_SITE_URL });
  });
});
