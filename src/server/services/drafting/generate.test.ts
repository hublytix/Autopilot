import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeLLM } from '@/server/adapters/fake/llm/fake-llm';
import { InvalidModelParamsError } from '@/server/ai/model-params';
import { PermanentError, TransientError } from '@/server/domain/errors';
import { validateDraft } from '@/server/domain/validator';
import type { Db } from '@/server/db';
import { onAlert, type RaisedAlert } from '@/server/jobs/alert';
import { createJobRegistry } from '@/server/jobs/registry';
import { createJobTestRig, TEST_START, type JobTestRig } from '@/server/jobs/testing';
import type { DraftOutput, LLM } from '@/server/ports/llm';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import { fallbackDraft, generateDraft, type GenerateDraftResult } from './generate';
import { SAMPLE_BOOKING_LINK, SAMPLE_BRIEF, SAMPLE_MESSAGE, SAMPLE_SITE_URL, seedBrief, seedDraftableLead, seedDraftingAccount } from './testing';

// The draft engine (PLAN §9.3 step 5, D-24, D-36): LLM → Zod → validator, one retry, needs-touch
// template, ai_calls per attempt, one drafts row per (lead, kind). The FakeLLM checks every request
// against buildModelParams (the M2 assertion), so each call below also proves the parameters.

const getDb = setUpTestDb();

let rig: JobTestRig;
let alerts: RaisedAlert[];
let stopAlerts: () => void;

beforeEach(() => {
  rig = createJobTestRig(getDb(), createJobRegistry());
  alerts = [];
  stopAlerts = onAlert((alert) => alerts.push(alert));
});

afterEach(() => {
  stopAlerts();
});

interface DraftRow {
  subject: string | null;
  body: string | null;
  flags: string[];
  used_booking_link: boolean;
  validation_ok: boolean;
  validation_errors: string[];
  attempts: number;
  needs_touch: boolean;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_micro_usd: number;
  purge_at: Date;
}

interface AiCallRow {
  purpose: string;
  attempt: number;
  outcome: string;
  lead_id: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_micro_usd: number;
}

async function draftRows(db: Db, leadId: string): Promise<DraftRow[]> {
  return db.query<DraftRow>(`select * from drafts where lead_id = $1 order by kind`, [leadId]);
}

async function aiCalls(db: Db): Promise<AiCallRow[]> {
  return db.query<AiCallRow>(`select * from ai_calls order by id`);
}

async function seed(options: { firstName?: string | null; message?: string | null } = {}): Promise<{ accountId: string; leadId: string; purgeAt: Date }> {
  const db = getDb();
  const accountId = await seedDraftingAccount(db, { now: TEST_START });
  const lead = await seedDraftableLead(db, { accountId, now: TEST_START, ...options });
  return { accountId, ...lead };
}

/** Wraps the FakeLLM (its parameter assertion still runs) and swaps in scripted answers for the first calls. */
function scripted(fake: FakeLLM, answers: DraftOutput[]): LLM {
  const queue = [...answers];
  const swap = <T extends Awaited<ReturnType<LLM['draft']>>>(result: T): T => {
    const next = queue.shift();
    return next !== undefined && result.ok ? ({ ...result, value: next } as T) : result;
  };
  return {
    classify: (input, options) => fake.classify(input, options),
    generateBrief: (input, options) => fake.generateBrief(input, options),
    draft: async (input, options) => swap(await fake.draft(input, options)),
    draftFollowUp: async (input, options) => swap(await fake.draftFollowUp(input, options)),
  };
}

const PRICED: DraftOutput = {
  subject: 'Your leaking sink',
  body: `Hi Maya,\n\nA visit is $95. Pick a time: ${SAMPLE_BOOKING_LINK}\n\nDana`,
  used_booking_link: true,
  flags: [],
};

function expectNeedsTouch(result: GenerateDraftResult, reason: string): void {
  expect(result).toMatchObject({ ok: false, needsTouch: true, reason });
}

