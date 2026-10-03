import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJobRegistry } from '@/server/jobs/registry';
import { createJobTestRig, type JobTestRig } from '@/server/jobs/testing';
import { DEV_ACTIONS, type DevPanelContext } from '@/server/http/dev';
import { startCheckout } from '@/server/services/billing';
import { seedBillingAccount } from '../billing/support';
import { useTestDb as setUpTestDb } from '../db/harness';

// The /dev pages (fake mode only; 404 otherwise; PLAN §4, §7.6, D-29): the layout refuses them
// outside fake mode, the panel and the outbox page are 404s without a dev context, and in fake mode
// the panel offers every action as a plain same-origin form, links each subscription's fake
// checkout, and the outbox page renders an email in a sandboxed iframe that may not run scripts.

class Navigation extends Error {}

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Navigation('not_found');
  },
}));

const current: { ctx: DevPanelContext | null } = { ctx: null };
vi.mock('@/server/actions/dev', () => ({ getDevPanelContext: async () => current.ctx }));

const getDb = setUpTestDb();

function contextOf(rig: JobTestRig): DevPanelContext {
  return {
    deps: rig.deps,
    fakes: rig.fakes,
    clock: { advance: (ms) => rig.clock.advance(ms), reset: null, offsetMs: 0 },
    startingState: async () => ({ hubspot: null, billing: null, auth: null }),
    tickerRunning: true,
  };
}

async function panel(query: Record<string, string> = {}): Promise<string> {
  const { default: Page } = await import('@/app/dev/page');
  return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(query) }));
}

async function outboxPage(id: string): Promise<string> {
  const { default: Page } = await import('@/app/dev/email/[id]/page');
  return renderToStaticMarkup(await Page({ params: Promise.resolve({ id }) }));
}

beforeEach(() => {
  current.ctx = null;
  for (const method of ['info', 'warn', 'error', 'log'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('outside fake mode', () => {
  it('the /dev layout is a 404', async () => {
    vi.stubEnv('APP_MODE', 'live');
    const { default: DevLayout } = await import('@/app/dev/layout');
    expect(() => DevLayout({ children: null })).toThrow(Navigation);
  });

  it('the panel and the outbox page are 404s', async () => {
    await expect(panel()).rejects.toThrow(Navigation);
    await expect(outboxPage('00000000-0000-4000-8000-000000000000')).rejects.toThrow(Navigation);
  });

  it('the action route answers 404 to POST and GET', async () => {
    const route = await import('@/app/dev/actions/route');
    const res = await route.POST(new Request('http://localhost:3000/dev/actions', { method: 'POST', headers: { origin: 'http://localhost:3000' } }));
    expect(res.status).toBe(404);
    expect((await route.GET()).status).toBe(404);
  });

  it('every /dev page declares noindex', async () => {
    for (const load of [() => import('@/app/dev/page'), () => import('@/app/dev/email/[id]/page'), () => import('@/app/dev/layout')]) {
      expect((await load()).metadata.robots).toEqual({ index: false, follow: false });
    }
  });
});

describe('in fake mode', () => {
  it('the panel offers every action as a plain POST form to /dev/actions', async () => {
    const rig = createJobTestRig(getDb(), createJobRegistry());
    current.ctx = contextOf(rig);
    const markup = await panel();
    const forms = [...markup.matchAll(/<form\b[^>]*>/g)].map((m) => m[0]);
    expect(forms).toHaveLength(DEV_ACTIONS.length);
    for (const form of forms) {
      expect(form).toMatch(/\bmethod="post"/);
      expect(form).toMatch(/\baction="\/dev\/actions"/);
    }
    const actions = [...markup.matchAll(/<input type="hidden" name="action" value="([a-z_]+)"\/>/g)].map((m) => m[1]);
    expect([...actions].sort()).toEqual([...DEV_ACTIONS].sort());
    expect(markup).toContain('Submit a lead');
    expect(markup).toContain('Contact us (firstname, lastname, email, company, message)');
    const confirm = /<input id="dev-reset-confirm"[^>]*>/.exec(markup)?.[0] ?? '';
    for (const attribute of ['type="checkbox"', 'required=""', 'name="confirm"', 'value="yes"']) expect(confirm).toContain(attribute);
    expect(markup).toContain('Run due jobs now');
    expect(markup).toContain('Revoke the HubSpot token');
    expect(markup).toContain('Log the lead&#x27;s reply');
  });

  it("links the account's open fake checkout", async () => {
    const rig = createJobTestRig(getDb(), createJobRegistry());
    const { scope } = await seedBillingAccount(rig);
    await startCheckout(rig.deps, scope);
    const id = rig.fakes.billing.subscriptionIds()[0] ?? '';
    current.ctx = contextOf(rig);
    expect(await panel()).toContain(`<a href="/dev/fake-checkout/${id}" class="font-medium underline underline-offset-4">Open checkout</a>`);
  });

  it('shows the result of the last action from its code, and nothing for an unknown one', async () => {
    current.ctx = contextOf(createJobTestRig(getDb(), createJobRegistry()));
    expect(await panel({ done: 'run_jobs', count: '2' })).toContain('made 2 job deliveries');
    expect(await panel({ error: 'confirm_reset' })).toContain('Tick the box to confirm the reset.');
    expect(await panel({ error: '<b>x</b>' })).not.toContain('<b>x</b>');
  });

  it('the outbox lists each email and its page renders the HTML in a sandboxed iframe without scripts', async () => {
    const rig = createJobTestRig(getDb(), createJobRegistry());
    current.ctx = contextOf(rig);
    const { id } = await getDb().one<{ id: string }>(
      `insert into fake.dev_outbox (created_at, "to", subject, html, text, kind) values ($1, '{owner@example.com}', 'Your reply is ready', $2, 'Text part', 'new_lead') returning id`,
      [rig.clock.now(), '<html><head></head><body><a href="http://localhost:3000/a/x/send">Send</a><script>alert(1)</script></body></html>'],
    );
    expect(await panel()).toContain(`href="/dev/email/${id}"`);

    const markup = await outboxPage(id);
    const iframe = /<iframe[^>]*>/.exec(markup)?.[0] ?? '';
    expect(iframe).toContain('sandbox="allow-popups allow-popups-to-escape-sandbox"');
    expect(iframe).not.toContain('allow-scripts');
    expect(iframe).not.toContain('allow-same-origin');
    expect(iframe).toContain('srcDoc="&lt;html&gt;&lt;head&gt;&lt;base target=&quot;_blank&quot;&gt;&lt;/head&gt;');
    expect(markup).toContain('Text part');
    await expect(outboxPage('00000000-0000-4000-8000-000000000000')).rejects.toThrow(Navigation);
  });
});
