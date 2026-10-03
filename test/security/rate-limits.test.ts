import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleConfirmPost } from '@/server/http/auth/confirm';
import { handleHubSpotCallback } from '@/server/http/hubspot-callback';
import { handleHubSpotInstall } from '@/server/http/hubspot-install';
import {
  ACTION_LINK_MESSAGES,
  copyPageState,
  dismissPageState,
  editPageState,
  handleBeacon,
  handleSendLink,
  submitDismissForm,
  submitEditForm,
} from '@/server/http/action-links';
import { createJobRegistry } from '@/server/jobs/registry';
import { createJobTestRig, type JobTestRig } from '@/server/jobs/testing';
import { generateActionToken, mintActionTokens } from '@/server/security/action-tokens';
import { seedOwner } from '@/server/services/accounts/testing';
import { seedSendableLead } from '@/server/services/action-links/testing';
import { requestLoginLink } from '@/server/services/auth/login';
import { submitOnboardingEmail } from '@/server/services/auth/onboarding-email';
import { confirmPostRequest, deliveredMagicLinks, seedPendingInstall } from '@/server/services/auth/testing';
import { confirmNotifyAddress, verifyNotifyKey } from '@/server/services/onboarding';
import { verifyNotifyPageState } from '@/server/views/onboarding/verify-notify';
import { useTestDb as setUpTestDb } from '../db/harness';

// The rate-limit audit (brief §7 "Rate limits on public action and auth routes", PLAN §10.11, D-36):
// every public action and auth route is enumerated from the build (a new one fails the
// classification test until it is listed), and each limited one is driven through its real entry
// point (route handler, page state or Server Action body) with real Requests and headers until the
// limit: the Nth request is served, the N+1th is refused, another client is still served, and the
// window ends. Limits (D-36): /login and /onboarding/email 5 per 15 min per IP and 3 per email;
// POST /auth/confirm 10 per 15 min per IP; /api/hubspot/install and the OAuth callback 20 per minute
// per IP; every /a/* link 30 per minute per IP (shared) and 20 per minute per token.

const APP = 'http://localhost:3000';
const getDb = setUpTestDb();
let rig: JobTestRig;

