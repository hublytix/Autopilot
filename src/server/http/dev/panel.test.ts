import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJobRegistry } from '@/server/jobs/registry';
import { createJobTestRig, type JobTestRig } from '@/server/jobs/testing';
import { startCheckout } from '@/server/services/billing';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import { seedBillingAccount } from '../../../../test/billing/support';
import type { DevPanelContext } from './context';
import { buildDevOutboxMail, withNewTabLinks } from './outbox';
import { buildDevPanelView, DEV_ACTIONS, DEV_ERRORS, devResult } from './panel';

// The /dev panel's read models (fake mode only, PLAN §4, §7.6): the panel (clock, queue, accounts
// with a link to each subscription's fake checkout, the fake portal as HubSpot's data, the outbox)
// and one outbox email for the sandboxed iframe. Outside fake mode both are null (the pages 404).

const getDb = setUpTestDb();

beforeEach(() => {
  for (const method of ['info', 'warn', 'error', 'log'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function contextOf(rig: JobTestRig, offsetMs: number | null = null): DevPanelContext {
  return {
    deps: rig.deps,
    fakes: rig.fakes,
    clock: { advance: (ms) => rig.clock.advance(ms), reset: null, offsetMs },
    startingState: async () => ({ hubspot: null, billing: null, auth: null }),
    tickerRunning: true,
  };
}

async function outboxRow(rig: JobTestRig, html: string, subject = 'New lead: Maya — your reply is ready'): Promise<string> {
  const row = await getDb().one<{ id: string }>(
    `insert into fake.dev_outbox (created_at, "to", subject, html, text, kind, meta)
     values ($1, '{owner@brightside-plumbing.example}', $2, $3, 'Plain text', 'new_lead', '{"replyTo":"dana@brightside-plumbing.example"}'::jsonb)
     returning id`,
    [rig.clock.now(), subject, html],
  );
  return row.id;
}

describe('the /dev panel view', () => {
  it('does not exist outside fake mode', async () => {
    expect(await buildDevPanelView(null, {})).toBeNull();
  });

  it('shows the fake clock, the accounts with a link to their open fake checkout, the fake portal and the outbox', async () => {
    const rig = createJobTestRig(getDb(), createJobRegistry());
    const { accountId, scope } = await seedBillingAccount(rig);
    await startCheckout(rig.deps, scope);
    const subscriptionId = rig.fakes.billing.subscriptionIds()[0] ?? '';
    const mailId = await outboxRow(rig, '<p>Hi</p>');

    const view = await buildDevPanelView(contextOf(rig, 2 * 86_400_000 + 3_600_000), {});
    expect(view).not.toBeNull();
    if (view === null) return;
    expect(view.now).toBe('2026-10-06 14:00 UTC');
    expect(view.offset).toBe('2 d 1 h ahead of real time');
    expect(view.tickerRunning).toBe(true);
    expect(view.actionPath).toBe('/dev/actions');
    expect(view.accounts).toEqual([
      expect.objectContaining({
        id: accountId,
        processingState: 'active',
        owned: true,
        subscriptions: [{ id: subscriptionId, status: 'created', checkoutPath: `/dev/fake-checkout/${subscriptionId}`, open: true }],
      }),
    ]);
    expect(view.portal.forms.map((form) => form.name)).toEqual(['Contact us', 'Request a quote', 'Newsletter signup']);
    expect(view.portal.forms[2]?.fields).toEqual(['email']);
    expect(view.portal.contacts.length).toBe(view.portal.contactCount);
    expect(view.portal.installed).toBe(false);
    expect(view.outbox).toEqual([
      expect.objectContaining({ id: mailId, kind: 'new_lead', to: 'owner@brightside-plumbing.example', path: `/dev/email/${mailId}` }),
    ]);
    expect(view.result).toBeNull();
  });

  it('lists the fake scheduler queue and the jobs by status', async () => {
    const rig = createJobTestRig(getDb(), createJobRegistry());
    await rig.fakes.scheduler.publish({ jobId: 'job-1', kind: 'portal_poll', runAt: new Date('2026-10-06T14:05:00.000Z'), dedupeId: 'd-1', retries: 4 });
    const view = await buildDevPanelView(contextOf(rig), {});
    expect(view?.queue).toEqual({ total: 1, next: [{ kind: 'portal_poll', runAt: '2026-10-06 14:05 UTC' }] });
    expect(view?.jobs).toEqual([]);
    expect(view?.offset).toBeNull();
  });
});

describe('the result line', () => {
  it('has a message for every action and every error code', () => {
    for (const done of DEV_ACTIONS) expect(devResult({ done }), done).not.toBeNull();
    for (const error of DEV_ERRORS) expect(devResult({ error })?.tone, error).toBe('error');
  });

  it('reads only its own codes and numbers from the query, never other text', () => {
    expect(devResult({ done: '<script>' })).toBeNull();
    expect(devResult({ error: 'Something <b>bad</b>' })).toBeNull();
    expect(devResult({ done: ['run_jobs', 'reset'] })).toBeNull();
    expect(devResult({ done: 'run_jobs', count: '3' })?.text).toBe('Ran the poll and the weekly-report check, and made 3 job deliveries.');
    expect(devResult({ done: 'run_jobs', count: 'many' })?.text).toBe('Ran the poll and the weekly-report check, and made 0 job deliveries.');
    expect(devResult({ done: 'deliver_razorpay', count: '1', failed: '2' })).toEqual({ tone: 'error', text: 'Delivered 1 Razorpay event; 2 not accepted.' });
    expect(devResult({ done: 'log_send', logged: '0' })?.tone).toBe('info');
  });
});

describe('one outbox email', () => {
  it('opens its links in a new tab: the base element goes first in <head>', () => {
    expect(withNewTabLinks('<!DOCTYPE html><html><head lang="en"><title>x</title></head><body><a href="/a">a</a></body></html>')).toBe(
      '<!DOCTYPE html><html><head lang="en"><base target="_blank"><title>x</title></head><body><a href="/a">a</a></body></html>',
    );
    expect(withNewTabLinks('<p>No head</p>')).toBe('<base target="_blank"><p>No head</p>');
    expect(withNewTabLinks('<header>Not a head</header>')).toBe('<base target="_blank"><header>Not a head</header>');
  });

  it('returns the headers, the HTML for the iframe and the text part', async () => {
    const rig = createJobTestRig(getDb(), createJobRegistry());
    const id = await outboxRow(rig, '<html><head></head><body>Hi</body></html>');
    expect(await buildDevOutboxMail(contextOf(rig), id)).toEqual({
      id,
      createdAt: '2026-10-06 14:00 UTC',
      to: 'owner@brightside-plumbing.example',
      replyTo: 'dana@brightside-plumbing.example',
      subject: 'New lead: Maya — your reply is ready',
      kind: 'new_lead',
      srcDoc: '<html><head><base target="_blank"></head><body>Hi</body></html>',
      text: 'Plain text',
      backPath: '/dev#outbox',
    });
  });

  it('does not exist outside fake mode, for a malformed id, or for an unknown one', async () => {
    const rig = createJobTestRig(getDb(), createJobRegistry());
    const id = await outboxRow(rig, '<p>Hi</p>');
    expect(await buildDevOutboxMail(null, id)).toBeNull();
    expect(await buildDevOutboxMail(contextOf(rig), "1' or '1'='1")).toBeNull();
    expect(await buildDevOutboxMail(contextOf(rig), '00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});
