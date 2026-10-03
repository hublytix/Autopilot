import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDeps } from '@/server/adapters/fake';
import { createJobRegistry } from '@/server/jobs/registry';
import { createJobTestRig, type JobTestRig } from '@/server/jobs/testing';
import { startCheckout } from '@/server/services/billing';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import { onlySubscription, seedBillingAccount } from '../../../../test/billing/support';
import { createIntakeRig, leadsOf, type IntakeRig } from '../../../../test/intake/support';
import type { DevPanelContext } from './context';
import { handleDevAction, handleDevActionOtherMethod } from './dev-actions';

// The /dev panel's actions (fake mode only, PLAN §4, §7.6, D-29), each run on a fake rig through the
// real handler: a same-origin form POST, a 303 back to /dev with a result code. Outside fake mode
// (no context) the route is a 404. Each action plays its part through the real entry points:
// HubSpot's signed webhook, the job dispatcher, Razorpay's signed events.

const getDb = setUpTestDb();
const APP = 'http://localhost:3000';

beforeEach(() => {
  for (const method of ['info', 'warn', 'error', 'log'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function contextOf(rig: JobTestRig, reset: (() => Promise<void>) | null = null): DevPanelContext {
  return {
    deps: rig.deps,
    fakes: rig.fakes,
    clock: { advance: (ms) => rig.clock.advance(ms), reset, offsetMs: null },
    startingState: async () => {
      const { fakes } = createFakeDeps({ env: rig.deps.env, db: rig.deps.db, clock: rig.clock, mailSink: { kind: 'memory' } });
      return { hubspot: fakes.hubspot.snapshot(), billing: fakes.billing.snapshot(), auth: fakes.auth.snapshot() };
    },
    tickerRunning: false,
  };
}

function post(fields: Record<string, string>, headers: Record<string, string> = { origin: APP }): Request {
  return new Request(`${APP}/dev/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

/** Posts one action; returns the query /dev is sent back with. */
async function act(ctx: DevPanelContext, fields: Record<string, string>): Promise<Record<string, string>> {
  const res = await handleDevAction(post(fields), ctx);
  expect(res.status).toBe(303);
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  const location = res.headers.get('location') ?? '';
  expect(location.startsWith('/dev?')).toBe(true);
  expect(location.endsWith('#result')).toBe(true);
  return Object.fromEntries(new URL(location, APP).searchParams);
}

const NEW_LEAD = { firstName: 'Maya', lastName: 'Okafor', company: 'Okafor Bakery', message: 'Our sink leaks. Can someone come this week?' };

async function submissions(rig: JobTestRig): Promise<number> {
  return rig.fakes.hubspot.snapshot().submissions.length;
}

describe('the /dev action route', () => {
  it('is a 404 outside fake mode, for every method', async () => {
    expect((await handleDevAction(post({ action: 'run_jobs' }), null)).status).toBe(404);
    expect(handleDevActionOtherMethod(null).status).toBe(404);
  });

  it('answers 405 to anything but POST in fake mode', async () => {
    const ctx = contextOf(createJobTestRig(getDb(), createJobRegistry()));
    const res = handleDevActionOtherMethod(ctx);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('refuses a cross-origin post and changes nothing', async () => {
    const rig = await createIntakeRig(getDb());
    const before = await submissions(rig);
    const res = await handleDevAction(
      post({ action: 'submit_lead', form: rig.contactUs, email: 'maya@okafor-bakery.example', contact: 'new' }, { origin: 'https://evil.example' }),
      contextOf(rig),
    );
    expect(res.status).toBe(403);
    expect(await submissions(rig)).toBe(before);
  });

  it('refuses an unknown action, and reads a field sent twice as missing', async () => {
    const rig = createJobTestRig(getDb(), createJobRegistry());
    expect((await handleDevAction(post({ action: 'drop_tables' }), contextOf(rig))).status).toBe(400);
    const twice = new Request(`${APP}/dev/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: APP },
      body: 'action=advance&amount=1&amount=2&unit=hours',
    });
    const before = rig.clock.nowMs();
    const res = await handleDevAction(twice, contextOf(rig));
    expect(res.headers.get('location')).toBe('/dev?error=invalid_input#result');
    expect(rig.clock.nowMs()).toBe(before);
  });

  it('reads a multipart form as a browser posts it, and refuses a body over 16 KiB even without a Content-Length', async () => {
    const rig = createJobTestRig(getDb(), createJobRegistry());
    const ctx = contextOf(rig);
    const multipart = new FormData();
    for (const [name, value] of Object.entries({ action: 'advance', amount: '2', unit: 'hours' })) multipart.append(name, value);
    const before = rig.clock.nowMs();
    const res = await handleDevAction(new Request(`${APP}/dev/actions`, { method: 'POST', headers: { origin: APP }, body: multipart }), ctx);
    expect(res.headers.get('location')).toBe('/dev?done=advance#result');
    expect(rig.clock.nowMs()).toBe(before + 2 * 3_600_000);

    // A chunked body (no Content-Length) that grows past the limit is cut off and refused.
    const chunk = new TextEncoder().encode(`action=advance&amount=1&unit=hours&pad=${'x'.repeat(4096)}`);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 6; i += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    const oversized = new Request(`${APP}/dev/actions`, {
      method: 'POST',
      headers: { origin: APP, 'content-type': 'application/x-www-form-urlencoded' },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    const refused = await handleDevAction(oversized, ctx);
    expect(refused.headers.get('location')).toBe('/dev?error=invalid_input#result');
    expect(rig.clock.nowMs()).toBe(before + 2 * 3_600_000);
  });
});

describe('submit a lead', () => {
  let rig: IntakeRig;
  let ctx: DevPanelContext;

  beforeEach(async () => {
    rig = await createIntakeRig(getDb());
    ctx = contextOf(rig);
  });

  it('new contact: the submission is in fake HubSpot, its signed webhook reaches the real handler, and running due jobs reads it', async () => {
    const query = await act(ctx, { action: 'submit_lead', form: rig.contactUs, email: 'Maya@Okafor-Bakery.example', contact: 'new', ...NEW_LEAD });
    expect(query).toEqual({ done: 'submit_lead', webhook: '1' });
    expect(rig.hubspot.contactIdByEmail('maya@okafor-bakery.example')).not.toBeNull();
    expect(await getDb().query(`select provider, event_type from webhook_events`)).toEqual([{ provider: 'hubspot', event_type: 'object.creation' }]);

    const ran = await act(ctx, { action: 'run_jobs' });
    expect(ran.done).toBe('run_jobs');
    expect(Number(ran.count)).toBeGreaterThan(0);
    const leads = await leadsOf(getDb(), rig.accountId);
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ form_id: rig.contactUs, intake_trigger: 'webhook' });
  });

  it('existing contact: HubSpot sends no webhook, and the poll that "run due jobs" starts finds the submission', async () => {
    const existing = rig.hubspot.snapshot().contacts[0]?.properties.email ?? '';
    expect(existing).not.toBe('');
    const query = await act(ctx, { action: 'submit_lead', form: rig.quote, email: existing, contact: 'existing', message: 'A quote for a new boiler, please.' });
    expect(query).toEqual({ done: 'submit_lead', webhook: '0' });
    expect(await getDb().query('select 1 from webhook_events')).toEqual([]);

    await act(ctx, { action: 'run_jobs' });
    expect((await leadsOf(getDb(), rig.accountId)).map((lead) => lead.intake_trigger)).toEqual(['cron']);
  });

  it('refuses what the portal would not accept, and submits nothing', async () => {
    const before = await submissions(rig);
    const existing = rig.hubspot.snapshot().contacts[0]?.properties.email ?? '';
    const newsletter = rig.hubspot.formIdByName('Newsletter signup');
    const cases: [Record<string, string>, string][] = [
      [{ form: 'no-such-form', email: 'a@example.com', contact: 'any' }, 'unknown_form'],
      [{ form: newsletter, email: 'a@example.com', contact: 'any', message: 'Hello' }, 'field_not_on_form'],
      [{ form: rig.contactUs, email: existing, contact: 'new' }, 'contact_exists'],
      [{ form: rig.contactUs, email: 'nobody@example.com', contact: 'existing' }, 'no_such_contact'],
      [{ form: rig.contactUs, email: 'not-an-email', contact: 'any' }, 'invalid_input'],
      [{ form: rig.contactUs, email: 'a@example.com', contact: 'sometimes' }, 'invalid_input'],
    ];
    for (const [fields, error] of cases) {
      expect(await act(ctx, { action: 'submit_lead', ...fields }), error).toEqual({ error });
    }
    expect(await submissions(rig)).toBe(before);
  });
});

