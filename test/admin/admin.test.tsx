import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { insertJob } from '@/server/jobs/outbox';
import { seedAccount, seedConnection } from '@/server/jobs/testing';
import type { Deps } from '@/server/ports';
import { seedSubscription } from '@/server/services/accounts/testing';
import { loadAdminOverview } from '@/server/services/admin';
import { formatUsd } from '@/server/views/admin';
import { seedDraft, seedLeadIn } from '../dashboard/support';
import { useTestDb as setUpTestDb } from '../db/harness';
import { seedSettingsAccount, setUpSettingsRig, type SettingsAccount, type SettingsRig } from '../settings/support';

// /admin (PLAN §7.5, brief §5.12): ADMIN_EMAILS only (everyone else gets a 404, as if the page did
// not exist); portals, processing states, trial and billing, the last webhooks, failed jobs, error
// counts, AI refusals and cost, the re-encryption backlog, failed owner emails; NO content (names,
// addresses, messages, drafts, hub domains); every view writes one `admin.view` audit row with no
// account and the viewing admin's auth user id (never the address, D-82). The session guard is the
// real one, on the fake AuthProvider's cookies.

const current: { deps: Deps | null; headers: Headers } = { deps: null, headers: new Headers() };

class Navigation extends Error {
  constructor(
    readonly kind: 'redirect' | 'not_found',
    readonly path: string | null,
  ) {
    super(kind);
  }
}

vi.mock('next/headers', () => ({ headers: async () => current.headers }));
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Navigation('redirect', path);
  },
  notFound: () => {
    throw new Navigation('not_found', null);
  },
}));
vi.mock('@/server/container', () => ({
  getDeps: async () => {
    if (current.deps === null) throw new Error('no deps');
    return current.deps;
  },
}));

const getDb = setUpTestDb();
const getRig = setUpSettingsRig(getDb);
let rig: SettingsRig;
let account: SettingsAccount;
let other: string;

/** Strings only content could put on the page. */
const CONTENT = ['Bartholomew', 'b-only-message', 'b-only-draft', 'lead@okafor-bakery.example', 'owner@brightside-plumbing.example', 'brightside-plumbing.com', 'fake-only-admin@example.com'];

const DAY = 24 * 60 * 60 * 1000;

function signedInAs(userId: string): Headers {
  const cookie = rig.fakes.auth.issueSession(userId);
  return new Headers({ cookie: `${cookie.name}=${cookie.value}` });
}

async function adminPage(): Promise<string> {
  const { default: Page } = await import('@/app/admin/page');
  return renderToStaticMarkup(await Page());
}

async function adminViews(): Promise<{ account_id: string | null; actor: string; action: string; meta: unknown }[]> {
  return getDb().query(`select account_id, actor, action, meta from audit_log where action = 'admin.view' order by id`);
}

