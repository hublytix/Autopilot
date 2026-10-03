import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Deps } from '@/server/ports';
import type { OwnerScope } from '@/server/services/auth/owner-scope';
import { saveOwnerBrief } from '@/server/services/brief';
import type { LeadRefreshOutcome } from '@/server/views/dashboard';
import { useTestDb as setUpTestDb } from '../db/harness';
import {
  at,
  createLeadsRig,
  HOUR,
  markRepliedLikeTheJob,
  purgeContent,
  seedDraft,
  seedFilteredLead,
  seedLeadIn,
  seedNotifiedLead,
  seedOtherAccount,
  seedOwnedAccount,
  DAY,
  type LeadsRig,
  type OwnedAccount,
} from './support';

// The dashboard pages rendered over PGlite with the real read models (PLAN §7.5): only the session
// guard, the container and Next's navigation are stubbed, and the lead page's HubSpot refresh is set
// per test. Checks what the owner reads: one status per lead, deferred leads as "Not processed", the
// Reconnect button, Resume follow-ups on a replied lead, "This is a real lead" on a filtered one,
// expired drafts, the unverified message, honest "couldn't be checked" copy, and 404s.

const current: { deps: Deps | null; scope: OwnerScope | null; refresh: LeadRefreshOutcome } = { deps: null, scope: null, refresh: { type: 'rate_limited' } };

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
vi.mock('@/server/views/dashboard', async (original) => ({
  ...(await original<typeof import('@/server/views/dashboard')>()),
  refreshLeadSignals: async () => current.refresh,
}));

const getDb = setUpTestDb();
let rig: LeadsRig;
let owned: OwnedAccount;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = createLeadsRig(getDb());
  owned = await seedOwnedAccount(getDb(), { now: rig.clock.now() });
  await getDb().query(`update hubspot_connections set scopes = $2 where account_id = $1`, [owned.accountId, ['oauth', 'crm.objects.contacts.read', 'forms', 'sales-email-read']]);
  current.deps = rig.deps;
  current.scope = owned.scope;
  current.refresh = { type: 'rate_limited' };
});

afterEach(() => {
  vi.useRealTimers();
});

async function navigationOf(run: () => Promise<unknown>): Promise<Navigation> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Navigation) return error;
    throw error;
  }
  throw new Error('no navigation');
}

async function dashboard(query: Record<string, string> = {}): Promise<string> {
  const { default: Page } = await import('@/app/dashboard/page');
  return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(query) }));
}

async function leadPage(id: string, query: Record<string, string> = {}): Promise<string> {
  const { default: Page } = await import('@/app/dashboard/leads/[id]/page');
  return renderToStaticMarkup(await Page({ params: Promise.resolve({ id }), searchParams: Promise.resolve(query) }));
}

async function briefPage(query: Record<string, string> = {}): Promise<string> {
  const { default: Page } = await import('@/app/dashboard/brief/page');
  return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(query) }));
}

