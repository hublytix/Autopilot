import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { DateTime } from 'luxon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLeadControl } from '@/server/actions/dashboard';
import { REQUIRED_SCOPES } from '@/server/hubspot/scopes';
import { runJob } from '@/server/jobs/dispatcher';
import { getJob } from '@/server/jobs/rows';
import type { Deps } from '@/server/ports';
import { seedSubscription } from '@/server/services/accounts/testing';
import { insertAuditOnce } from '@/server/services/audit/audit-log';
import { createOwnerScopeForTest, type OwnerScope } from '@/server/services/auth/owner-scope';
import { getBriefVersion, getLatestBrief, listBriefVersions, saveOwnerBrief } from '@/server/services/brief';
import { aiAccountShareMicroUsd, aiDailyBudgetMicroUsd } from '@/server/services/drafting/budget';
import { recordFollowUpFailedNote } from '@/server/services/followups/notes';
import { NotificationKeys } from '@/server/services/notifications/predicates';
import { getOnboardingGate, getPreferences } from '@/server/services/onboarding';
import { dismissLeadForOwner, markRealLead, pauseAll, resumeAll, resumeFollowUps } from '@/server/services/owner-controls';
import { registerWeeklyReportJob } from '@/server/services/reports/job';
import { scheduleWeeklyReports } from '@/server/services/reports/schedule';
import { dashboardBriefView, dashboardView, leadDetailView, refreshLeadSignals } from '@/server/views/dashboard';
import { loadInboxCheckPage } from '@/server/views/inbox';
import { baselinePageView, briefPageView, formsPageView, onboardingStatus, preferencesPageView } from '@/server/views/onboarding';
import { useTestDb as setUpTestDb } from '../db/harness';
import { accountSnapshot, seedDraft, seedLeadIn } from '../dashboard/support';
import { seedNewLead } from '../leads/support';
import { markRepliedLikeTheJob, seedNotifiedLead, seedOtherAccount, type OwnedAccount } from '../owner-controls/support';
import { createSignalsRig, DAY, HOUR, type SignalsRig } from '../signals/support';

// Tenant isolation (PLAN §10.8, §3): two accounts in one database. Every owner page, read model and
// Server Action built so far (the dashboard, the lead page, the brief page, the onboarding steps, the
// inbox check, the owner controls) runs as account A's owner with account B's ids. Each answers 404
// or a refusal, shows nothing of B's, and B's rows are byte-for-byte unchanged afterwards. Only the
// session guard, the container, Next's navigation and Sentry are stubbed: the services, the SQL and
// the pages are the real ones.

const current: { deps: Deps | null; scope: OwnerScope | null } = { deps: null, scope: null };

class Navigation extends Error {
  constructor(
    readonly kind: 'redirect' | 'not_found',
    readonly path: string | null,
  ) {
    super(kind);
  }
}

vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Navigation('redirect', path);
  },
  notFound: () => {
    throw new Navigation('not_found', null);
  },
  useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock('@sentry/nextjs', () => ({
  withServerActionInstrumentation: async (_name: string, _options: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@/server/container', () => ({
  getDeps: async () => {
    if (current.deps === null) throw new Error('no deps');
    return current.deps;
  },
}));
vi.mock('@/server/http/auth/guards', async (original) => ({
  ...(await original<typeof import('@/server/http/auth/guards')>()),
  requireOwnerPage: async () => {
    if (current.scope === null) throw new Navigation('redirect', '/login');
    return current.scope;
  },
  ownerFromHeaders: async () => current.scope,
}));
vi.mock('@/server/actions/auth/context', () => {
  const context = () => {
    if (current.deps === null || current.scope === null) throw new Navigation('redirect', '/login');
    return { deps: current.deps, scope: current.scope, request: new Request('http://localhost:3000/dashboard'), ip: '203.0.113.7' };
  };
  return { actionContext: async () => context(), requireOwnerAction: async () => context() };
});

const getDb = setUpTestDb();
let rig: SignalsRig;
/** Account A: the signed-in owner (installed on the fake portal). */
let scopeA: OwnerScope;
/** Account B: the other tenant, whose ids A's owner tries. */
let b: OwnedAccount;
let bLeads: string[];

/** Strings that only account B's rows contain. */
const B_MARKERS = ['Bartholomew', 'Zebra Widgets B', 'b-only-message', 'b-only-draft', 'someone.else@other-business.example'] as const;
/** B's notified lead's HubSpot contact id (A has a lead on the same contact id). */
let bContactId: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = await createSignalsRig(getDb());
  const owner = await getDb().one<{ owner_user_id: string }>(`select owner_user_id from accounts where id = $1`, [rig.accountId]);
  scopeA = createOwnerScopeForTest(rig.accountId, owner.owner_user_id);
  current.deps = rig.deps;
  current.scope = scopeA;

  const db = getDb();
  const now = rig.clock.now();
  b = await seedOtherAccount(db, now);
  await saveOwnerBrief(b.scope, rig.deps, {
    company_name: 'Zebra Widgets B',
    one_line: '',
    services: [],
    who_we_serve: '',
    tone: { style: 'friendly', note: '' },
    sign_off_name: 'Bea',
    allow_pricing: false,
    never_promise: [],
    faqs: [],
    booking_link_choice: 'none',
    booking_link: null,
    booking_link_confirmed: false,
  });
  const filtered = await seedNewLead(db, { accountId: b.accountId, now, firstName: 'Bartholomew', message: 'b-only-message' });
  await db.query(`update leads set classification = 'spam', classified_at = $2, processing_state = 'filtered' where id = $1`, [filtered, now]);
  const notified = await seedNotifiedLead(rig, { accountId: b.accountId, firstNotifiedAt: now });
  const replied = await seedNotifiedLead(rig, { accountId: b.accountId, firstNotifiedAt: now });
  await markRepliedLikeTheJob(db, replied.leadId, new Date(now.getTime() + HOUR), new Date(now.getTime() + HOUR));
  await db.query(`update lead_messages set first_name = 'Bartholomew', message = 'b-only-message' where account_id = $1`, [b.accountId]);
  await db.query(`insert into inbox_checks (account_id, test_address_hmac, status, created_at) values ($1, $2, 'open', $3)`, [b.accountId, 'b'.repeat(64), now]);

  // Every row a banner, a lead-page section or the report counts, on B only (PLAN §10.8): a draft,
  // follow-up notes and a resume on B's leads; a pause and resume; deferred leads today and earlier
  // with today's cap email; a payment in its grace; a weekly report; a lead that needs the owner's
  // touch; AI spend over the per-account share (under the global budget); email-scope logging.
  await db.query(`update hubspot_connections set scopes = $2 where account_id = $1`, [b.accountId, [...REQUIRED_SCOPES]]);
  await seedDraft(db, { accountId: b.accountId, leadId: notified.leadId, subject: 'b-only-draft subject', body: 'b-only-draft body', purgeAt: new Date(now.getTime() + 30 * DAY) });
  await recordFollowUpFailedNote(db, { accountId: b.accountId, leadId: notified.leadId, n: 1, followupStream: 0 });
  await insertAuditOnce(
    db,
    { accountId: b.accountId, actor: 'owner', action: 'lead.followups_resumed', level: 'info', meta: { leadId: replied.leadId, repliedAt: now.toISOString(), followupStream: 1 } },
    ['leadId'],
  );
  await db.query(`update accounts set trial_started_at = $2, trial_ends_at = $3 where id = $1`, [b.accountId, new Date(now.getTime() - 15 * DAY), new Date(now.getTime() - DAY)]);
  await seedSubscription(db, { accountId: b.accountId, status: 'pending', createdAt: new Date(now.getTime() - 2 * DAY), graceUntil: new Date(now.getTime() + 3 * DAY) });
  await pauseAll(rig.deps, b.scope);
  await resumeAll(rig.deps, b.scope);
  await seedLeadIn(db, { accountId: b.accountId, receivedAt: now, state: 'deferred', firstName: 'Bartholomew', set: { classification: 'lead', classified_at: now } });
  const earlier = new Date(now.getTime() - 3 * DAY);
  await seedLeadIn(db, { accountId: b.accountId, receivedAt: earlier, state: 'deferred', firstName: 'Bartholomew', set: { classification: 'lead', classified_at: earlier } });
  const bDay = DateTime.fromJSDate(now, { zone: 'America/New_York' }).toFormat('yyyy-MM-dd');
  await db.query(
    `insert into notifications_sent (dedupe_key, account_id, kind, status, first_reserved_at, reserved_at, sent_at) values ($1, $2, 'lead_cap', 'sent', $3, $3, $3)`,
    [NotificationKeys.leadCap(b.accountId, bDay), b.accountId, now],
  );
  await seedLeadIn(db, { accountId: b.accountId, receivedAt: now, state: 'notified', firstName: 'Bartholomew', set: { classification: 'lead', needs_touch: true, first_notified_at: now } });
  await db.query(
    `insert into weekly_reports (account_id, week_start, timezone, period_start, period_end, status, attempts) values ($1, '2026-09-28', 'America/New_York', $2, $3, 'sent', 0)`,
    [b.accountId, new Date('2026-09-28T12:00:00.000Z'), new Date('2026-10-05T12:00:00.000Z')],
  );
  const share = aiAccountShareMicroUsd(rig.deps.env);
  expect(share).toBeLessThan(aiDailyBudgetMicroUsd(rig.deps.env));
  await db.query(`insert into ai_calls (account_id, purpose, model, cost_micro_usd, outcome, created_at) values ($1, 'draft', 'fake-model', $2, 'ok', $3)`, [b.accountId, share, now]);

  bContactId = (await db.one<{ hubspot_contact_id: string }>(`select hubspot_contact_id from leads where id = $1`, [notified.leadId])).hubspot_contact_id;
  bLeads = [filtered, notified.leadId, replied.leadId, ...(await db.query<{ id: string }>(`select id from leads where account_id = $1 and processing_state = 'deferred' or (account_id = $1 and needs_touch)`, [b.accountId])).map((row) => row.id)];
  rig.clock.advance({ hours: 2 });
});

