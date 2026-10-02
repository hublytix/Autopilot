import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Deps } from '@/server/ports';
import type { OwnerScope } from '@/server/services/auth/owner-scope';
import { runBillingControl } from '@/server/services/billing';
import { billingPageView } from '@/server/views/billing';
import { disconnectHubSpot } from '@/server/services/disconnect';
import { disconnectPageView, settingsPageView } from '@/server/views/settings';
import { runDisconnect, runSaveForms, runSavePreferences, runSettingsPause } from '@/server/actions/settings';
import { deliverQueued, seedBillingAccount, type BillingAccount } from '../billing/support';
import { accountSnapshot } from '../dashboard/support';
import { useTestDb as setUpTestDb } from '../db/harness';
import { seedSettingsAccount, setUpSettingsRig, subscribe, type SettingsAccount, type SettingsRig } from './support';

// Tenant isolation for settings, billing and Disconnect (PLAN §10.8): two accounts in one database.
// Every settings page, read model and Server Action, the billing controls and the disconnect run as
// account A's owner, also with account B's ids posted (a form id, an account id); none shows anything
// of B's, and B's rows (and B's subscription at Razorpay) are unchanged afterwards. Only the session
// guard, the container, Next's navigation and Sentry are stubbed.

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
}));
vi.mock('@/server/actions/auth/context', () => {
  const context = () => {
    if (current.deps === null || current.scope === null) throw new Navigation('redirect', '/login');
    return { deps: current.deps, scope: current.scope, request: new Request('http://localhost:3000/dashboard/settings'), ip: '203.0.113.7' };
  };
  return { actionContext: async () => context(), requireOwnerAction: async () => context() };
});

const getDb = setUpTestDb();
const getRig = setUpSettingsRig(getDb);
let rig: SettingsRig;
let a: SettingsAccount;
let b: BillingAccount;
let bSubscription: string;
let bPortal: string;

const B_MARKERS = ['someone.else@other-business.example', 'b-alerts@other-business.example', 'B-only enquiry form', 'b-bcc@bcc.hubspot.com', 'b-form-1'] as const;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = getRig();
  a = await seedSettingsAccount(rig);
  b = await seedBillingAccount(rig, { email: 'someone.else@other-business.example' });
  const db = getDb();
  const now = rig.clock.now();
  await db.query(`update settings set notify_emails = $2, notify_emails_verified = $2, bcc_address = 'b-bcc@bcc.hubspot.com' where account_id = $1`, [
    b.accountId,
    ['b-alerts@other-business.example'],
  ]);
  await db.query(
    `insert into selected_forms (account_id, form_id, form_name, form_type, intake_floor_at, cursor_submitted_at) values ($1, 'b-form-1', 'B-only enquiry form', 'hubspot', $2, $2)`,
    [b.accountId, now],
  );
  bSubscription = await subscribe(rig, b.scope);
  bPortal = (await db.one<{ hubspot_portal_id: string }>(`select hubspot_portal_id from accounts where id = $1`, [b.accountId])).hubspot_portal_id;
  current.deps = rig.deps;
  current.scope = a.scope;
});

afterEach(() => {
  vi.useRealTimers();
});

function leaks(value: unknown): string[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return [...B_MARKERS, b.accountId, bPortal, bSubscription].filter((marker) => text.includes(marker));
}

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

async function render(load: () => Promise<{ default: (props: never) => Promise<ReactElement> }>, props: unknown): Promise<string> {
  const { default: Page } = await load();
  return renderToStaticMarkup(await (Page as (p: unknown) => Promise<ReactElement>)(props));
}