beforeEach(() => {
  for (const method of ['info', 'warn', 'error', 'log'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
  rig = createJobTestRig(getDb(), createJobRegistry());
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── the inventory ───────────────────────────────────────────────────────────────────────────────

function filesUnder(dir: string, name: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, name));
    else if (name(entry)) out.push(relative(process.cwd(), full).split('\\').join('/'));
  }
  return out.sort();
}

/** Every route handler, by what protects it. `rate_limited` ones are proven below. */
const ROUTES: Readonly<Record<string, 'rate_limited' | 'signature' | 'cron' | 'owner' | 'dev_only' | 'no_state'>> = {
  'src/app/a/[token]/beacon/route.ts': 'rate_limited',
  'src/app/a/[token]/send/route.ts': 'rate_limited',
  'src/app/api/hubspot/install/route.ts': 'rate_limited',
  'src/app/api/hubspot/oauth/callback/route.ts': 'rate_limited',
  // POST is limited (proven below); GET is a static page that reads nothing.
  'src/app/auth/confirm/route.ts': 'rate_limited',
  'src/app/api/hubspot/webhooks/route.ts': 'signature',
  'src/app/api/razorpay/webhook/route.ts': 'signature',
  'src/app/api/jobs/run/route.ts': 'signature',
  'src/app/api/jobs/failed/route.ts': 'signature',
  'src/app/api/cron/poll/route.ts': 'cron',
  'src/app/api/cron/daily/route.ts': 'cron',
  'src/app/api/cron/weekly-report/route.ts': 'cron',
  'src/app/api/billing/checkout/route.ts': 'owner',
  'src/app/api/billing/cancel/route.ts': 'owner',
  'src/app/api/billing/resume/route.ts': 'owner',
  'src/app/api/onboarding/status/route.ts': 'owner',
  'src/app/dev/actions/route.ts': 'dev_only',
  'src/app/dev/fake-checkout/[id]/decision/route.ts': 'dev_only',
  'src/app/dev/fake-hubspot/authorize/decision/route.ts': 'dev_only',
  // { ok, mode } only.
  'src/app/api/health/route.ts': 'no_state',
  // Same-origin POST that ends the caller's own session; it can act on nobody else.
  'src/app/auth/signout/route.ts': 'no_state',
};

/** 'use server' modules without the owner check: every one is a public action proven below. */
const PUBLIC_ACTION_MODULES = [
  'src/server/actions/action-links/dismiss.ts',
  'src/server/actions/action-links/edit.ts',
  'src/server/actions/auth/login.ts',
  'src/server/actions/auth/onboarding-email.ts',
  'src/server/actions/onboarding/verify-notify.ts',
] as const;

describe('the inventory of public action and auth routes', () => {
  it('every route handler is classified', () => {
    expect(filesUnder('src/app', (file) => file === 'route.ts')).toEqual(Object.keys(ROUTES).sort());
  });

  it("every Server Action module is owner-only (requireOwnerAction) or a public one listed here", () => {
    const modules = filesUnder('src/server/actions', (file) => file.endsWith('.ts') && !file.endsWith('.test.ts')).filter((file) =>
      readFileSync(file, 'utf8').startsWith("'use server'"),
    );
    const publicOnes = modules.filter((file) => !readFileSync(file, 'utf8').includes('requireOwnerAction()'));
    expect(publicOnes).toEqual([...PUBLIC_ACTION_MODULES]);
  });
});

// ── auth routes ─────────────────────────────────────────────────────────────────────────────────

const OWNER = 'owner@brightside-plumbing.example';

async function login(email: string, ip: string): Promise<void> {
  const deferred: Promise<void>[] = [];
  await requestLoginLink(rig.deps, { email, ip }, { sleep: async () => undefined, defer: (work) => deferred.push(work) });
  await Promise.all(deferred);
}

async function boundOwner(): Promise<void> {
  const { accountId } = await seedPendingInstall(rig.deps);
  const { userId } = await rig.fakes.auth.createUser(OWNER);
  await seedOwner(getDb(), accountId, OWNER, userId);
}

describe('/login (5 per 15 min per IP, 3 per email)', () => {
  it('the 6th request from one IP sends nothing, even for an owner; another IP still can', async () => {
    await boundOwner();
    for (let i = 0; i < 5; i += 1) await login(`nobody-${i}@example.net`, '198.51.100.1');
    await login(OWNER, '198.51.100.1');
    expect(deliveredMagicLinks(rig.fakes)).toHaveLength(0);
    await login(OWNER, '198.51.100.2');
    expect(deliveredMagicLinks(rig.fakes)).toHaveLength(1);
  });

  it('the 4th request for one email sends nothing, whatever the IP; after 15 minutes it works again', async () => {
    await boundOwner();
    for (let i = 0; i < 3; i += 1) await login(OWNER, `198.51.100.${10 + i}`);
    expect(deliveredMagicLinks(rig.fakes)).toHaveLength(3);
    await login(OWNER, '198.51.100.20');
    expect(deliveredMagicLinks(rig.fakes)).toHaveLength(3);
    rig.clock.advance({ minutes: 15 });
    await login(OWNER, '198.51.100.21');
    expect(deliveredMagicLinks(rig.fakes)).toHaveLength(4);
  });
});

describe('POST /auth/confirm (10 per 15 min per IP)', () => {
  it('the 11th POST from one IP is a 429 with Retry-After; another IP is still served', async () => {
    const post = (ip: string) => handleConfirmPost(confirmPostRequest(APP, { tokenHash: 'pkce_0123456789abcdef', type: 'email', ip }), rig.deps);
    for (let i = 0; i < 10; i += 1) expect((await post('198.51.100.30')).status).toBe(303);
    const refused = await post('198.51.100.30');
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await post('198.51.100.31')).status).toBe(303);
    rig.clock.advance({ minutes: 15 });
    expect((await post('198.51.100.30')).status).toBe(303);
  });
});