/** Visible text, tags dropped and entities decoded, for phrase checks. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

describe('/dashboard', () => {
  it('shows the status, the trial, Pause all, and each recent lead with one status, a lead page link and a HubSpot link', async () => {
    const db = getDb();
    const now = rig.clock.now();
    const deferred = await seedLeadIn(db, { accountId: owned.accountId, receivedAt: at(now, -HOUR), state: 'deferred', set: { classification: 'lead' }, firstName: 'Riley' });
    const filtered = await seedFilteredLead(db, { accountId: owned.accountId, now: at(now, -2 * HOUR) });

    const html = await dashboard();
    const visible = text(html);
    expect(html).toContain('data-state="active"');
    expect(visible).toContain('Active');
    expect(visible).toContain('Free trial: 14 days left.');
    expect(visible).toContain('Pause all');
    expect(html).toContain(`href="/dashboard/leads/${deferred}"`);
    expect(html).toContain(`href="/dashboard/leads/${filtered}"`);
    expect(visible).toContain('Riley');
    expect(visible).toContain('Not processed');
    expect(visible).toContain('Over the daily limit');
    expect(visible).toContain('Filtered');
    expect(html).toMatch(/href="https:\/\/app\.hubspot\.com\/contacts\/24681357\/record\/0-1\/\d+"/);
    expect(visible).toContain('Up to the latest 50, newest first. Times are in America/New_York.');
    expect(visible).toContain("You've reached today's limit of 50 drafted leads");
  });

  it('with no leads yet it says setup is complete', async () => {
    expect(text(await dashboard())).toContain('No leads yet. Setup is complete: new leads will appear here as they arrive.');
  });

  it('offers Reconnect HubSpot after a reconnect sign-in link (?reconnect=1), as a plain link to the install', async () => {
    const html = await dashboard({ reconnect: '1' });
    expect(html).toContain('href="/api/hubspot/install"');
    expect(text(html)).toContain('Reconnect HubSpot');
  });

  it('a revoked connection: the reconnect status with the days left, and the banner', async () => {
    const db = getDb();
    await db.query(`update hubspot_connections set status = 'revoked', access_token_enc = null, refresh_token_enc = null where account_id = $1`, [owned.accountId]);
    await db.query(`update accounts set processing_state = 'revoked', purge_after = $2 where id = $1`, [owned.accountId, at(rig.clock.now(), 30 * DAY)]);
    const visible = text(await dashboard());
    expect(visible).toContain('HubSpot disconnected — reconnect within 30 days');
    expect(visible).toContain("Reconnect within 30 days (by 5 Nov 2026). After that we delete your account's data.");
  });

  it('sends an owner who has not finished setup back to it; with HubSpot disconnected it stays and offers both', async () => {
    const db = getDb();
    await db.query(`update accounts set processing_state = 'onboarding', onboarding_completed_at = null where id = $1`, [owned.accountId]);
    expect(await navigationOf(() => dashboard())).toMatchObject({ kind: 'redirect', path: '/onboarding/baseline' });

    await db.query(`update hubspot_connections set status = 'revoked', access_token_enc = null, refresh_token_enc = null where account_id = $1`, [owned.accountId]);
    const html = await dashboard();
    expect(html).toContain('href="/api/hubspot/install"');
    expect(html).toContain('href="/onboarding/baseline"');
    expect(text(html)).not.toContain('Setup is complete');
  });

  it('paused: Resume instead of Pause all, and what the pause means', async () => {
    const { pauseAll } = await import('@/server/services/owner-controls');
    await pauseAll(rig.deps, owned.scope);
    const visible = text(await dashboard({ result: 'paused' }));
    expect(visible).toContain('Paused');
    expect(visible).toContain('Resume');
    expect(visible).not.toContain('Pause all');
    expect(visible).toContain("Autopilot is paused. New leads aren't read or drafted until you resume.");
    expect(visible).toContain("While it's paused, new leads aren't read or drafted");
  });

  it('shows result messages by own key only', async () => {
    expect(await dashboard({ result: 'constructor' })).toBe(await dashboard());
    expect(text(await dashboard({ result: 'lead_not_found' }))).toContain("We couldn't find that lead in your account.");
  });

  it('logging warnings say what cannot be confirmed and link to the inbox check', async () => {
    await getDb().query(`update accounts set logging_mode = 'sends_only' where id = $1`, [owned.accountId]);
    const html = await dashboard();
    expect(text(html)).toContain("So we can't tell when a lead replied. Check your inbox before you send a follow-up.");
    expect(html).toContain('href="/onboarding/inbox"');
  });
});

describe('/dashboard/leads/[id]', () => {
  it('a replied lead: the timeline, and "Resume follow-ups" with when it is useful', async () => {
    const db = getDb();
    const t0 = rig.clock.now();
    const { leadId } = await seedNotifiedLead(rig, { accountId: owned.accountId, firstNotifiedAt: t0 });
    await markRepliedLikeTheJob(db, leadId, at(t0, HOUR), at(t0, HOUR));
    const html = await leadPage(leadId);
    const visible = text(html);
    expect(visible).toContain('Replied');
    expect(visible).toContain('Lead replied (logged in HubSpot)');
    expect(visible).toContain('Draft emailed to you');
    expect(visible).toContain('Resume follow-ups');
    expect(visible).toContain('Use this if HubSpot logged an automatic reply from the lead, such as an out-of-office message.');
    expect(html).toContain(`name="lead_id" value="${leadId}"`);
    expect(visible).toContain('Follow-ups stopped: the lead replied (logged in HubSpot).');
    expect(visible).not.toContain('This is a real lead');
  });

  it('a filtered lead offers "This is a real lead" and "Not a real lead"', async () => {
    const leadId = await seedFilteredLead(getDb(), { accountId: owned.accountId, now: rig.clock.now() });
    const visible = text(await leadPage(leadId));
    expect(visible).toContain('This is a real lead');
    expect(visible).toContain('Not a real lead');
    expect(visible).toContain('Filtered as spam');
    expect(visible).not.toContain('Resume follow-ups');
  });

  it('shows the lead\'s message as unverified and defanged, and the draft', async () => {
    const db = getDb();
    const { leadId } = await seedNotifiedLead(rig, { accountId: owned.accountId, firstNotifiedAt: rig.clock.now() });
    await db.query(`update lead_messages set message = 'See https://evil.example/x' where lead_id = $1`, [leadId]);
    await seedDraft(db, { accountId: owned.accountId, leadId, purgeAt: at(rig.clock.now(), 30 * DAY) });
    const html = await leadPage(leadId);
    expect(text(html)).toContain('Message from the lead (unverified)');
    expect(text(html)).toContain('See hxxps://evil[.]example/x');
    expect(html).not.toContain('https://evil.example');
    expect(text(html)).toContain('Your first reply');
    expect(text(html)).toContain('Subject: Your leaking sink');
  });

  it('after the purge: the contact id, "This draft has expired" and the message removed', async () => {
    const db = getDb();
    const now = rig.clock.now();
    const leadId = await seedLeadIn(db, { accountId: owned.accountId, receivedAt: at(now, -31 * DAY), state: 'notified', contactId: '7001', set: { first_notified_at: at(now, -31 * DAY) } });
    await seedDraft(db, { accountId: owned.accountId, leadId, purgeAt: at(now, -HOUR) });
    await purgeContent(db, leadId, now);
    const visible = text(await leadPage(leadId));
    expect(visible).toContain('Contact #7001 (details removed after 30 days)');
    expect(visible).toContain('This draft has expired.');
    expect(visible).toContain('Removed 30 days after the form was submitted.');
    expect(visible).toContain('Drafts are deleted 30 days after the form was submitted.');
  });

  it('says HubSpot\'s logged emails could not be checked when the refresh could not read them all', async () => {
    const { leadId } = await seedNotifiedLead(rig, { accountId: owned.accountId, firstNotifiedAt: rig.clock.now() });
    current.refresh = { type: 'checked', emailsAvailable: false, replied: false, markedReplied: false };
    const visible = text(await leadPage(leadId));
    expect(visible).toContain("HubSpot's logged emails couldn't be checked just now, so we can't tell whether your send was logged or whether the lead replied.");
    expect(visible).toContain("HubSpot's logged emails haven't been checked in full for this lead yet.");
    current.refresh = { type: 'failed' };
    expect(text(await leadPage(leadId))).toContain("We couldn't reach HubSpot just now. This page shows what we knew before.");
  });

  it('a disconnected account: says HubSpot is disconnected, never that access to logged emails was not given', async () => {
    const db = getDb();
    const { leadId } = await seedNotifiedLead(rig, { accountId: owned.accountId, firstNotifiedAt: rig.clock.now() });
    await db.query(`update hubspot_connections set status = 'revoked' where account_id = $1`, [owned.accountId]);
    current.refresh = { type: 'not_eligible' };
    const visible = text(await leadPage(leadId));
    expect(visible).toContain("HubSpot is disconnected, so this lead can't be checked there until you reconnect.");
    expect(visible).not.toContain("HubSpot didn't give Autopilot access to logged emails");
    // Connected without the email scope: that reason, not the disconnected one.
    await db.query(`update hubspot_connections set status = 'active', scopes = $2 where account_id = $1`, [owned.accountId, ['oauth', 'crm.objects.contacts.read', 'forms']]);
    const noScope = text(await leadPage(leadId));
    expect(noScope).toContain("HubSpot didn't give Autopilot access to logged emails");
    expect(noScope).not.toContain('HubSpot is disconnected');
  });

  it('is a 404 for another account\'s lead and for a malformed id', async () => {
    const other = await seedOtherAccount(getDb(), rig.clock.now());
    const theirs = await seedFilteredLead(getDb(), { accountId: other.accountId, now: rig.clock.now() });
    expect(await navigationOf(() => leadPage(theirs))).toMatchObject({ kind: 'not_found' });
    expect(await navigationOf(() => leadPage('nope'))).toMatchObject({ kind: 'not_found' });
  });

  it('shows the outcome of a control by own key', async () => {
    const leadId = await seedFilteredLead(getDb(), { accountId: owned.accountId, now: rig.clock.now() });
    expect(text(await leadPage(leadId, { result: 'real_lead.queued' }))).toContain("We'll draft this lead now and email it to you");
    expect(await leadPage(leadId, { result: 'toString' })).toBe(await leadPage(leadId));
  });
});

describe('/dashboard/brief', () => {
  it('shows the editor filled with the saved brief, and the version history with the version in use', async () => {
    await saveOwnerBrief(owned.scope, rig.deps, {
      company_name: 'Brightside Plumbing',
      one_line: '',
      services: ['Repairs'],
      who_we_serve: '',
      tone: { style: 'friendly', note: '' },
      sign_off_name: 'Dana',
      allow_pricing: false,
      never_promise: [],
      faqs: [],
      booking_link_choice: 'none',
      booking_link: null,
      booking_link_confirmed: false,
    });
    // The seeded account's brief in force is version 1 without a history row; the save is version 2.
    const html = await briefPage({ saved: '2' });
    const visible = text(html);
    expect(html).toContain('name="company_name"');
    expect(html).toContain('value="Brightside Plumbing"');
    expect(visible).toContain('Saved as version 2. New drafts use it from now on.');
    expect(visible).toContain('Your saved brief (version 2). Saving again creates a new version.');
    expect(visible).toContain('Version 2');
    expect(visible).toContain('In use');
    expect(visible).toContain('Saved by you');
  });
});
