import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxCheckPageView, InboxCheckView } from '@/server/views/inbox';

// /onboarding/inbox (PLAN §7.5, §9.7, D-14) rendered for each phase of the check: the one-sentence
// why, the history counts, the legs with ✓/✗, the fix steps that tell "test contact missing" from
// "not logged", and Continue / Skip. The view, the session guard and the actions are stubbed.

const state: { view: InboxCheckPageView | null } = { view: null };

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock('@/server/container', () => ({ getDeps: async () => ({}) }));
vi.mock('@/server/http/auth/guards', () => ({ requireOwnerPage: async () => ({ accountId: 'a', userId: 'u' }) }));
vi.mock('@/server/actions/inbox/inbox-check', () => ({ startInboxCheckAction: async () => undefined, skipInboxCheckAction: async () => undefined }));
vi.mock('@/server/views/inbox', () => ({
  loadInboxCheckPage: async () => {
    if (state.view === null) throw new Error('no view');
    return state.view;
  },
}));

const BASE: InboxCheckPageView = {
  loggingMode: 'unknown',
  ownerEmail: 'owner@brightside-plumbing.example',
  bccSaved: false,
  emailScope: true,
  canStart: true,
  onboardingComplete: false,
  check: null,
};

const CHECK: InboxCheckView = {
  phase: 'running',
  testAddress: 'owner.personal@example.net',
  history: { status: 'ok', outbound: 4, inbound: 1 },
  send: { status: 'pending', until: '9:13 AM' },
  reply: { status: 'pending', until: '9:23 AM' },
  result: null,
};

async function render(view: InboxCheckPageView, query: Record<string, string> = {}): Promise<string> {
  state.view = view;
  const { default: Page } = await import('@/app/onboarding/inbox/page');
  return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(query) }));
}

beforeEach(() => {
  state.view = null;
});

describe('/onboarding/inbox', () => {
  it('explains why in one sentence and offers the test and Skip before anything ran', async () => {
    const html = await render(BASE);
    expect(html).toContain('can only see replies from leads that HubSpot logs, so let&#x27;s check your email is logged.');
    expect(html).toContain('We count these when you start the test.');
    expect(html).toContain('<label for="test_address"');
    expect(html).toContain('Start the test');
    expect(html).toContain('Skip for now');
    expect(html).not.toContain('Continue');
  });

  it('shows the history counts and the legs while the check runs, with Continue and Skip', async () => {
    const html = await render({ ...BASE, check: CHECK }, { result: 'started' });
    expect(html).toContain('Test email sent to you');
    // Portal-wide counts: labelled as what HubSpot logged, never as "you sent" (law 3).
    expect(html).toMatch(/Outgoing emails logged<\/dt><dd[^>]*>4</);
    expect(html).toMatch(/Incoming emails from contacts logged<\/dt><dd[^>]*>1</);
    expect(html).toContain('All one-to-one emails logged in your HubSpot account in the last 30 days');
    expect(html).not.toContain('Emails you sent');
    expect(html).toContain('Checking until 9:13 AM');
    expect(html).toContain('Checking until 9:23 AM');
    expect(html).toContain('Continue — we&#x27;ll keep checking');
    expect(html).toContain('Skip for now');
    expect(html).toContain('href="/onboarding/baseline"');
  });

  it('marks passed legs with ✓ and offers only Continue once the check finished', async () => {
    const html = await render({
      ...BASE,
      loggingMode: 'log_all',
      check: { ...CHECK, phase: 'finished', result: 'log_all', send: { status: 'passed', until: null }, reply: { status: 'passed', until: null } },
    });
    expect(html).toContain('Your email is logged');
    expect(html.match(/✓/g)).toHaveLength(2);
    expect(html).toContain('>Continue<');
    expect(html).not.toContain('Skip for now');
  });

  it('gives "not logged" fix steps for a failed send leg', async () => {
    const html = await render({
      ...BASE,
      check: { ...CHECK, phase: 'finished', result: 'none', send: { status: 'failed', until: null }, reply: { status: 'failed', until: null } },
    });
    expect(html).toContain('HubSpot didn&#x27;t log the email you sent');
    expect(html).toContain('Connect personal email');
    expect(html).toContain('Log all emails to/from known contacts');
    expect(html.match(/✗/g)).toHaveLength(2);
    expect(html).not.toContain('has no contact');
  });

  it('says replies are not logged when only the send leg passed', async () => {
    const html = await render({
      ...BASE,
      check: { ...CHECK, phase: 'finished', result: 'sends_only', send: { status: 'passed', until: null }, reply: { status: 'failed', until: null } },
    });
    expect(html).toContain('Your sends are logged, but replies from leads aren&#x27;t');
    expect(html).toContain('A BCC address logs only what you send.');
  });

  it('gives "test contact missing" fix steps, distinct from "not logged"', async () => {
    const html = await render(
      { ...BASE, check: { ...CHECK, phase: 'needs_contact', send: { status: 'pending', until: null }, reply: { status: 'pending', until: null } } },
      { result: 'test_contact_missing' },
    );
    expect(html).toContain('HubSpot has no contact for this address yet');
    expect(html).toContain('href="/onboarding/preferences"');
    expect(html).toContain('fill in one of your own website forms');
    expect(html).not.toContain('HubSpot didn&#x27;t log the email you sent');
    expect(html).toContain('value="owner.personal@example.net"');
    expect(html).toContain('Start the test again');
  });

  it('says the counts are unavailable without the email scope', async () => {
    const html = await render({ ...BASE, emailScope: false, check: { ...CHECK, history: { status: 'unavailable' } } });
    expect(html).toContain('we can&#x27;t count logged emails');
  });

  it('says there is not enough logged history when HubSpot logged nothing', async () => {
    const html = await render({ ...BASE, check: { ...CHECK, history: { status: 'ok', outbound: 0, inbound: 0 } } });
    expect(html).toContain('Not enough logged history');
  });

  it('ignores a ?result= code that is not one of its own (constructor, toString, …)', async () => {
    const plain = await render(BASE);
    for (const result of ['constructor', 'toString', '__proto__']) {
      expect(await render(BASE, { result }), result).toBe(plain);
    }
  });
});