describe('/onboarding/email (5 per 15 min per IP, 3 per email)', () => {
  it('the 6th submit from one IP is refused', async () => {
    const { cookie } = await seedPendingInstall(rig.deps);
    const submit = (email: string, ip: string) => submitOnboardingEmail(rig.deps, { pendingCookie: cookie.value, email, ip });
    for (let i = 0; i < 5; i += 1) expect(await submit('not-an-email', '198.51.100.40')).toEqual({ type: 'invalid_email' });
    expect(await submit('dana@brightside-plumbing.example', '198.51.100.40')).toEqual({ type: 'rate_limited' });
    expect(await submit('dana@brightside-plumbing.example', '198.51.100.41')).not.toEqual({ type: 'rate_limited' });
  });

  it('the 4th submit for one email is refused, whatever the IP', async () => {
    const { cookie } = await seedPendingInstall(rig.deps);
    const submit = (email: string, ip: string) => submitOnboardingEmail(rig.deps, { pendingCookie: cookie.value, email, ip });
    for (let i = 0; i < 3; i += 1) expect(await submit('dana@brightside-plumbing.example', `198.51.100.${50 + i}`)).not.toEqual({ type: 'rate_limited' });
    expect(await submit('dana@brightside-plumbing.example', '198.51.100.60')).toEqual({ type: 'rate_limited' });
  });
});

describe('/api/hubspot/install and the OAuth callback (20 per minute per IP each)', () => {
  it('the 21st install from one IP is a 429; another IP is still redirected to HubSpot', async () => {
    const install = (ip: string) => handleHubSpotInstall(new Request(`${APP}/api/hubspot/install`, { headers: { 'x-real-ip': ip } }), rig.deps);
    for (let i = 0; i < 20; i += 1) expect((await install('198.51.100.70')).status).toBe(302);
    const refused = await install('198.51.100.70');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).not.toBeNull();
    expect((await install('198.51.100.71')).status).toBe(302);
    rig.clock.advance({ minutes: 1 });
    expect((await install('198.51.100.70')).status).toBe(302);
  });

  it('the 21st callback from one IP is a 429 before anything is checked; another IP is answered', async () => {
    const callback = (ip: string) => handleHubSpotCallback(new Request(`${APP}/api/hubspot/oauth/callback?code=c&state=s`, { headers: { 'x-real-ip': ip } }), rig.deps);
    for (let i = 0; i < 20; i += 1) expect((await callback('198.51.100.80')).status).toBe(303);
    expect((await callback('198.51.100.80')).status).toBe(429);
    expect((await callback('198.51.100.81')).status).toBe(303);
  });
});

// ── /a/* action links ───────────────────────────────────────────────────────────────────────────

interface Tokens {
  send: string;
  edit: string;
  dismiss: string;
  verify: string;
}

async function seedTokens(): Promise<Tokens> {
  const now = rig.clock.now();
  const lead = await seedSendableLead(getDb(), { now });
  const verify = await mintActionTokens(getDb(), {
    accountId: lead.accountId,
    notificationKey: verifyNotifyKey(rig.deps.env, lead.accountId, 'office@example.com', now),
    purposes: ['verify_notify'],
    now,
  });
  if (verify.verify_notify === undefined) throw new Error('verify token not minted');
  return { send: lead.sendToken, edit: lead.editToken, dismiss: lead.dismissToken, verify: verify.verify_notify };
}

