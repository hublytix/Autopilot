import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Deps } from '@/server/ports';
import type { OwnerScope } from '@/server/services/auth/owner-scope';
import { disconnectHubSpot } from '@/server/services/disconnect';
import { pauseAll } from '@/server/services/owner-controls';
import { disconnectPageView, settingsPageView } from '@/server/views/settings';
import { insertSubscription } from '../billing/support';
import { useTestDb as setUpTestDb } from '../db/harness';
import { seedSettingsAccount, setUpSettingsRig, subscribe, subscribeAndPay, type SettingsAccount, type SettingsRig } from './support';

// The settings pages rendered over PGlite with the real read models (PLAN §7.5, brief §5.11, §9.1
// step 5): only the session guard, the container and Next's navigation are stubbed. Checks what the
// owner reads: every §5.11 item, honest result lines, the Disconnect dialog's billing choice (offered
// from authenticated/active only, explained for paused/pending/halted), and Reconnect once
// disconnected.

const current: { deps: Deps | null; scope: OwnerScope | null } = { deps: null, scope: null };

class Navigation extends Error {
  constructor(
    readonly kind: 'redirect' | 'not_found',
    readonly path: string | null,
  ) {
    super(kind);
  }
}

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Navigation('redirect', path);
  },
  notFound: () => {
    throw new Navigation('not_found', null);
  },
  useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock('@/server/container', () => ({
  getDeps: async () => {
    if (current.deps === null) throw new Error('no deps');
    return current.deps;
  },
}));
vi.mock('@/server/http/auth/guards', () => ({
  requireOwnerPage: async () => {
    if (current.scope === null) throw new Navigation('redirect', '/login');
    return current.scope;
  },
}));

const getDb = setUpTestDb();
const getRig = setUpSettingsRig(getDb);
let rig: SettingsRig;
let account: SettingsAccount;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = getRig();
  account = await seedSettingsAccount(rig);
  await getDb().query(`update accounts set timezone_source = 'hubspot' where id = $1`, [account.accountId]);
  current.deps = rig.deps;
  current.scope = account.scope;
});

afterEach(() => {
  vi.useRealTimers();
});

