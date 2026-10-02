import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Deps } from '@/server/ports';
import type { OwnerScope } from '@/server/services/auth/owner-scope';
import { leadProcessDedupeKey } from '@/server/services/leads/process';
import { runLeadControl, runPauseControl } from '@/server/actions/dashboard';
import { useTestDb as setUpTestDb } from '../db/harness';
import {
  accountSnapshot,
  at,
  createLeadsRig,
  HOUR,
  markRepliedLikeTheJob,
  seedFilteredLead,
  seedNotifiedLead,
  seedOtherAccount,
  seedOwnedAccount,
  type LeadsRig,
  type OwnedAccount,
} from './support';

// The dashboard's Server Actions (PLAN §7.5, §9.6, D-42): "This is a real lead" once, "Resume
// follow-ups" on a lead that replied, "Not a real lead", Pause all / Resume; each on the caller's
// OwnerScope, then post/redirect/get with an outcome code. The 'use server' wrappers are run with
// the session guard, Sentry and Next's redirect stubbed: Sentry gets no form data or response.

const current: { deps: Deps | null; scope: OwnerScope | null } = { deps: null, scope: null };
const sentry = vi.hoisted(() => ({ calls: [] as { name: string; options: Record<string, unknown> }[] }));

class Redirected extends Error {
  constructor(readonly path: string) {
    super('redirected');
  }
}

vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Redirected(path);
  },
}));
vi.mock('@sentry/nextjs', () => ({
  withServerActionInstrumentation: async (name: string, options: Record<string, unknown>, fn: () => Promise<unknown>) => {
    sentry.calls.push({ name, options });
    return fn();
  },
}));
vi.mock('@/server/actions/auth/context', () => ({
  requireOwnerAction: async () => {
    if (current.deps === null || current.scope === null) throw new Redirected('/login');
    return { deps: current.deps, scope: current.scope, request: new Request('http://localhost:3000/dashboard'), ip: '203.0.113.9' };
  },
}));

const getDb = setUpTestDb();
let rig: LeadsRig;
let owned: OwnedAccount;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = createLeadsRig(getDb());
  owned = await seedOwnedAccount(getDb(), { now: rig.clock.now() });
  current.deps = rig.deps;
  current.scope = owned.scope;
  sentry.calls = [];
});

afterEach(() => {
  vi.useRealTimers();
});

async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Redirected) return error.path;
    throw error;
  }
  throw new Error('no redirect');
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