function pageHeaders(ip: string): Headers {
  return new Headers({ 'x-real-ip': ip, origin: APP, 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/138.0.0.0 Safari/537.36' });
}

type Probe = (tokens: Tokens, ip: string) => Promise<boolean>;

const rateLimitedMessage = (state: unknown): boolean => JSON.stringify(state) === JSON.stringify({ type: 'message', message: ACTION_LINK_MESSAGES.rateLimited });

/** Each /a/* entry point: true when the request was refused by the rate limit. */
const ACTION_LINKS: readonly [string, Probe][] = [
  ['GET /a/{t}/send', async (t, ip) => (await handleSendLink(new Request(`${APP}/a/${t.send}/send`, { headers: pageHeaders(ip) }), rig.deps, t.send)).status === 429],
  ['GET /a/{t}/copy', async (t, ip) => rateLimitedMessage(await copyPageState(rig.deps, t.send, pageHeaders(ip)))],
  ['GET /a/{t}/edit', async (t, ip) => rateLimitedMessage(await editPageState(rig.deps, t.edit, pageHeaders(ip)))],
  [
    'POST /a/{t}/edit',
    async (t, ip) => {
      const formData = new FormData();
      formData.set('subject', 'Re: your enquiry');
      formData.set('body', 'Hi Jane,\n\nThanks.\n\nSam');
      return rateLimitedMessage(await submitEditForm(rig.deps, t.edit, { headers: pageHeaders(ip), formData }));
    },
  ],
  ['GET /a/{t}/dismiss', async (t, ip) => rateLimitedMessage(await dismissPageState(rig.deps, t.dismiss, pageHeaders(ip)))],
  ['POST /a/{t}/dismiss', async (t, ip) => (await submitDismissForm(rig.deps, t.dismiss, pageHeaders(ip))) === 'rate_limited'],
  ['GET /a/{t}/verify-notify', async (t, ip) => (await verifyNotifyPageState(rig.deps, t.verify, pageHeaders(ip))).type === 'rate_limited'],
  ['POST /a/{t}/verify-notify', async (t, ip) => (await confirmNotifyAddress(rig.deps, { token: t.verify, ip })).type === 'rate_limited'],
  [
    'POST /a/{t}/beacon',
    async (t, ip) =>
      (
        await handleBeacon(
          new Request(`${APP}/a/${t.send}/beacon`, { method: 'POST', headers: { ...Object.fromEntries(pageHeaders(ip)), 'content-type': 'application/json' }, body: '{"n":"x"}' }),
          rig.deps,
          t.send,
        )
      ).status === 429,
  ],
];

describe('/a/* (20 per minute per token, 30 per minute per IP across every link)', () => {
  it.each(ACTION_LINKS)('%s: the 21st request with one token is refused; the window ends after a minute', async (_name, probe) => {
    const tokens = await seedTokens();
    // Distinct IPs, so only the per-token count can refuse.
    for (let i = 0; i < 20; i += 1) expect(await probe(tokens, `203.0.113.${i + 1}`), `request ${i + 1}`).toBe(false);
    expect(await probe(tokens, '203.0.113.100')).toBe(true);
    rig.clock.advance({ minutes: 1 });
    expect(await probe(tokens, '203.0.113.101')).toBe(false);
  });

  it.each(ACTION_LINKS)('%s: the 31st /a/* request from one IP is refused, even with a fresh token; another IP is served', async (_name, probe) => {
    const tokens = await seedTokens();
    // 30 requests from one IP across other links (unknown tokens of the right shape): one count for all of /a/*.
    for (let i = 0; i < 30; i += 1) {
      const other = generateActionToken();
      const state = i % 2 === 0 ? await copyPageState(rig.deps, other, pageHeaders('192.0.2.50')) : await dismissPageState(rig.deps, other, pageHeaders('192.0.2.50'));
      expect(rateLimitedMessage(state), `request ${i + 1}`).toBe(false);
    }
    expect(await probe(tokens, '192.0.2.50')).toBe(true);
    expect(await probe(tokens, '192.0.2.51')).toBe(false);
  });
});