describe('generateDraft: the happy path', () => {
  it('drafts with the Sonnet draft parameters, stores the draft and records one ai_calls row', async () => {
    const db = getDb();
    const { accountId, leadId, purgeAt } = await seed();
    const result = await generateDraft(rig.deps, { accountId, leadId, kind: 'initial' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft).toMatchObject({ kind: 'initial', needsTouch: false, validationOk: true, attempts: 1, usedBookingLink: true, model: 'claude-sonnet-5-5' });
    expect(result.draft.body).toContain('Hi Maya,');
    expect(result.draft.body).toContain(SAMPLE_BOOKING_LINK);

    const [row] = await draftRows(db, leadId);
    expect(row).toMatchObject({ validation_ok: true, validation_errors: [], attempts: 1, needs_touch: false, model: 'claude-sonnet-5-5', purge_at: purgeAt, flags: ['urgent'] });
    expect(row?.input_tokens).toBeGreaterThan(0);
    expect(row?.cost_micro_usd).toBe(2 * (row?.input_tokens ?? 0) + 10 * (row?.output_tokens ?? 0));

    expect(await aiCalls(db)).toEqual([
      expect.objectContaining({ purpose: 'draft', attempt: 1, outcome: 'ok', lead_id: leadId, model: 'claude-sonnet-5-5', cost_micro_usd: row?.cost_micro_usd }),
    ]);
    // The request the live adapter would send (checked by the FakeLLM's buildModelParams assertion).
    expect(rig.fakes.llm.calls.map((call) => call.request)).toEqual([{ purpose: 'draft', model: 'claude-sonnet-5-5', previousErrorCodes: [], maxTokens: 1024 }]);
  });

  it('gives the model only the safe first name, the lead fields and the brief in force', async () => {
    const { accountId, leadId } = await seed({ firstName: 'Visit evil.example.org' });
    const result = await generateDraft(rig.deps, { accountId, leadId, kind: 'initial' });
    expect(result.ok).toBe(true);
    const input = rig.fakes.llm.calls[0]?.input as { lead: Record<string, unknown>; brief: Record<string, unknown> };
    expect(input.lead).toEqual({ firstName: null, company: 'Okafor Bakery', message: SAMPLE_MESSAGE, formName: 'Contact us' });
    expect(input.brief).toMatchObject({ company_name: 'Brightside Plumbing', booking_link: SAMPLE_BOOKING_LINK });
  });

  it('withholds a booking link the owner has not confirmed, or chose not to use', async () => {
    const db = getDb();
    for (const brief of [{ choice: 'link' as const, confirmed: false }, { choice: 'none' as const }]) {
      const { accountId, leadId } = await seed();
      await seedBrief(db, accountId, brief);
      const result = await generateDraft(rig.deps, { accountId, leadId, kind: 'initial' });
      expect(result).toMatchObject({ ok: true, draft: { usedBookingLink: false } });
      const input = rig.fakes.llm.calls.at(-1)?.input as { brief: { booking_link: unknown } };
      expect(input.brief.booking_link).toBeNull();
    }
  });

  it('returns the stored draft on a redelivery without another model call', async () => {
    const { accountId, leadId } = await seed();
    const first = await generateDraft(rig.deps, { accountId, leadId, kind: 'initial' });
    const again = await generateDraft(rig.deps, { accountId, leadId, kind: 'initial' });
    expect(again).toEqual(first);
    expect(rig.fakes.llm.calls).toHaveLength(1);
    expect(await aiCalls(getDb())).toHaveLength(1);
  });

  it('drafts a follow-up from the original first email (≤ 70 words)', async () => {
    const db = getDb();
    const { accountId, leadId } = await seed();
    const initial = await generateDraft(rig.deps, { accountId, leadId, kind: 'initial' });
    const followUp = await generateDraft(rig.deps, { accountId, leadId, kind: 'fu1' });
    expect(followUp).toMatchObject({ ok: true, draft: { kind: 'fu1', needsTouch: false } });
    if (!followUp.ok || !initial.ok) return;
    expect(followUp.draft.body.split(/\s+/).length).toBeLessThanOrEqual(70);
    const call = rig.fakes.llm.callsFor('followup')[0];
    expect(call?.request).toEqual({ purpose: 'followup', model: 'claude-sonnet-5-5', previousErrorCodes: [], followUpNumber: 1, maxTokens: 1024 });
    expect((call?.input as { original: unknown }).original).toEqual({ subject: initial.draft.subject, body: initial.draft.body });
    expect((await aiCalls(db)).map((row) => row.purpose)).toEqual(['draft', 'followup']);
    expect((await draftRows(db, leadId)).map((row) => row.needs_touch)).toEqual([false, false]);
  });
});

describe('generateDraft: one retry (brief §5.4, D-24)', () => {
  it('retries once with the validator codes as a fresh request, then stores the valid draft', async () => {
    const db = getDb();
    const { accountId, leadId } = await seed();
    const llm = scripted(rig.fakes.llm, [PRICED]);
    const result = await generateDraft({ ...rig.deps, llm }, { accountId, leadId, kind: 'initial' });
    expect(result).toMatchObject({ ok: true, draft: { attempts: 2, validationOk: true } });
    expect(rig.fakes.llm.calls.map((call) => call.request.previousErrorCodes)).toEqual([[], ['currency']]);
    expect((await aiCalls(db)).map((row) => [row.attempt, row.outcome])).toEqual([
      [1, 'validator_fail'],
      [2, 'ok'],
    ]);
    const [row] = await draftRows(db, leadId);
    const calls = await aiCalls(db);
    expect(row?.input_tokens).toBe(calls.reduce((sum, call) => sum + call.input_tokens, 0));
    expect(row?.cost_micro_usd).toBe(calls.reduce((sum, call) => sum + call.cost_micro_usd, 0));
  });

  it('validates and stores the text without bidi or invisible characters (no reordered or hidden words)', async () => {
    const db = getDb();
    const { accountId, leadId } = await seed();
    const rlo = String.fromCodePoint(0x202e);
    const pdf = String.fromCodePoint(0x202c);
    const zwsp = String.fromCodePoint(0x200b);
    const isolate = String.fromCodePoint(0x2066);
    const spoofed: DraftOutput = {
      subject: `Your ${rlo}knis gnikael${pdf}`,
      body: `Hi Maya,\r\n\r\nThanks for getting in touch. A le${zwsp}ak under a sink is worth a look; ${isolate}we can help.\n\nPick a time: ${SAMPLE_BOOKING_LINK}\n\nDana`,
      used_booking_link: true,
      flags: [],
    };
    const llm = scripted(rig.fakes.llm, [spoofed]);
    const result = await generateDraft({ ...rig.deps, llm }, { accountId, leadId, kind: 'initial' });
    expect(result).toMatchObject({ ok: true, draft: { attempts: 1, validationOk: true } });
    const [row] = await draftRows(db, leadId);
    expect(row?.subject).toBe('Your knis gnikael');
    expect(row?.body).toBe(`Hi Maya,\n\nThanks for getting in touch. A leak under a sink is worth a look; we can help.\n\nPick a time: ${SAMPLE_BOOKING_LINK}\n\nDana`);
  });

  it('retries after invalid output', async () => {
    const { accountId, leadId } = await seed();
    rig.fakes.llm.injectFault('invalid', { purpose: 'draft' });
    const result = await generateDraft(rig.deps, { accountId, leadId, kind: 'initial' });
    expect(result).toMatchObject({ ok: true, draft: { attempts: 2 } });
    expect(rig.fakes.llm.calls.map((call) => call.request.previousErrorCodes)).toEqual([[], ['invalid_output']]);
    expect((await aiCalls(getDb())).map((row) => row.outcome)).toEqual(['invalid_output', 'ok']);
  });

  it('a second validator failure stores the minimal safe template (needs touch) with the codes', async () => {
    const db = getDb();
    const { accountId, leadId } = await seed();
    const echo: DraftOutput = { ...PRICED, body: `Hi Maya,\n\n${SAMPLE_MESSAGE}\n\n${SAMPLE_BOOKING_LINK}` };
    const llm = scripted(rig.fakes.llm, [PRICED, echo]);
    const result = await generateDraft({ ...rig.deps, llm }, { accountId, leadId, kind: 'initial' });
    expectNeedsTouch(result, 'validation_failed');
    expect(rig.fakes.llm.calls).toHaveLength(2);
    const [row] = await draftRows(db, leadId);
    expect(row).toMatchObject({ needs_touch: true, validation_ok: false, validation_errors: ['echoes_lead'], attempts: 2, flags: [], used_booking_link: true });
    expect(row?.body).toContain('Hi Maya,');
    expect(row?.body).toContain(SAMPLE_BOOKING_LINK);
    expect(row?.body).not.toContain('$95');
    expect(
      validateDraft({ subject: row?.subject ?? '', body: row?.body ?? '' }, { kind: 'initial', brief: SAMPLE_BRIEF, firstName: 'Maya', leadMessage: SAMPLE_MESSAGE, siteUrl: SAMPLE_SITE_URL }),
    ).toEqual([]);
    expect((await db.one<{ needs_touch: boolean }>(`select needs_touch from leads where id = $1`, [leadId])).needs_touch).toBe(true);
  });

  it('max_tokens counts as the one retry: the retry gets the doubled budget, and a second cut-off is needs touch', async () => {
    const { accountId, leadId } = await seed();
    rig.fakes.llm.injectFault('max_tokens', { purpose: 'draft', times: 2 });
    const result = await generateDraft(rig.deps, { accountId, leadId, kind: 'initial' });
    expectNeedsTouch(result, 'max_tokens');
    expect(rig.fakes.llm.calls.map((call) => [call.request.previousErrorCodes, call.request.maxTokens])).toEqual([
      [[], 1024],
      [['max_tokens'], 2048],
    ]);
    expect((await aiCalls(getDb())).map((row) => row.outcome)).toEqual(['max_tokens', 'max_tokens']);
  });

  it('max_tokens then a valid answer is a draft after two attempts', async () => {
    const { accountId, leadId } = await seed();
    rig.fakes.llm.injectFault('max_tokens', { purpose: 'draft' });
    expect(await generateDraft(rig.deps, { accountId, leadId, kind: 'initial' })).toMatchObject({ ok: true, draft: { attempts: 2 } });
  });
});

describe('generateDraft: failures', () => {
  it('a refusal is needs touch at once, never retried', async () => {
    const db = getDb();
    const { accountId, leadId } = await seed();
    rig.fakes.llm.injectFault('refusal', { purpose: 'draft', refusalCategory: 'general_harms' });
    expectNeedsTouch(await generateDraft(rig.deps, { accountId, leadId, kind: 'initial' }), 'refusal');
    expect(rig.fakes.llm.calls).toHaveLength(1);
    expect(await aiCalls(db)).toEqual([expect.objectContaining({ outcome: 'refusal', attempt: 1 })]);
    expect((await draftRows(db, leadId))[0]).toMatchObject({ needs_touch: true, attempts: 1 });
    expect(alerts).toEqual([]);
  });

  it('a FATAL-CONFIG error is needs touch at once plus an admin alert', async () => {
    const { accountId, leadId } = await seed();
    rig.fakes.llm.injectFault('fatal', { purpose: 'draft', errorCode: 'spend_cap' });
    expectNeedsTouch(await generateDraft(rig.deps, { accountId, leadId, kind: 'initial' }), 'fatal_config');
    expect(rig.fakes.llm.calls).toHaveLength(1);
    expect(alerts).toEqual([{ code: 'ai_fatal_config', fields: { purpose: 'draft', model: 'claude-sonnet-5-5', errorCode: 'spend_cap' } }]);
  });

  it('a transient error throws TransientError (the job retries) after recording the attempt', async () => {
    const db = getDb();
    const { accountId, leadId } = await seed();
    rig.fakes.llm.injectFault('transient', { purpose: 'draft', retryAfterMs: 30_000 });
    const error = await generateDraft(rig.deps, { accountId, leadId, kind: 'initial' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ code: 'ai_draft_transient', retryAfterMs: 30_000 });
    expect(await aiCalls(db)).toEqual([expect.objectContaining({ outcome: 'transient' })]);
    expect(await draftRows(db, leadId)).toEqual([]);
    // The redelivery drafts normally.
    expect(await generateDraft(rig.deps, { accountId, leadId, kind: 'initial' })).toMatchObject({ ok: true });
  });

  it('a transient error on the final delivery is needs touch instead (never silent)', async () => {
    const { accountId, leadId } = await seed();
    rig.fakes.llm.injectFault('transient', { purpose: 'draft' });
    expectNeedsTouch(await generateDraft(rig.deps, { accountId, leadId, kind: 'initial', finalDelivery: true }), 'transient');
  });

  it('a lead without content, or without a row, is a permanent error', async () => {
    const db = getDb();
    const { accountId, leadId } = await seed();
    await db.query(`delete from lead_messages where lead_id = $1`, [leadId]);
    await expect(generateDraft(rig.deps, { accountId, leadId, kind: 'initial' })).rejects.toMatchObject({ code: 'draft_content_missing' });
    await expect(generateDraft(rig.deps, { accountId, leadId: '00000000-0000-4000-8000-000000000000', kind: 'initial' })).rejects.toBeInstanceOf(PermanentError);
    expect(rig.fakes.llm.calls).toHaveLength(0);
  });

  it('no brief in force: needs touch without a model call', async () => {
    const db = getDb();
    const { accountId, leadId } = await seed();
    await seedBrief(db, accountId, { choice: 'unset' });
    const result = await generateDraft(rig.deps, { accountId, leadId, kind: 'initial' });
    expectNeedsTouch(result, 'no_brief');
    expect(result.draft.body).toContain('Hi Maya,');
    expect(rig.fakes.llm.calls).toHaveLength(0);
  });

  it('runs the guard inside the storing transaction: a lost job stores nothing', async () => {
    const db = getDb();
    const { accountId, leadId } = await seed();
    const lost = async (): Promise<void> => {
      throw new PermanentError('job_lease_lost');
    };
    await expect(generateDraft(rig.deps, { accountId, leadId, kind: 'initial', guard: lost })).rejects.toMatchObject({ code: 'job_lease_lost' });
    expect(await draftRows(db, leadId)).toEqual([]);
  });

  it('lets an invalid parameter combination fail loudly (the FakeLLM assertion is active)', async () => {
    const { accountId, leadId } = await seed();
    const broken = new FakeLLM({ modelParams: { draftThinking: 'between_tools', draftEffort: 'max', draftMaxTokens: 1024, briefEffort: 'high' } });
    await expect(generateDraft({ ...rig.deps, llm: broken }, { accountId, leadId, kind: 'initial' })).rejects.toBeInstanceOf(InvalidModelParamsError);
    const unknownModel = new FakeLLM({ models: { draft: 'claude-opus-5' } });
    await expect(generateDraft({ ...rig.deps, llm: unknownModel }, { accountId, leadId, kind: 'initial' })).rejects.toThrow();
  });

  it('stores no content in ai_calls (law 4)', async () => {
    const { accountId, leadId } = await seed();
    rig.fakes.llm.injectFault('invalid', { purpose: 'draft' });
    await generateDraft(rig.deps, { accountId, leadId, kind: 'initial' });
    expect(JSON.stringify(await aiCalls(getDb()))).not.toMatch(/Maya|sink|Brightside|cal\.example/);
  });
});

describe('fallbackDraft (failure path, PLAN §8.3 step 6)', () => {
  it('stores the minimal safe template without any model call when no draft exists', async () => {
    const { accountId, leadId } = await seed();
    const result = await fallbackDraft(rig.deps, { accountId, leadId, kind: 'initial' });
    expectNeedsTouch(result, 'job_failed');
    expect(result.draft).toMatchObject({ needsTouch: true, attempts: 0, model: null, usedBookingLink: true });
    expect(rig.fakes.llm.calls).toHaveLength(0);
  });

  it('returns a stored draft unchanged', async () => {
    const { accountId, leadId } = await seed();
    const drafted = await generateDraft(rig.deps, { accountId, leadId, kind: 'initial' });
    expect(await fallbackDraft(rig.deps, { accountId, leadId, kind: 'initial' })).toEqual(drafted);
  });
});