describe("HubSpot's side: sends, replies, the token, opt-outs", () => {
  let rig: IntakeRig;
  let ctx: DevPanelContext;
  const LEAD = 'maya@okafor-bakery.example';

  beforeEach(async () => {
    rig = await createIntakeRig(getDb());
    ctx = contextOf(rig);
    await act(ctx, { action: 'submit_lead', form: rig.contactUs, email: LEAD, contact: 'new', ...NEW_LEAD });
  });

  it("logs the owner's send and the lead's reply as HubSpot engagements", async () => {
    expect(await act(ctx, { action: 'log_send', to: LEAD })).toEqual({ done: 'log_send', logged: '1' });
    expect(await act(ctx, { action: 'log_reply', from: LEAD })).toEqual({ done: 'log_reply', logged: '1' });
    const state = rig.hubspot.snapshot();
    expect(state.emails.map((e) => ({ direction: e.direction, from: e.fromEmail, to: e.toEmails }))).toEqual(
      expect.arrayContaining([
        { direction: 'EMAIL', from: rig.hubspot.ownerEmail, to: [LEAD] },
        { direction: 'INCOMING_EMAIL', from: LEAD, to: [rig.hubspot.ownerEmail] },
      ]),
    );
    const contactId = rig.hubspot.contactIdByEmail(LEAD);
    expect(state.contacts.find((c) => c.id === contactId)?.properties.hs_sales_email_last_replied).toBe(rig.clock.now().toISOString());
  });

  it("says when the owner's mailbox logs nothing", async () => {
    rig.hubspot.setLoggingMode('none');
    expect(await act(ctx, { action: 'log_send', to: LEAD })).toEqual({ done: 'log_send', logged: '0' });
    expect(await act(ctx, { action: 'log_reply', from: LEAD })).toEqual({ done: 'log_reply', logged: '0' });
    expect(await act(ctx, { action: 'log_send', to: 'nope' })).toEqual({ error: 'invalid_input' });
  });

  it('revokes every refresh token, so the next refresh fails as revoked', async () => {
    const tokens = rig.hubspot.installTokens();
    expect(await act(ctx, { action: 'revoke_token' })).toEqual({ done: 'revoke_token' });
    expect(rig.hubspot.snapshot().oauth.refreshTokens.every((t) => t.revoked)).toBe(true);
    await expect(rig.deps.hubspot.refresh(tokens.refreshToken)).rejects.toMatchObject({ code: expect.stringMatching(/revoked|bad_refresh_token/i) });
  });

  it('opts a contact out of email; an unknown address is refused', async () => {
    expect(await act(ctx, { action: 'opt_out', email: LEAD })).toEqual({ done: 'opt_out' });
    const contactId = rig.hubspot.contactIdByEmail(LEAD);
    expect(rig.hubspot.snapshot().contacts.find((c) => c.id === contactId)?.properties.hs_email_optout).toBe('true');
    expect(await act(ctx, { action: 'opt_out', email: 'nobody@example.com' })).toEqual({ error: 'no_such_contact' });
  });
});