/** The page's visible text (tags dropped, entities decoded), for wording checks. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

async function settingsPage(query: Record<string, string> = {}): Promise<string> {
  const { default: Page } = await import('@/app/dashboard/settings/page');
  return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(query) }));
}

async function disconnectPage(): Promise<string> {
  const { default: Page } = await import('@/app/dashboard/settings/disconnect/page');
  return renderToStaticMarkup(await Page());
}

async function formsPage(query: Record<string, string> = {}): Promise<string> {
  const { default: Page } = await import('@/app/dashboard/settings/forms/page');
  return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(query) }));
}

describe('/dashboard/settings', () => {
  it('shows every settings item: status with Pause all, alert addresses, mail app, quiet hours, weekends, follow-ups, BCC, forms, billing, Disconnect', async () => {
    const html = await settingsPage();
    const words = text(html);
    expect(html).toContain('data-state="active"');
    expect(words).toContain('Pause all');
    for (const field of ['notify_email_0', 'notify_email_1', 'notify_email_2', 'mail_client', 'gmail_account_email', 'quiet_start_hour', 'quiet_end_hour', 'skip_weekends', 'followups_enabled', 'bcc_address']) {
      expect(html, field).toContain(`name="${field}"`);
    }
    expect(words).toContain("follow-up drafts already scheduled aren't emailed while follow-ups are off");
    expect(words).toContain('we email owner@brightside-plumbing.example to let you know');
    expect(words).toContain('Change forms');
    expect(html).toContain('href="/dashboard/settings/forms"');
    expect(words).toContain('Free trial: 14 days left');
    expect(html).toContain('href="/dashboard/billing"');
    expect(html).toContain('href="/dashboard/settings/disconnect"');
    expect(words).toContain('never changes anything in it');
  });

  it('lists the ticked forms by name', async () => {
    await getDb().query(`update selected_forms set form_name = 'Contact us' where account_id = $1`, [account.accountId]);
    await getDb().query(
      `insert into selected_forms (account_id, form_id, form_name, form_type, selected, intake_floor_at, cursor_submitted_at) values ($1, 'form-2', 'Old newsletter', 'hubspot', false, $2, $2)`,
      [account.accountId, rig.clock.now()],
    );
    const html = await settingsPage();
    expect(text(html)).toContain('Contact us');
    expect(text(html)).not.toContain('Old newsletter');
  });

  it('a paused account offers Resume; an active subscription is summarised', async () => {
    await pauseAll(rig.deps, account.scope);
    await subscribeAndPay(rig, account.scope);
    const words = text(await settingsPage());
    expect(words).toContain('Resume');
    expect(words).not.toContain('Pause all');
    expect(words).toContain('Subscribed: $49/month.');
  });

  it('after a save: the result and what else happened, in counts and flags only', async () => {
    const words = text(await settingsPage({ result: 'preferences_saved', sent: '2', limited: '1', bcc: '1', alert: '1' }));
    expect(words).toContain('Your preferences are saved.');
    expect(words).toContain('We sent a confirmation email to 2 addresses.');
    expect(words).toContain("because of today's limit");
    expect(words).toContain("doesn't look like a HubSpot BCC");
    expect(words).toContain('we emailed you a note about it');
  });

  it('an unknown result code shows nothing (own keys only)', async () => {
    const html = await settingsPage({ result: 'constructor' });
    expect(html).not.toContain('role="status"');
  });

  it('after a disconnect: Reconnect, the deletion date, and the billing outcome', async () => {
    rig.clock.set(new Date('2026-10-06T14:00:00.000Z'));
    await disconnectHubSpot(rig.deps, account.scope, { cancelBilling: false }, { sleep: rig.sleep });
    const html = await settingsPage({ result: 'disconnected', billing: 'failed' });
    const words = text(html);
    expect(words).toContain('HubSpot is disconnected. Autopilot has stopped');
    expect(words).toContain("We couldn't cancel your subscription just now. Cancel it on the billing page.");
    expect(words).toContain("We delete your account's data on 5 Nov 2026 (in 30 days) unless you reconnect before then.");
    expect(html).toContain('href="/api/hubspot/install"');
    expect(html).not.toContain('href="/dashboard/settings/disconnect"');
    expect(html).toContain('data-state="disconnected"');
    expect(words).not.toContain('uninstall the app');
  });

  it('after a disconnect whose uninstall failed or could not run: says to remove the app in HubSpot (D-03 kept true)', async () => {
    await disconnectHubSpot(rig.deps, account.scope, { cancelBilling: false }, { sleep: rig.sleep });
    const failed = text(await settingsPage({ result: 'disconnected', billing: 'not_requested', uninstall: 'failed' }));
    expect(failed).toContain(
      "We couldn't uninstall the app from HubSpot for you. Remove it in HubSpot under Settings → Integrations → Connected apps.",
    );
    const skipped = text(await settingsPage({ result: 'disconnected', billing: 'not_requested', uninstall: 'skipped' }));
    expect(skipped).toContain("Autopilot had already lost access to HubSpot, so it couldn't ask HubSpot to uninstall the app.");
    // Only after this disconnect, and only our own codes.
    expect(text(await settingsPage({ result: 'already_disconnected', uninstall: 'failed' }))).not.toContain('uninstall the app');
    expect(text(await settingsPage({ result: 'disconnected', uninstall: 'constructor' }))).not.toContain('uninstall the app');
  });

  it('asks robots not to index or follow', async () => {
    for (const load of [() => import('@/app/dashboard/settings/page'), () => import('@/app/dashboard/settings/disconnect/page'), () => import('@/app/dashboard/settings/forms/page')]) {
      expect((await load()).metadata.robots).toEqual({ index: false, follow: false });
    }
  });

  it('without an owner session every settings page goes to /login', async () => {
    current.scope = null;
    await expect(settingsPage()).rejects.toMatchObject({ kind: 'redirect', path: '/login' });
    await expect(disconnectPage()).rejects.toMatchObject({ kind: 'redirect', path: '/login' });
    await expect(formsPage()).rejects.toMatchObject({ kind: 'redirect', path: '/login' });
  });
});

describe('the Disconnect dialog', () => {
  it('says what happens: processing stops now, data deleted in 30 days unless the owner reconnects', async () => {
    rig.clock.set(new Date('2026-10-06T14:00:00.000Z'));
    const words = text(await disconnectPage());
    expect(words).toContain('Autopilot stops now');
    expect(words).toContain('uninstall the app');
    expect(words).toContain('stop working');
    expect(words).toContain('deleted on 5 Nov 2026, 30 days from now. Reconnect before then to keep them');
    expect(words).toContain("You don't have a subscription to cancel.");
    expect(words).not.toContain('Also cancel my subscription');
  });

  it('authenticated: offers "also cancel" (nothing charged)', async () => {
    await subscribe(rig, account.scope);
    const html = await disconnectPage();
    expect(html).toContain('data-option="cancellable"');
    expect(html).toContain('name="cancel_billing"');
    expect(text(html)).toContain('Nothing has been charged yet');
    expect(text(html)).toContain('even while HubSpot is disconnected');
  });

  it('authenticated without a start_at after the trial: offers "also cancel" without claiming nothing was charged (laws 3 and 5)', async () => {
    rig.clock.advance({ days: 15 });
    await insertSubscription(getDb(), { accountId: account.accountId, providerId: 'sub_NoStart00002', status: 'authenticated', createdAt: rig.clock.now(), startAt: null });
    const view = await disconnectPageView(account.scope, rig.deps);
    expect(view.billing).toMatchObject({ type: 'cancellable', status: 'authenticated', firstPaymentOn: null, firstPaymentAhead: false });
    const html = await disconnectPage();
    const words = text(html);
    expect(html).toContain('name="cancel_billing"');
    expect(words).toContain("No further payments are taken. Cancelling doesn't refund a payment already taken.");
    expect(words).toContain('it renews every month as usual');
    expect(words).not.toContain('Nothing has been charged');
    expect(words).not.toContain('nothing will be');
    expect(words).not.toContain('when your free trial ends');
    // The settings page's summary says the same, and so does the result after a disconnect with cancel.
    const settings = text(await settingsPage({ result: 'disconnected', billing: 'cancelled_after_payment' }));
    expect(settings).toContain('Subscribed: $49/month. Your first payment has already come due.');
    expect(settings).not.toContain('taken when your free trial ends');
    expect(settings).toContain("Your subscription is cancelled. No further payments are taken; cancelling doesn't refund a payment already taken.");
    expect(settings).not.toContain('Nothing was charged');
  });

  it('active: offers "also cancel" at the end of the billing period, with its date', async () => {
    await subscribeAndPay(rig, account.scope);
    const view = await disconnectPageView(account.scope, rig.deps);
    expect(view.billing).toMatchObject({ type: 'cancellable', status: 'active', periodEndsOn: expect.any(String) });
    const html = await disconnectPage();
    expect(html).toContain('name="cancel_billing"');
    expect(text(html)).toContain("at the end of the current billing period, and isn't renewed");
  });

  it.each([
    ['paused', 'Your subscription is paused.'],
    ['pending', "waiting for a payment that didn't go through"],
    ['halted', 'stopped after failed payments'],
    ['unknown', "Razorpay reported a status for your subscription that we don't recognise."],
  ] as const)('%s: no choice, the explanation instead', async (status, line) => {
    await insertSubscription(getDb(), { accountId: account.accountId, providerId: 'sub_Stuck000000001', status, createdAt: rig.clock.now() });
    const html = await disconnectPage();
    const words = text(html);
    expect(html).toContain('data-option="not_cancellable"');
    expect(html).not.toContain('name="cancel_billing"');
    expect(words).toContain(line);
    expect(words).toContain(`Cancel isn't available in this state; resume or update payment first, or contact support at ${rig.deps.env.EMAIL_REPLY_TO}.`);
    expect(html).toContain('href="/dashboard/billing"');
  });

  it('already disconnected: nothing to disconnect, Reconnect instead', async () => {
    await disconnectHubSpot(rig.deps, account.scope, { cancelBilling: false }, { sleep: rig.sleep });
    const html = await disconnectPage();
    expect(text(html)).toContain("There's nothing to disconnect");
    expect(html).toContain('href="/api/hubspot/install"');
    expect(html).not.toContain('Disconnecting');
  });
});

describe('/dashboard/settings/forms', () => {
  it('lists the portal\'s forms with the stored ticks; the newsletter-like one starts unticked', async () => {
    const html = await formsPage();
    const words = text(html);
    expect(words).toContain('Contact us');
    expect(words).toContain('Request a quote');
    expect(words).toContain('Newsletter signup');
    expect(words).toContain('Looks like a newsletter sign-up');
    expect((html.match(/name="form_id"/g) ?? []).length).toBe(3);
  });

  it('a save error code is shown in words; HubSpot disconnected offers Reconnect', async () => {
    expect(text(await formsPage({ error: 'none_selected' }))).toContain('Tick at least one form.');
    await disconnectHubSpot(rig.deps, account.scope, { cancelBilling: false }, { sleep: rig.sleep });
    const html = await formsPage();
    expect(text(html)).toContain("HubSpot is disconnected, so we can't read your forms.");
    expect(html).toContain('href="/api/hubspot/install"');
  });
});

describe('settings read model', () => {
  it('reads only the owner\'s rows, with dates in the account zone', async () => {
    rig.clock.set(new Date('2026-10-06T14:00:00.000Z'));
    await disconnectHubSpot(rig.deps, account.scope, { cancelBilling: false }, { sleep: rig.sleep });
    rig.clock.advance({ days: 10 });
    const view = await settingsPageView(account.scope, rig.deps);
    expect(view).toMatchObject({
      zone: 'America/New_York',
      processingState: 'disconnected',
      connection: { status: 'disconnected', purgeOn: '5 Nov 2026', daysLeft: 20 },
      forms: [{ id: 'form-1', name: 'Contact us' }],
      billing: { action: 'subscribe', subscriptionStatus: null },
    });
    expect(view.preferences.preferences.ownerEmail).toBe('owner@brightside-plumbing.example');
  });
});
