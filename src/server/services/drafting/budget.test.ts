import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@/server/db';
import { onAlert, type RaisedAlert } from '@/server/jobs/alert';
import { createJobRegistry } from '@/server/jobs/registry';
import { createJobTestRig, TEST_START, type JobTestRig } from '@/server/jobs/testing';
import { classifyLead } from '@/server/services/classification';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import { aiAccountShareMicroUsd, aiAccountSpendTodayMicroUsd, aiSpendTodayMicroUsd, isAiDailyBudgetTripped, utcDayStart } from './budget';
import { generateDraft } from './generate';
import { seedDraftableLead, seedDraftingAccount } from './testing';

// The AI daily budget breaker (D-36): today's (UTC) ai_calls spend at or over AI_DAILY_BUDGET_USD →
// no LLM call anywhere (classification → unclear, drafting → needs-touch template), one admin alert
// per UTC day.

const getDb = setUpTestDb();
const BUDGET_MICRO = 25_000_000; // AI_DAILY_BUDGET_USD default 25

let rig: JobTestRig;
let alerts: RaisedAlert[];
let stopAlerts: () => void;

beforeEach(() => {
  // PLAN §12: nothing here may read the wall clock, so the system time is far from the test's Clock.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = createJobTestRig(getDb(), createJobRegistry());
  alerts = [];
  stopAlerts = onAlert((alert) => alerts.push(alert));
});

afterEach(() => {
  stopAlerts();
  vi.useRealTimers();
});

async function spend(db: Db, costMicroUsd: number, at: Date, accountId: string | null = null): Promise<void> {
  await db.query(
    `insert into ai_calls (account_id, purpose, attempt, model, cost_micro_usd, outcome, created_at) values ($3, 'classify', 1, 'claude-haiku-4-5-20251001', $1, 'ok', $2)`,
    [costMicroUsd, at, accountId],
  );
}

function budgetAlerts(): RaisedAlert[] {
  return alerts.filter((alert) => alert.code === 'ai_daily_budget_reached');
}

describe('isAiDailyBudgetTripped', () => {
  it('trips exactly at the budget, counting only the current UTC day', async () => {
    const db = getDb();
    await spend(db, BUDGET_MICRO, new Date(utcDayStart(TEST_START).getTime() - 1)); // yesterday
    await spend(db, BUDGET_MICRO - 1, utcDayStart(TEST_START));
    expect(await aiSpendTodayMicroUsd(db, TEST_START)).toBe(BUDGET_MICRO - 1);
    expect(await isAiDailyBudgetTripped(rig.deps)).toBe(false);
    expect(budgetAlerts()).toEqual([]);

    await spend(db, 1, TEST_START);
    expect(await isAiDailyBudgetTripped(rig.deps)).toBe(true);
    expect(budgetAlerts()).toEqual([{ code: 'ai_daily_budget_reached', fields: { total: BUDGET_MICRO, limit: BUDGET_MICRO } }]);
  });

  it('alerts the admin once per UTC day, and resets at UTC midnight', async () => {
    const db = getDb();
    await spend(db, BUDGET_MICRO, TEST_START);
    expect(await isAiDailyBudgetTripped(rig.deps)).toBe(true);
    expect(await isAiDailyBudgetTripped(rig.deps)).toBe(true);
    expect(budgetAlerts()).toHaveLength(1);

    rig.clock.set(new Date(utcDayStart(TEST_START).getTime() + 86_400_000));
    expect(await isAiDailyBudgetTripped(rig.deps)).toBe(false);
    await spend(db, BUDGET_MICRO + 5, rig.clock.now());
    expect(await isAiDailyBudgetTripped(rig.deps)).toBe(true);
    expect(budgetAlerts()).toHaveLength(2);
  });

  it('follows AI_DAILY_BUDGET_USD', async () => {
    const db = getDb();
    const small = createJobTestRig(db, createJobRegistry(), { env: { AI_DAILY_BUDGET_USD: '0.50' } });
    await spend(db, 499_999, TEST_START);
    expect(await isAiDailyBudgetTripped(small.deps)).toBe(false);
    await spend(db, 1, TEST_START);
    expect(await isAiDailyBudgetTripped(small.deps)).toBe(true);
  });
});