describe('runLeadControl', () => {
  it('"This is a real lead" queues lead_process once; a second tap changes nothing', async () => {
    const leadId = await seedFilteredLead(getDb(), { accountId: owned.accountId, now: rig.clock.now() });
    expect(await runLeadControl(rig.deps, owned.scope, 'real_lead', leadId)).toBe(`/dashboard/leads/${leadId}?result=real_lead.queued`);
    expect(await runLeadControl(rig.deps, owned.scope, 'real_lead', leadId)).toBe(`/dashboard/leads/${leadId}?result=real_lead.not_filtered`);
    const jobs = await getDb().query<{ dedupe_key: string }>(`select dedupe_key from scheduled_jobs where lead_id = $1 and kind = 'lead_process'`, [leadId]);
    expect(jobs.map((job) => job.dedupe_key)).toEqual([leadProcessDedupeKey(leadId, 1)]);
  });

  it('"Resume follow-ups" on a lead that replied clears the reply and schedules a new stream', async () => {
    const db = getDb();
    const { leadId } = await seedNotifiedLead(rig, { accountId: owned.accountId, firstNotifiedAt: rig.clock.now() });
    await markRepliedLikeTheJob(db, leadId, at(rig.clock.now(), HOUR), at(rig.clock.now(), HOUR));
    rig.clock.advance({ hours: 2 });

    expect(await runLeadControl(rig.deps, owned.scope, 'resume_followups', leadId)).toBe(`/dashboard/leads/${leadId}?result=resume_followups.resumed`);
    expect(await db.one(`select replied_at, stop_reason, followup_stream from leads where id = $1`, [leadId])).toEqual({ replied_at: null, stop_reason: null, followup_stream: 1 });
    const jobs = await db.query<{ status: string; payload: { followupStream: number } }>(
      `select status, payload from scheduled_jobs where lead_id = $1 and kind = 'followup' and status = 'scheduled' order by seq`,
      [leadId],
    );
    expect(jobs.map((job) => job.payload.followupStream)).toEqual([1, 1]);
    // Nothing replied any more: a second tap is refused and changes nothing.
    expect(await runLeadControl(rig.deps, owned.scope, 'resume_followups', leadId)).toBe(`/dashboard/leads/${leadId}?result=resume_followups.not_replied`);
  });

  it('"Not a real lead" dismisses once and cancels the follow-ups', async () => {
    const db = getDb();
    const { leadId } = await seedNotifiedLead(rig, { accountId: owned.accountId, firstNotifiedAt: rig.clock.now() });
    expect(await runLeadControl(rig.deps, owned.scope, 'dismiss', leadId)).toBe(`/dashboard/leads/${leadId}?result=dismiss.dismissed`);
    expect(await runLeadControl(rig.deps, owned.scope, 'dismiss', leadId)).toBe(`/dashboard/leads/${leadId}?result=dismiss.already_dismissed`);
    const statuses = await db.query<{ status: string }>(`select status from scheduled_jobs where lead_id = $1 and kind = 'followup'`, [leadId]);
    expect(statuses.map((row) => row.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('a malformed id or another account\'s lead goes back to the dashboard and changes nothing', async () => {
    const db = getDb();
    const other = await seedOtherAccount(db, rig.clock.now());
    const theirs = await seedFilteredLead(db, { accountId: other.accountId, now: rig.clock.now() });
    const before = await accountSnapshot(db, other.accountId);
    for (const control of ['real_lead', 'resume_followups', 'dismiss'] as const) {
      expect(await runLeadControl(rig.deps, owned.scope, control, theirs)).toBe('/dashboard?result=lead_not_found');
      expect(await runLeadControl(rig.deps, owned.scope, control, 'x')).toBe('/dashboard?result=lead_not_found');
      expect(await runLeadControl(rig.deps, owned.scope, control, null)).toBe('/dashboard?result=lead_not_found');
    }
    expect(await accountSnapshot(db, other.accountId)).toEqual(before);
  });
});

describe('runPauseControl', () => {
  it('pauses and resumes the owner\'s account, saying when nothing changed', async () => {
    expect(await runPauseControl(rig.deps, owned.scope, true)).toBe('/dashboard?result=paused');
    expect(await runPauseControl(rig.deps, owned.scope, true)).toBe('/dashboard?result=already_paused');
    expect((await getDb().one<{ processing_state: string }>(`select processing_state from accounts where id = $1`, [owned.accountId])).processing_state).toBe('paused');
    expect(await runPauseControl(rig.deps, owned.scope, false)).toBe('/dashboard?result=resumed');
    expect(await runPauseControl(rig.deps, owned.scope, false)).toBe('/dashboard?result=not_paused');
  });

  it('says so when Resume leaves the account not running (e.g. billing inactive)', async () => {
    const db = getDb();
    await runPauseControl(rig.deps, owned.scope, true);
    await db.query(`update accounts set trial_started_at = $2, trial_ends_at = $3 where id = $1`, [owned.accountId, at(rig.clock.now(), -20 * 24 * HOUR), at(rig.clock.now(), -HOUR)]);
    expect(await runPauseControl(rig.deps, owned.scope, false)).toBe('/dashboard?result=resumed_not_active');
  });
});

describe('the Server Actions', () => {
  it('each lead control redirects to the lead page with its outcome; Sentry sees no form data and no response', async () => {
    const { markRealLeadAction, notARealLeadAction, resumeFollowUpsAction } = await import('@/server/actions/dashboard/lead');
    const filtered = await seedFilteredLead(getDb(), { accountId: owned.accountId, now: rig.clock.now() });
    expect(await redirectOf(() => markRealLeadAction(form({ lead_id: filtered })))).toBe(`/dashboard/leads/${filtered}?result=real_lead.queued`);
    expect(await redirectOf(() => resumeFollowUpsAction(form({ lead_id: filtered })))).toBe(`/dashboard/leads/${filtered}?result=resume_followups.not_notified`);
    expect(await redirectOf(() => notARealLeadAction(form({ lead_id: filtered })))).toBe(`/dashboard/leads/${filtered}?result=dismiss.dismissed`);
    expect(sentry.calls.map((call) => call.name)).toEqual(['dashboard.real_lead', 'dashboard.resume_followups', 'dashboard.dismiss']);
    for (const call of sentry.calls) expect(call.options).toEqual({ recordResponse: false });
  });

  it('without an owner session the action goes to /login and changes nothing', async () => {
    const { markRealLeadAction } = await import('@/server/actions/dashboard/lead');
    const filtered = await seedFilteredLead(getDb(), { accountId: owned.accountId, now: rig.clock.now() });
    current.scope = null;
    expect(await redirectOf(() => markRealLeadAction(form({ lead_id: filtered })))).toBe('/login');
    expect((await getDb().one<{ processing_state: string }>(`select processing_state from leads where id = $1`, [filtered])).processing_state).toBe('filtered');
  });

  it('Pause all and Resume redirect to the dashboard', async () => {
    const { pauseAllAction, resumeAllAction } = await import('@/server/actions/dashboard/account');
    expect(await redirectOf(() => pauseAllAction())).toBe('/dashboard?result=paused');
    expect(await redirectOf(() => resumeAllAction())).toBe('/dashboard?result=resumed');
  });

  it('saving the brief from the dashboard creates an owner version and comes back with ?saved; an invalid form keeps the input', async () => {
    const { saveDashboardBriefAction } = await import('@/server/actions/dashboard/brief');
    const valid = form({ company_name: 'Brightside Plumbing', sign_off_name: 'Dana', tone_style: 'friendly', booking_choice: 'none', services: 'Repairs\nBoilers' });
    const path = await redirectOf(() => saveDashboardBriefAction({ issues: [], values: null }, valid));
    const version = await getDb().one<{ version: number; source: string }>(
      `select version, source from brief_versions where account_id = $1 order by version desc limit 1`,
      [owned.accountId],
    );
    expect(version.source).toBe('owner');
    expect(path).toBe(`/dashboard/brief?saved=${version.version}`);

    const invalid = await saveDashboardBriefAction({ issues: [], values: null }, form({ company_name: '', sign_off_name: 'Dana', tone_style: 'friendly', booking_choice: 'none' }));
    expect(invalid.issues.map((issue) => issue.path)).toContain('company_name');
    expect(invalid.values?.sign_off_name).toBe('Dana');
  });
});
