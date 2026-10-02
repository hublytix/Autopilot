import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditPageState, EditReadyView } from '@/server/http/action-links/edit';

// /a/[token]/edit (PLAN §7.4, D-13, D-47) rendered for each state, and the result page. The page
// state is stubbed; its logic is tested in src/server/http/action-links/edit.test.ts.

const state: { value: EditPageState | null } = { value: null };

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/server/container', () => ({ getDeps: async () => ({}) }));
vi.mock('@/server/actions/action-links/edit', () => ({ submitEditAction: async () => ({ type: 'idle' }) }));
vi.mock('@/server/http/action-links/edit', () => ({
  editPageState: async () => {
    if (state.value === null) throw new Error('no state');
    return state.value;
  },
}));
// The gesture beacon renders nothing; show what it was given.
vi.mock('../copy/PageBeacon', () => ({
  PageBeacon: ({ url, nonce }: { url: string; nonce: string }) => <span data-test-beacon={url} data-test-nonce={nonce} />,
}));

const TOKEN = 'apt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const EDIT: Extract<EditPageState, { type: 'edit' }> = {
  type: 'edit',
  view: {
    recipient: 'jane@example.com',
    recipientValid: true,
    subject: 'Re: Your enquiry',
    body: 'Hi Jane,\n\nThanks for reaching out.\n\nBest,\nSam',
    bcc: '1234567@bcc.hubspot.com',
    leadMessage: 'Please see hxxps://evil[.]example/pay\nThanks <b>now</b>',
    beaconNonce: 'BBBBBBBBBBBBBBBBBBBBBB',
  },
  beaconPath: `/a/${TOKEN}/beacon`,
  neverSends: 'Hublytix Autopilot never sends email for you: your reply goes out only when you send it from your own mail app.',
  limits: { subjectMaxChars: 300, bodyMaxChars: 10_000 },
};

const READY: EditReadyView = {
  recipient: 'jane@example.com',
  recipientValid: true,
  subject: 'Re: Your kitchen',
  body: 'Hi Jane,\n\nTuesday works.\n\nSam',
  bcc: '1234567@bcc.hubspot.com',
  hints: [{ code: 'placeholder', text: 'It still has a placeholder, such as [Name] or {first_name}, to fill in.' }],
  sendUrl: 'https://mail.google.com/mail/u/0/?to=jane%40example.com&su=Re%3A%20Your%20kitchen&tf=cm',
  sendTarget: 'Gmail',
  copyReason: null,
  mailtoUrl: 'mailto:jane%40example.com?subject=Re%3A%20Your%20kitchen',
};

async function render(value: EditPageState): Promise<string> {
  state.value = value;
  const { default: Page } = await import('./page');
  return renderToStaticMarkup(await Page({ params: Promise.resolve({ token: TOKEN }) }));
}

async function renderReady(reply: EditReadyView): Promise<string> {
  const { ReplyReady } = await import('./EditReply');
  return renderToStaticMarkup(
    <ReplyReady reply={reply}>
      <form id="again" />
    </ReplyReady>,
  );
}

beforeEach(() => {
  state.value = null;
});

