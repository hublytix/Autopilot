import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CopyPageState } from '@/server/http/action-links';

// /a/[token]/copy (PLAN §7.4, D-46) rendered for each state. The page state is stubbed; its logic is
// tested in src/server/http/action-links/copy.test.ts.

const state: { value: CopyPageState | null } = { value: null };

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/server/container', () => ({ getDeps: async () => ({}) }));
vi.mock('@/server/http/action-links', () => ({
  copyPageState: async () => {
    if (state.value === null) throw new Error('no state');
    return state.value;
  },
}));

const TOKEN = 'apt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const COPY: Extract<CopyPageState, { type: 'copy' }> = {
  type: 'copy',
  view: {
    recipient: 'jane@example.com',
    recipientValid: true,
    subject: 'Re: Your enquiry',
    body: 'Hi Jane,\n\nThanks for reaching out.\n\nBest,\nSam',
    bcc: '1234567@bcc.hubspot.com',
    mailtoFits: true,
    beaconNonce: 'BBBBBBBBBBBBBBBBBBBBBB',
  },
  beaconPath: `/a/${TOKEN}/beacon`,
  mailtoPath: `/a/${TOKEN}/send?via=mailto`,
  neverSends: 'Hublytix Autopilot never sends email for you: your reply goes out only when you send it from your own mail app.',
};

async function render(value: CopyPageState): Promise<string> {
  state.value = value;
  const { default: Page } = await import('./page');
  return renderToStaticMarkup(await Page({ params: Promise.resolve({ token: TOKEN }) }));
}

beforeEach(() => {
  state.value = null;
});

describe('/a/[token]/copy', () => {
  it('shows the recipient, subject, message and BCC address, each with its own copy button', async () => {
    const html = await render(COPY);
    expect(html).toContain('<h1');
    expect(html).toContain('Copy your reply');
    for (const [title, label] of [
      ['To', 'recipient'],
      ['Subject', 'subject'],
      ['Message', 'message'],
      ['BCC', 'BCC address'],
    ]) {
      expect(html).toContain(`>${title}</h2>`);
      expect(html).toContain(`aria-label="Copy ${label}"`);
    }
    expect(html).toContain('jane@example.com');
    expect(html).toContain('1234567@bcc.hubspot.com');
    expect(html).toContain('Add this address as BCC so HubSpot logs your email.');
    // Line breaks in the message are kept.
    expect(html).toContain('whitespace-pre-wrap');
    expect(html).toContain('Hi Jane,\n\nThanks for reaching out.');
    expect(html).toContain(`href="/a/${TOKEN}/send?via=mailto"`);
    expect(html).toContain('never sends email for you');
    // Copy announcements are polite live regions; buttons are full tap targets.
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('min-h-11');
  });

  it('leaves out the BCC part and the mail-app link when there are none', async () => {
    const html = await render({ ...COPY, view: { ...COPY.view, bcc: null }, mailtoPath: null });
    expect(html).not.toContain('>BCC</h2>');
    expect(html).not.toContain('via=mailto');
  });

  it('warns about an unusual recipient', async () => {
    const html = await render({ ...COPY, view: { ...COPY.view, recipient: 'a@x.com;b@y.com', recipientValid: false, mailtoFits: false }, mailtoPath: null });
    expect(html).toContain('Check the address');
    expect(html).toContain('This address looks unusual');
  });

  it('says so when the lead has no address', async () => {
    const html = await render({ ...COPY, view: { ...COPY.view, recipient: null, recipientValid: false, mailtoFits: false }, mailtoPath: null });
    expect(html).toContain('no email address on file');
    expect(html).not.toContain('>To</h2>');
  });

  it('shows the expired and not-available messages', async () => {
    const expired = await render({ type: 'message', message: { title: 'This draft has expired', paragraphs: ['Deleted after 30 days.'] } });
    expect(expired).toContain('This draft has expired');
    expect(expired).toContain('Deleted after 30 days.');
    expect(expired).not.toContain('aria-label="Copy');
  });
});