describe('settings, billing and disconnect across two accounts', () => {
  it("A's settings read models and pages show nothing of B's (the check bites on B's own view)", async () => {
    expect(leaks(await settingsPageView(a.scope, rig.deps))).toEqual([]);
    expect(leaks(await disconnectPageView(a.scope, rig.deps))).toEqual([]);
    expect(leaks(await billingPageView(rig.deps, a.scope))).toEqual([]);
    for (const [path, load, props] of [
      ['/dashboard/settings', () => import('@/app/dashboard/settings/page'), { searchParams: Promise.resolve({ result: 'disconnected', billing: 'cancelled' }) }],
      ['/dashboard/settings/disconnect', () => import('@/app/dashboard/settings/disconnect/page'), {}],
      ['/dashboard/settings/forms', () => import('@/app/dashboard/settings/forms/page'), { searchParams: Promise.resolve({}) }],
      ['/dashboard/billing', () => import('@/app/dashboard/billing/page'), { searchParams: Promise.resolve({}) }],
    ] as const) {
      expect(leaks(await render(load as () => Promise<{ default: (props: never) => Promise<ReactElement> }>, props)), path).toEqual([]);
    }
    // B's own owner does see B's addresses and forms, and B's subscription is live.
    const bView = await settingsPageView(b.scope, rig.deps);
    expect(leaks(bView)).toEqual(expect.arrayContaining(['b-alerts@other-business.example', 'B-only enquiry form']));
    expect((await disconnectPageView(b.scope, rig.deps)).billing).toMatchObject({ type: 'cancellable', status: 'authenticated' });
  });

  it("every settings, billing and disconnect action run as A (with B's ids posted) changes nothing of B's", async () => {
    const db = getDb();
    const before = await accountSnapshot(db, b.accountId);

    // B's form id is not one of A's portal's forms: refused, and B's selection is untouched.
    expect(await runSaveForms(rig.deps, a.scope, form({ form_id: ['b-form-1'], account_id: b.accountId }))).toBe('/dashboard/settings/forms?error=unknown_form');
    expect(await runSavePreferences(rig.deps, a.scope, form({ mail_client: 'other', notify_email_0: 'owner@brightside-plumbing.example', quiet_start_hour: '20', quiet_end_hour: '8', account_id: b.accountId }))).toMatchObject({
      redirect: expect.stringContaining('preferences_saved'),
    });
    expect(await runSettingsPause(rig.deps, a.scope, true)).toBe('/dashboard/settings?result=paused');
    expect(await runSettingsPause(rig.deps, a.scope, false)).toBe('/dashboard/settings?result=resumed');
    // A has no subscription: "also cancel" finds nothing of A's, and B's is never touched.
    expect(await runBillingControl(rig.deps, a.scope, 'cancel')).toBe('/dashboard/billing?result=cancel.nothing');
    expect(await runBillingControl(rig.deps, a.scope, 'resume')).toBe('/dashboard/billing?result=resume.nothing');
    expect(await runDisconnect(rig.deps, a.scope, form({ cancel_billing: 'on', account_id: b.accountId }), { sleep: rig.sleep })).toBe(
      '/dashboard/settings?result=disconnected&billing=nothing_to_cancel',
    );

    // The Server Action wrappers too (the session's scope is A's).
    const settings = await import('@/server/actions/settings/settings');
    const billing = await import('@/server/actions/billing/billing');
    for (const run of [
      () => settings.saveSettingsFormsAction(form({ form_id: ['b-form-1'] })),
      () => settings.saveSettingsPreferencesAction({ issues: [], values: null }, form({ mail_client: 'other', notify_email_0: 'b-alerts@other-business.example', quiet_start_hour: '20', quiet_end_hour: '8' })),
      () => settings.pauseFromSettingsAction(),
      () => settings.resumeFromSettingsAction(),
      () => settings.disconnectHubSpotAction(form({ cancel_billing: 'on' })),
      () => billing.cancelSubscriptionAction(),
      () => billing.resumeSubscriptionAction(),
    ]) {
      const result = await outcome(run);
      if (result instanceof Navigation) expect(result.kind).toBe('redirect');
    }

    expect(await accountSnapshot(db, b.accountId)).toEqual(before);
    expect((await rig.fakes.billing.fetchSubscription(bSubscription)).status).toBe('authenticated');
    // A's own rows did change: A is disconnected, B is still active.
    expect(await db.one(`select processing_state from accounts where id = $1`, [a.accountId])).toEqual({ processing_state: 'disconnected' });
    expect(await db.one(`select processing_state from accounts where id = $1`, [b.accountId])).toEqual({ processing_state: 'active' });
  });

  it("B's disconnect with \"also cancel\" acts on B only; A's subscription and connection are untouched", async () => {
    const aSubscription = await subscribe(rig, a.scope);
    await deliverQueued(rig);
    const before = await accountSnapshot(getDb(), a.accountId);
    expect(await disconnectHubSpot(rig.deps, b.scope, { cancelBilling: true }, { sleep: rig.sleep })).toMatchObject({ type: 'disconnected', billing: 'cancelled' });
    expect((await rig.fakes.billing.fetchSubscription(bSubscription)).status).toBe('cancelled');
    expect((await rig.fakes.billing.fetchSubscription(aSubscription)).status).toBe('authenticated');
    expect(await accountSnapshot(getDb(), a.accountId)).toEqual(before);
    expect(rig.fakes.hubspot.isInstalled()).toBe(true);
  });
});