describe('/a/[token]/edit', () => {
  it('is never indexed and sends referrers only to this site', async () => {
    const { metadata } = await import('./page');
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.referrer).toBe('same-origin');
  });

  it("shows the editable draft, the lead's message as unverified text, the BCC address and the gesture beacon", async () => {
    const html = await render(EDIT);
    expect(html).toContain('<h1');
    expect(html).toContain('Edit your reply');
    expect(html).toContain('Message from the lead (unverified)');
    // Escaped plain text, line breaks kept: no markup from the lead reaches the page.
    expect(html).toContain('Please see hxxps://evil[.]example/pay\nThanks &lt;b&gt;now&lt;/b&gt;');
    expect(html).toContain('whitespace-pre-wrap');
    expect(html).toContain('name="subject"');
    expect(html).toContain('value="Re: Your enquiry"');
    expect(html).toMatch(/<textarea[^>]*name="body"[^>]*>\s*Hi Jane,\n\nThanks for reaching out\.\n\nBest,\nSam<\/textarea>/);
    expect(html).toContain('maxLength="300"');
    expect(html).toContain('maxLength="10000"');
    expect(html).toContain(`<input type="hidden" name="token" value="${TOKEN}"/>`);
    expect(html).toContain('jane@example.com');
    expect(html).toContain('1234567@bcc.hubspot.com');
    expect(html).toContain('add it by hand');
    expect(html).toContain('Done editing');
    expect(html).toContain('never sends email for you');
    expect(html).toContain(`data-test-beacon="/a/${TOKEN}/beacon"`);
    expect(html).toContain('data-test-nonce="BBBBBBBBBBBBBBBBBBBBBB"');
    // Labels tie to their controls; tap targets are 44 px.
    expect(html).toContain('for="edit-subject"');
    expect(html).toContain('for="edit-body"');
    expect(html).toContain('min-h-11');
    // No third-party resources.
    expect(html).not.toMatch(/<(?:script|img|link|iframe)[^>]+(?:src|href)="https?:/);
  });

  it('says when the lead wrote nothing, and warns about an unusual address', async () => {
    const html = await render({ ...EDIT, view: { ...EDIT.view, leadMessage: null, recipient: 'a@x.com;b@y.com', recipientValid: false, bcc: null } });
    expect(html).toContain('The lead didn&#x27;t write a message.');
    expect(html).toContain('This address looks unusual');
    expect(html).not.toContain('BCC:');
  });

  it('shows the expired and not-available messages without a form', async () => {
    const html = await render({ type: 'message', message: { title: 'This draft has expired', paragraphs: ['Deleted after 30 days.'] } });
    expect(html).toContain('This draft has expired');
    expect(html).toContain('Deleted after 30 days.');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('data-test-beacon');
  });
});

describe('the result page', () => {
  it('offers "Send from my email", "Open in default mail app" and "Copy your reply", with the hints', async () => {
    const html = await renderReady(READY);
    expect(html).toContain('Your edited reply is ready');
    expect(html).toContain('open it in Gmail');
    expect(html).toContain(`href="${READY.sendUrl?.replace(/&/g, '&amp;')}"`);
    expect(html).toMatch(/>Send from my email</);
    expect(html).toContain(`href="${READY.mailtoUrl ?? ''}"`);
    expect(html).toMatch(/>Open in default mail app</);
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain('Before you send, check these');
    expect(html).toContain('You can still send it as it is.');
    expect(html).toContain('It still has a placeholder');
    expect(html).toContain('Copy your reply');
    for (const label of ['recipient', 'subject', 'message', 'BCC address']) expect(html).toContain(`aria-label="Copy ${label}"`);
    expect(html).toContain('Hi Jane,\n\nTuesday works.\n\nSam');
    // The copy view is folded away while a link exists; more changes are one tap away.
    expect(html).not.toContain('<details open=""');
    expect(html).toContain('Make more changes');
    expect(html).toContain('<form id="again">');
  });

  it('shows the copy view open, without a send link, when the reply is too long', async () => {
    const html = await renderReady({ ...READY, hints: [], sendUrl: null, sendTarget: null, copyReason: 'too_long', mailtoUrl: null });
    expect(html).toContain('too long to fill in a new email automatically');
    expect(html).not.toContain('Send from my email');
    expect(html).not.toContain('Open in default mail app');
    expect(html).not.toContain('Before you send');
    expect(html).toContain('<details open=""');
  });

  it('asks to check an unusual address', async () => {
    const html = await renderReady({ ...READY, recipient: 'a@x.com;b@y.com', recipientValid: false, sendUrl: null, sendTarget: null, copyReason: 'invalid_recipient', mailtoUrl: null });
    expect(html).toContain('This address looks unusual');
    expect(html).not.toContain('Send from my email');
  });
});