async function failedJob(input: { accountId: string; kind: 'lead_process' | 'portal_poll' | 'followup'; code: string; finishedAt: Date; key: string }): Promise<string> {
  const db = getDb();
  const job = await db.tx((tx) => insertJob(tx, { kind: input.kind, accountId: input.accountId, dedupeKey: input.key, runAt: input.finishedAt, now: input.finishedAt }));
  if (job === null) throw new Error('job not inserted');
  await db.query(`update scheduled_jobs set status = 'failed', last_error_code = $2, finished_at = $3 where id = $1`, [job.id, input.code, input.finishedAt]);
  return job.id;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = getRig();
  current.deps = rig.deps;
  current.headers = new Headers();
  const db = getDb();
  const now = rig.clock.now();
  account = await seedSettingsAccount(rig);
  await db.query(`update hubspot_connections set hub_domain = 'brightside-plumbing.com', last_webhook_at = $2 where account_id = $1`, [account.accountId, now]);
  // A second account whose connection holds a token under an old key id (the re-encryption backlog).
  other = await seedAccount(db, { now });
  await seedConnection(db, { accountId: other, now });
  await seedSubscription(db, { accountId: other, status: 'pending', createdAt: now, graceUntil: new Date(now.getTime() + 3 * DAY) });

  // Content in every place a careless query could read it.
  const lead = await seedLeadIn(db, { accountId: account.accountId, receivedAt: now, firstName: 'Bartholomew', state: 'notified' });
  await db.query(`update lead_messages set message = 'b-only-message', email = 'lead@okafor-bakery.example' where lead_id = $1`, [lead]);
  await seedDraft(db, { accountId: account.accountId, leadId: lead, subject: 'b-only-draft subject', body: 'b-only-draft body', purgeAt: new Date(now.getTime() + 30 * DAY) });

  await failedJob({ accountId: account.accountId, kind: 'lead_process', code: 'ai_draft_transient', finishedAt: new Date(now.getTime() - DAY), key: 'lead:x1:process:r0' });
  await failedJob({ accountId: account.accountId, kind: 'lead_process', code: 'ai_draft_transient', finishedAt: new Date(now.getTime() - 2 * DAY), key: 'lead:x2:process:r0' });
  await failedJob({ accountId: other, kind: 'portal_poll', code: 'hubspot_server_error', finishedAt: new Date(now.getTime() - 3 * DAY), key: 'poll:x3:a' });
  // Older than 7 days: listed among recent failures, not counted in the 7-day numbers.
  await failedJob({ accountId: other, kind: 'followup', code: 'resend_unknown_error', finishedAt: new Date(now.getTime() - 9 * DAY), key: 'lead:x4:fu:1:s0' });

  const ai = (created: Date, outcome: string, cost: number, refusal: string | null) =>
    db.query(`insert into ai_calls (account_id, purpose, model, cost_micro_usd, outcome, refusal_category, created_at) values ($1, 'draft', 'fake-model', $2, $3, $4, $5)`, [
      account.accountId,
      cost,
      outcome,
      refusal,
      created,
    ]);
  await ai(new Date(now.getTime() - DAY), 'ok', 1_234_567, null);
  await ai(new Date(now.getTime() - 2 * DAY), 'refusal', 5_000, 'cyber');
  await ai(new Date(now.getTime() - 20 * DAY), 'ok', 10_000_000, null);
  await ai(new Date(now.getTime() - 20 * DAY), 'refusal', 0, 'bio');
  await ai(new Date(now.getTime() - 40 * DAY), 'ok', 99_000_000, null);

  await db.query(
    `insert into webhook_events (provider, dedupe_key, portal_id, account_id, event_type, outcome, recorded_at) values ('hubspot', 'k1', $1, $2, 'contact.creation', 'polled', $3)`,
    [account.portalId, account.accountId, now],
  );
  await db.query(
    `insert into notifications_sent (dedupe_key, account_id, kind, status, first_reserved_at, reserved_at) values
       ('n1', $1, 'new_lead', 'failed', $2, $2), ('n2', $1, 'new_lead', 'failed', $2, $2), ('n3', $1, 'follow_up', 'sending', $3, $3)`,
    [account.accountId, new Date(now.getTime() - DAY), new Date(now.getTime() - 2 * 60 * 60 * 1000)],
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('/admin access', () => {
  it('an admin sees the page, and the view is audited with which admin looked (actor admin, no account, the auth user id only)', async () => {
    const { userId } = await rig.fakes.auth.createUser('fake-only-admin@example.com');
    current.headers = signedInAs(userId);
    const html = await adminPage();
    expect(html).toContain('<h1');
    expect(await adminViews()).toEqual([{ account_id: null, actor: 'admin', action: 'admin.view', meta: { adminUserId: userId } }]);
    expect(JSON.stringify(await adminViews())).not.toContain('fake-only-admin');
    await adminPage();
    expect(await adminViews()).toHaveLength(2);
  });

  it('a signed-in owner gets a 404, and nothing is audited', async () => {
    const { userId } = await rig.fakes.auth.createUser('owner@brightside-plumbing.example');
    current.headers = signedInAs(userId);
    await expect(adminPage()).rejects.toMatchObject({ kind: 'not_found' });
    expect(await adminViews()).toEqual([]);
  });

  it('no session (or an expired one) gets a 404', async () => {
    await expect(adminPage()).rejects.toMatchObject({ kind: 'not_found' });
    const { userId } = await rig.fakes.auth.createUser('fake-only-admin@example.com');
    current.headers = signedInAs(userId);
    rig.clock.advance({ days: 60 });
    await expect(adminPage()).rejects.toMatchObject({ kind: 'not_found' });
    expect(await adminViews()).toEqual([]);
  });

  it('asks robots not to index or follow', async () => {
    const { metadata } = await import('@/app/admin/page');
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});

describe('/admin content', () => {
  it('shows portals, states, billing, webhooks, failed jobs, errors, AI, the backlog and failed emails, and no content at all', async () => {
    const { userId } = await rig.fakes.auth.createUser('fake-only-admin@example.com');
    current.headers = signedInAs(userId);
    const html = await adminPage();
    for (const marker of CONTENT) expect(html, marker).not.toContain(marker);
    expect(html).toContain(account.portalId);
    expect(html).toContain(account.accountId);
    expect(html).toContain('pending (grace until');
    expect(html).toContain('ai_draft_transient');
    expect(html).toContain('hubspot_server_error');
    expect(html).toContain('resend_unknown_error');
    expect(html).toContain('3 in the last 7 days.');
    expect(html).toMatch(/data-testid="reencrypt-backlog"[^>]*>1</);
    expect(html).toContain('Still sending after an hour: 1');
    expect(html).toContain('$1.24');
    expect(html).toContain('$11.24');
  });

  it('the overview counts by window and code', async () => {
    const overview = await loadAdminOverview(rig.deps);
    expect(overview.failedJobs.total7d).toBe(3);
    expect(overview.failedJobs.byKind7d).toEqual([
      { code: 'lead_process', count: 2 },
      { code: 'portal_poll', count: 1 },
    ]);
    expect(overview.failedJobs.recent.map((job) => job.errorCode)).toEqual(['ai_draft_transient', 'ai_draft_transient', 'hubspot_server_error', 'resend_unknown_error']);
    expect(overview.jobErrorCodes7d).toEqual([
      { code: 'ai_draft_transient', count: 2 },
      { code: 'hubspot_server_error', count: 1 },
    ]);
    expect(overview.aiOutcomes7d).toEqual([{ code: 'refusal', count: 1 }]);
    expect(overview.ai.last7d).toEqual({ calls: 2, refusals: 1, costMicroUsd: 1_239_567 });
    expect(overview.ai.last30d).toEqual({ calls: 4, refusals: 2, costMicroUsd: 11_239_567 });
    expect(overview.reencryptBacklog).toBe(1);
    expect(overview.notifications).toEqual({ failed7dByKind: [{ code: 'new_lead', count: 2 }], stuckSending: 1 });
    expect(overview.webhooks.hubspot).toBeInstanceOf(Date);
    expect(overview.webhooks.razorpay).toBeNull();
    expect(overview.portals.map((portal) => [portal.accountId, portal.subscriptionStatus]).sort()).toEqual(
      [
        [account.accountId, null],
        [other, 'pending'],
      ].sort(),
    );
    expect(overview.processingStateCounts).toEqual([{ code: 'active', count: 2 }]);
    // Reading never writes: the audit row is the view's, not the overview's.
    expect(await adminViews()).toEqual([]);
  });

  it('formats micro-dollars as dollars', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(1_234_567)).toBe('$1.23');
    expect(formatUsd(1_235_000)).toBe('$1.24');
  });
});