describe('time and jobs', () => {
  it('advances the clock by minutes, hours or days, and refuses anything else', async () => {
    const rig = createJobTestRig(getDb(), createJobRegistry());
    const ctx = contextOf(rig);
    const start = rig.clock.nowMs();
    expect(await act(ctx, { action: 'advance', amount: '90', unit: 'minutes' })).toEqual({ done: 'advance' });
    expect(rig.clock.nowMs() - start).toBe(90 * 60_000);
    await act(ctx, { action: 'advance', amount: '2', unit: 'days' });
    await act(ctx, { action: 'advance', amount: '3', unit: 'hours' });
    expect(rig.clock.nowMs() - start).toBe(90 * 60_000 + 2 * 86_400_000 + 3 * 3_600_000);
    for (const fields of [
      { amount: '0', unit: 'hours' },
      { amount: '1000', unit: 'hours' },
      { amount: '1.5', unit: 'hours' },
      { amount: '1', unit: 'weeks' },
    ]) {
      expect(await act(ctx, { action: 'advance', ...fields })).toEqual({ error: 'invalid_input' });
    }
    expect(rig.clock.nowMs() - start).toBe(90 * 60_000 + 2 * 86_400_000 + 3 * 3_600_000);
  });

  it('runs the daily maintenance: one account_daily job per account', async () => {
    const rig = await createIntakeRig(getDb());
    const query = await act(contextOf(rig), { action: 'run_daily' });
    expect(query.done).toBe('run_daily');
    expect(await getDb().query(`select account_id from scheduled_jobs where kind = 'account_daily'`)).toEqual([{ account_id: rig.accountId }]);
  });
});