afterEach(() => {
  vi.useRealTimers();
});

function leaks(value: unknown): string[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return [...B_MARKERS, b.accountId, ...bLeads].filter((marker) => text.includes(marker));
}

/** Runs `fn`; a redirect or not-found becomes its Navigation, anything else is returned as is. */
async function outcome(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof Navigation) return error;
    throw error;
  }
}

function form(fields: Record<string, string | readonly string[]>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of typeof value === 'string' ? [value] : value) data.append(name, item);
  }
  return data;
}

async function render(load: () => Promise<{ default: (props: never) => Promise<ReactElement> }>, props: unknown): Promise<string | Navigation> {
  const { default: Page } = await load();
  const result = await outcome(() => (Page as (p: unknown) => Promise<ReactElement>)(props));
  return result instanceof Navigation ? result : renderToStaticMarkup(result as ReactElement);
}

describe('cross-tenant isolation (PLAN §10.8)', () => {
  it('owner read models never show another account\'s leads, brief, settings or checks', async () => {
    const deps = rig.deps;
    const rateLimits = async () => (await getDb().one<{ count: number }>(`select count(*)::int as count from rate_limits`)).count;
    const limitsBefore = await rateLimits();
    for (const leadId of bLeads) {
      expect(await leadDetailView(scopeA, deps, leadId)).toBeNull();
      expect(await refreshLeadSignals(scopeA, deps, leadId)).toEqual({ type: 'not_found' });
    }
    // A lead that is not A's uses no refresh slot (A can't rate-limit B's lead page).
    expect(await rateLimits()).toBe(limitsBefore);
    const views: [string, unknown][] = [
      ['dashboardView', await dashboardView(scopeA, deps)],
      ['dashboardBriefView', await dashboardBriefView(scopeA, deps)],
      ['briefPageView', await briefPageView(scopeA, deps)],
      ['formsPageView', await formsPageView(scopeA, deps)],
      ['preferencesPageView', await preferencesPageView(scopeA, deps)],
      ['onboardingStatus', await onboardingStatus(scopeA, deps)],
      ['baselinePageView', await baselinePageView(scopeA, deps)],
      ['loadInboxCheckPage', await loadInboxCheckPage(scopeA, deps)],
      ['getLatestBrief', await getLatestBrief(scopeA, deps)],
      ['listBriefVersions', await listBriefVersions(scopeA, deps)],
      ['getBriefVersion(1)', await getBriefVersion(scopeA, deps, 1)],
      ['getPreferences', await getPreferences(scopeA, deps)],
      ['getOnboardingGate', await getOnboardingGate(scopeA, deps)],
    ];
    for (const [name, view] of views) expect(leaks(view), name).toEqual([]);
    expect((await dashboardView(scopeA, deps)).leads).toEqual([]);
    // The check bites: B's own owner sees B's leads.
    expect(leaks(await dashboardView(b.scope, deps))).toEqual(expect.arrayContaining(['Bartholomew', ...bLeads]));
  });

  it('every dashboard banner comes from A\'s own rows only (B has a row behind each one)', async () => {
    const db = getDb();
    // A: log nothing about replies yet ('unknown'), a trial that ended (so a leaked subscription would
    // show as a payment in its grace), no leads, no pause, no AI spend, no inbox check.
    await db.query(`update accounts set logging_mode = 'unknown', trial_started_at = $2, trial_ends_at = $3 where id = $1`, [
      rig.accountId,
      new Date(rig.clock.now().getTime() - 15 * DAY),
      new Date(rig.clock.now().getTime() - DAY),
    ]);
    const a = await dashboardView(scopeA, rig.deps);
    expect(a.banners).toEqual([{ type: 'logging', mode: 'unknown' }]);
    expect(a.leads).toEqual([]);
    expect(leaks(a)).toEqual([]);
    // The check bites: B's own owner sees every one of them.
    const bView = await dashboardView(b.scope, rig.deps);
    expect(bView.banners.map((banner) => banner.type)).toEqual(
      expect.arrayContaining(['payment_grace', 'resumed', 'daily_cap', 'ai_limit', 'needs_touch', 'inbox_check_pending']),
    );
    expect(bView.banners.find((banner) => banner.type === 'daily_cap')).toMatchObject({ reachedToday: true, deferredToday: 1, deferredEarlier: 1 });
  });

  it('A\'s own lead page, on a contact id B also has, shows nothing of B\'s (drafts, notes, resumes, follow-ups)', async () => {
    const db = getDb();
    const now = rig.clock.now();
    const aLead = await seedLeadIn(db, {
      accountId: rig.accountId,
      receivedAt: new Date(now.getTime() - HOUR),
      contactId: bContactId,
      state: 'notified',
      firstName: 'Alicia',
      set: { classification: 'lead', classified_at: now, first_notified_at: now, replied_at: now, stop_reason: 'replied', replies_ignored_before: null },
    });
    await seedDraft(db, { accountId: rig.accountId, leadId: aLead, subject: 'a-own-subject', body: 'a-own-body', purgeAt: new Date(now.getTime() + 30 * DAY) });
    const before = await accountSnapshot(db, b.accountId);
    const view = await leadDetailView(scopeA, rig.deps, aLead);
    expect(view).toMatchObject({ failedFollowUps: [], upcomingFollowUps: [], drafts: [{ kind: 'initial', state: 'available', subject: 'a-own-subject' }] });
    expect(view?.timeline.filter((event) => event.kind === 'lead_replied')).toEqual([expect.objectContaining({ resumed: false })]);
    expect(leaks(view)).toEqual([]);
    const page = await render(() => import('@/app/dashboard/leads/[id]/page'), { params: Promise.resolve({ id: aLead }), searchParams: Promise.resolve({}) });
    expect(typeof page).toBe('string');
    expect(page).toContain('Alicia');
    expect(page).toContain('a-own-subject');
    expect(leaks(page)).toEqual([]);
    expect(await accountSnapshot(db, b.accountId)).toEqual(before);
  });

  it('the Monday report reads and reports only A\'s leads, though B has leads in the same week', async () => {
    const db = getDb();
    registerWeeklyReportJob({ jobs: rig.registry, notifications: rig.notifications, limiterSleep: rig.sleep });
    const aLead = await seedLeadIn(db, { accountId: rig.accountId, receivedAt: new Date('2026-10-06T15:00:00.000Z'), contactId: bContactId, state: 'filtered', set: { classification: 'spam', classified_at: new Date('2026-10-06T15:00:00.000Z') } });
    rig.clock.set(new Date('2026-10-12T12:00:00.000Z'));
    await scheduleWeeklyReports(rig.deps);
    const before = await accountSnapshot(db, b.accountId);
    const jobRow = await db.one<{ id: string }>(`select id from scheduled_jobs where kind = 'weekly_report' and account_id = $1`, [rig.accountId]);
    const job = await getJob(db, jobRow.id);
    if (job === null) throw new Error('no report job');
    rig.clock.set(job.runAt);
    expect(await runJob(rig.deps, { jobId: job.id, messageId: job.externalId, retried: 0 }, rig.registry)).toMatchObject({ outcome: 'done' });

    const report = await db.one<{ metrics: { cohort: { leadsIn: number; filtered: number; draftsEmailed: number }; events: unknown } }>(
      `select metrics from weekly_reports where account_id = $1 and week_start = '2026-10-12'`,
      [rig.accountId],
    );
    // Only A's one (filtered) lead: none of B's notified, replied, deferred or needs-touch leads.
    expect(report.metrics.cohort).toMatchObject({ leadsIn: 1, filtered: 1, draftsEmailed: 0 });
    expect(report.metrics.events).toEqual({ repliesFromLeads: 0, followUpsDrafted: 0 });
    const mail = rig.fakes.mailer.sent.find((candidate) => candidate.kind === 'weekly_report');
    expect(leaks(`${mail?.text ?? ''}${mail?.html ?? ''}${JSON.stringify(report.metrics)}`)).toEqual([]);
    expect(JSON.stringify(report.metrics)).not.toContain(aLead);
    // A's refresh never read or wrote B's leads.
    expect(await accountSnapshot(db, b.accountId)).toEqual(before);
  });

  it('owner controls refuse another account\'s leads as not found and change nothing', async () => {
    const db = getDb();
    const before = await accountSnapshot(db, b.accountId);
    for (const leadId of bLeads) {
      expect(await markRealLead(rig.deps, scopeA, leadId)).toEqual({ type: 'refused', reason: 'not_found' });
      expect(await resumeFollowUps(rig.deps, scopeA, leadId)).toEqual({ type: 'refused', reason: 'not_found' });
      expect(await dismissLeadForOwner(rig.deps, scopeA, leadId)).toEqual({ type: 'not_found' });
      for (const control of ['real_lead', 'resume_followups', 'dismiss'] as const) {
        expect(await runLeadControl(rig.deps, scopeA, control, leadId)).toBe('/dashboard?result=lead_not_found');
      }
    }
    expect(await accountSnapshot(db, b.accountId)).toEqual(before);
  });

  it('every owner page answers 404 for another account\'s lead and shows nothing of it elsewhere', async () => {
    for (const leadId of bLeads) {
      const page = await render(() => import('@/app/dashboard/leads/[id]/page'), { params: Promise.resolve({ id: leadId }), searchParams: Promise.resolve({}) });
      expect(page).toMatchObject({ kind: 'not_found' });
    }
    const pages: [string, () => Promise<{ default: (props: never) => Promise<ReactElement> }>, unknown][] = [
      ['/dashboard', () => import('@/app/dashboard/page'), { searchParams: Promise.resolve({}) }],
      ['/dashboard?reconnect=1&result=paused', () => import('@/app/dashboard/page'), { searchParams: Promise.resolve({ reconnect: '1', result: 'paused' }) }],
      ['/dashboard/brief', () => import('@/app/dashboard/brief/page'), { searchParams: Promise.resolve({ saved: '1' }) }],
      ['/onboarding/brief', () => import('@/app/onboarding/brief/page'), {}],
      ['/onboarding/forms', () => import('@/app/onboarding/forms/page'), { searchParams: Promise.resolve({}) }],
      ['/onboarding/preferences', () => import('@/app/onboarding/preferences/page'), { searchParams: Promise.resolve({}) }],
      ['/onboarding/inbox', () => import('@/app/onboarding/inbox/page'), { searchParams: Promise.resolve({}) }],
      ['/onboarding/baseline', () => import('@/app/onboarding/baseline/page'), { searchParams: Promise.resolve({}) }],
    ];
    for (const [path, load, props] of pages) {
      const html = await render(load, props);
      expect(typeof html, path).toBe('string');
      expect(leaks(html), path).toEqual([]);
    }
    // The owner-facing route handler the onboarding pages poll.
    const { GET } = await import('@/app/api/onboarding/status/route');
    const response = await GET(new Request('http://localhost:3000/api/onboarding/status'));
    expect(response.status).toBe(200);
    expect(leaks(await response.text())).toEqual([]);
  });

  it('every Server Action run as A with B\'s ids is refused or touches only A, and B\'s rows are unchanged', async () => {
    const db = getDb();
    const before = await accountSnapshot(db, b.accountId);
    const lead = await import('@/server/actions/dashboard/lead');
    const account = await import('@/server/actions/dashboard/account');
    const dashboardBrief = await import('@/server/actions/dashboard/brief');
    const onboardingBrief = await import('@/server/actions/onboarding/brief');
    const forms = await import('@/server/actions/onboarding/forms');
    const preferences = await import('@/server/actions/onboarding/preferences');
    const finish = await import('@/server/actions/onboarding/finish');
    const inbox = await import('@/server/actions/inbox/inbox-check');

    for (const leadId of bLeads) {
      for (const action of [lead.markRealLeadAction, lead.resumeFollowUpsAction, lead.notARealLeadAction]) {
        expect(await outcome(() => action(form({ lead_id: leadId })))).toMatchObject({ kind: 'redirect', path: '/dashboard?result=lead_not_found' });
      }
    }
    // B's form id is not one of A's portal's forms: refused.
    expect(await outcome(() => forms.saveFormsAction(form({ form_id: ['form-1'] })))).toMatchObject({ kind: 'redirect', path: '/onboarding/forms?error=unknown_form' });

    const brief = { company_name: 'Alpha Co', sign_off_name: 'Al', tone_style: 'friendly', booking_choice: 'none' };
    await outcome(() => dashboardBrief.saveDashboardBriefAction({ issues: [], values: null }, form(brief)));
    await outcome(() => onboardingBrief.saveBriefAction({ issues: [], values: null }, form(brief)));
    await outcome(() => onboardingBrief.generateBriefAction({ error: null, websiteUrl: '' }, form({ website_url: 'https://alpha.example' })));
    await outcome(() => preferences.savePreferencesAction({ issues: [], values: null }, form({ mail_client: 'other', notify_email_0: 'someone.else@other-business.example', quiet_start_hour: '20', quiet_end_hour: '8', followups_enabled: 'on' })));
    await outcome(() => inbox.startInboxCheckAction(form({ test_address: 'alpha.other@example.net' })));
    await outcome(() => inbox.skipInboxCheckAction());
    await outcome(() => finish.finishOnboardingAction());
    await outcome(() => account.pauseAllAction());
    await outcome(() => account.resumeAllAction());

    expect(await accountSnapshot(db, b.accountId)).toEqual(before);
    // A's own saves landed on A.
    const aVersions = await db.query<{ account_id: string }>(`select account_id from brief_versions where account_id = $1`, [rig.accountId]);
    expect(aVersions.length).toBeGreaterThan(0);
  });
});