describe('while the breaker is tripped', () => {
  it('drafting makes no LLM call and stores the needs-touch template', async () => {
    const db = getDb();
    const accountId = await seedDraftingAccount(db, { now: TEST_START });
    const { leadId } = await seedDraftableLead(db, { accountId, now: TEST_START });
    await spend(db, BUDGET_MICRO, TEST_START);
    const result = await generateDraft(rig.deps, { accountId, leadId, kind: 'initial' });
    expect(result).toMatchObject({ ok: false, needsTouch: true, reason: 'ai_budget', draft: { needsTouch: true, attempts: 0, model: null } });
    expect(rig.fakes.llm.calls).toEqual([]);
    expect(await db.query(`select id from ai_calls`)).toHaveLength(1);

    const second = await seedDraftableLead(db, { accountId, now: TEST_START });
    expect(await generateDraft(rig.deps, { accountId, leadId: second.leadId, kind: 'initial' })).toMatchObject({ reason: 'ai_budget' });
    expect(budgetAlerts()).toHaveLength(1);
  });

  it('classification answers unclear without a call (the M2 placeholder is wired to the breaker)', async () => {
    const db = getDb();
    const accountId = await seedDraftingAccount(db, { now: TEST_START });
    const { leadId } = await seedDraftableLead(db, { accountId, now: TEST_START });
    await spend(db, BUDGET_MICRO, TEST_START);
    const result = await classifyLead(rig.deps, { accountId, leadId, message: 'Hi, can you fix a leak?', formName: 'Contact us', firstName: 'Maya', company: null });
    expect(result).toEqual({ classification: 'unclear', failed: true });
    expect(rig.fakes.llm.calls).toEqual([]);
    expect(budgetAlerts()).toHaveLength(1);
  });

  it('a draft that pushes the spend over the budget stops the retry', async () => {
    const db = getDb();
    const accountId = await seedDraftingAccount(db, { now: TEST_START });
    const { leadId } = await seedDraftableLead(db, { accountId, now: TEST_START });
    await spend(db, BUDGET_MICRO - 1, TEST_START);
    rig.fakes.llm.injectFault('invalid', { purpose: 'draft' });
    const result = await generateDraft(rig.deps, { accountId, leadId, kind: 'initial' });
    expect(result).toMatchObject({ ok: false, reason: 'ai_budget', draft: { attempts: 1 } });
    expect(rig.fakes.llm.calls).toHaveLength(1);
  });
});

describe('the per-account share (D-36 addition: one tenant cannot use up the global budget)', () => {
  it('is a tenth of the budget, at least four typical draft calls per capped lead, at most the budget', () => {
    expect(aiAccountShareMicroUsd(rig.deps.env)).toBe(2_500_000);
    const small = createJobTestRig(getDb(), createJobRegistry(), { env: { AI_DAILY_BUDGET_USD: '5' } });
    // A tenth would be 500,000; the floor is 50 leads × 4 calls × 5,500.
    expect(aiAccountShareMicroUsd(small.deps.env)).toBe(1_100_000);
    const tiny = createJobTestRig(getDb(), createJobRegistry(), { env: { AI_DAILY_BUDGET_USD: '0.50' } });
    expect(aiAccountShareMicroUsd(tiny.deps.env)).toBe(500_000);
  });

  it('a flooded account stops making AI calls; another account still drafts, and the admin is alerted once per account and day', async () => {
    const db = getDb();
    const flooded = await seedDraftingAccount(db, { now: TEST_START });
    const other = await seedDraftingAccount(db, { now: TEST_START });
    await spend(db, 2_499_999, TEST_START, flooded);
    expect(await isAiDailyBudgetTripped(rig.deps, { accountId: flooded })).toBe(false);
    await spend(db, 1, TEST_START, flooded);
    expect(await aiAccountSpendTodayMicroUsd(db, flooded, TEST_START)).toBe(2_500_000);

    expect(await isAiDailyBudgetTripped(rig.deps, { accountId: flooded })).toBe(true);
    expect(await isAiDailyBudgetTripped(rig.deps, { accountId: flooded })).toBe(true);
    expect(await isAiDailyBudgetTripped(rig.deps, { accountId: other })).toBe(false);
    // The global breaker is not tripped: calls that belong to no account go on.
    expect(await isAiDailyBudgetTripped(rig.deps)).toBe(false);
    expect(alerts.filter((alert) => alert.code === 'ai_account_share_reached')).toEqual([
      { code: 'ai_account_share_reached', fields: { accountId: flooded, total: 2_500_000, limit: 2_500_000 } },
    ]);
    expect(budgetAlerts()).toEqual([]);

    // Classification and drafting for the flooded account: no call. For the other: calls as usual.
    const floodedLead = await seedDraftableLead(db, { accountId: flooded, now: TEST_START });
    expect(await classifyLead(rig.deps, { accountId: flooded, leadId: floodedLead.leadId, message: 'Hi', formName: 'Contact us', firstName: null, company: null })).toEqual({
      classification: 'unclear',
      failed: true,
    });
    expect(await generateDraft(rig.deps, { accountId: flooded, leadId: floodedLead.leadId, kind: 'initial' })).toMatchObject({ ok: false, reason: 'ai_budget' });
    expect(rig.fakes.llm.calls).toEqual([]);

    const otherLead = await seedDraftableLead(db, { accountId: other, now: TEST_START });
    expect(await generateDraft(rig.deps, { accountId: other, leadId: otherLead.leadId, kind: 'initial' })).toMatchObject({ ok: true });
    expect(rig.fakes.llm.callsFor('draft')).toHaveLength(1);

    // The next UTC day the flooded account starts again.
    rig.clock.set(new Date(utcDayStart(TEST_START).getTime() + 86_400_000));
    expect(await isAiDailyBudgetTripped(rig.deps, { accountId: flooded })).toBe(false);
  });
});