describe("Razorpay's queued events", () => {
  it('delivers them, signed, to the real webhook handler', async () => {
    const rig = createJobTestRig(getDb(), createJobRegistry());
    const { accountId, scope } = await seedBillingAccount(rig);
    await startCheckout(rig.deps, scope);
    const id = rig.fakes.billing.subscriptionIds()[0] ?? '';
    rig.fakes.billing.authenticate(id);
    expect(await act(contextOf(rig), { action: 'deliver_razorpay' })).toEqual({ done: 'deliver_razorpay', count: '1', failed: '0' });
    expect(await onlySubscription(getDb(), accountId)).toMatchObject({ status: 'authenticated' });
    expect(await act(contextOf(rig), { action: 'deliver_razorpay' })).toEqual({ done: 'deliver_razorpay', count: '0', failed: '0' });
  });
});

describe('reset fake state', () => {
  it('asks for confirmation first', async () => {
    const rig = await createIntakeRig(getDb());
    expect(await act(contextOf(rig), { action: 'reset' })).toEqual({ error: 'confirm_reset' });
    expect(await getDb().query('select count(*)::int as n from accounts')).toEqual([{ n: 1 }]);
  });

  it('empties every table but the migration ledger, restores the fakes, drops the queue, resets the clock and signs the caller out', async () => {
    const rig = await createIntakeRig(getDb());
    const resetClock = vi.fn(async () => undefined);
    const ctx = contextOf(rig, resetClock);
    const fixtureContacts = rig.hubspot.snapshot().contacts.length;
    await act(ctx, { action: 'submit_lead', form: rig.contactUs, email: 'maya@okafor-bakery.example', contact: 'new', ...NEW_LEAD });
    const { userId } = await rig.fakes.auth.createUser('owner@brightside-plumbing.example');
    const session = rig.fakes.auth.issueSession(userId);
    await getDb().query(`insert into fake.dev_outbox (created_at, "to", subject, html, text, kind) values ($1, '{a@example.com}', 's', 'h', 't', 'k')`, [rig.clock.now()]);
    await getDb().query(`insert into fake.state (key, value) values ('hubspot_snapshot', '{}'::jsonb)`);
    expect(rig.fakes.scheduler.pending().length).toBeGreaterThan(0);
    const ledger = await getDb().query('select version from fake._migrations order by version');

    const res = await handleDevAction(post({ action: 'reset', confirm: 'yes' }, { origin: APP, cookie: `${session.name}=${session.value}` }), ctx);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/dev?done=reset#result');
    expect(res.headers.get('set-cookie')).toMatch(/^ap_session=;/);

    for (const table of ['accounts', 'leads', 'scheduled_jobs', 'webhook_events', 'hubspot_connections', 'fake.dev_outbox', 'fake.state', 'auth.users']) {
      expect(await getDb().query(`select count(*)::int as n from ${table}`), table).toEqual([{ n: 0 }]);
    }
    expect(await getDb().query('select version from fake._migrations order by version')).toEqual(ledger);
    expect(rig.hubspot.isInstalled()).toBe(false);
    expect(rig.hubspot.contactIdByEmail('maya@okafor-bakery.example')).toBeNull();
    expect(rig.hubspot.snapshot().contacts).toHaveLength(fixtureContacts);
    expect(rig.fakes.auth.users()).toEqual([]);
    expect(rig.fakes.billing.subscriptionIds()).toEqual([]);
    expect(rig.fakes.scheduler.pending()).toEqual([]);
    expect(resetClock).toHaveBeenCalledOnce();
  });
});
