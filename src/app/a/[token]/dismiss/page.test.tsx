import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DismissPageState } from '@/server/http/action-links/dismiss';

// /a/[token]/dismiss (PLAN §7.4, D-26) rendered for each state. The page state is stubbed; its logic
// is tested in src/server/http/action-links/dismiss.test.ts.

const state: { value: DismissPageState | null } = { value: null };

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/server/container', () => ({ getDeps: async () => ({}) }));
vi.mock('@/server/actions/action-links/dismiss', () => ({ dismissLeadAction: async () => undefined }));
vi.mock('@/server/http/action-links/dismiss', () => ({
  dismissPageState: async () => {
    if (state.value === null) throw new Error('no state');
    return state.value;
  },
  dismissResultAlert: (result: string | undefined) => (result === 'failed' ? "We couldn't mark it just now. Please try again in a minute." : null),
}));

const TOKEN = 'apt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

async function render(value: DismissPageState, query: Record<string, string> = {}): Promise<string> {
  state.value = value;
  const { default: Page } = await import('./page');
  return renderToStaticMarkup(await Page({ params: Promise.resolve({ token: TOKEN }), searchParams: Promise.resolve(query) }));
}

beforeEach(() => {
  state.value = null;
});

describe('/a/[token]/dismiss', () => {
  it('is never indexed and sends referrers only to this site', async () => {
    const { metadata } = await import('./page');
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.referrer).toBe('same-origin');
  });

  it('asks for confirmation with a button that posts the token', async () => {
    const html = await render({ type: 'confirm' });
    expect(html).toContain('<h1');
    expect(html).toContain('Mark this as not a real lead?');
    expect(html).toContain('Follow-ups for this lead will stop.');
    expect(html).toContain('Nothing changes in HubSpot');
    expect(html).toContain('<form');
    expect(html).toContain(`<input type="hidden" name="token" value="${TOKEN}"/>`);
    expect(html).toContain('type="submit"');
    expect(html).toContain('not a real lead</button>');
    expect(html).toContain('nothing changes unless you tap the button');
    expect(html).not.toContain('role="alert"');
  });

  it('explains a failed attempt', async () => {
    const html = await render({ type: 'confirm' }, { result: 'failed' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('We couldn&#x27;t mark it just now.');
  });

  it('says it is done once dismissed, without a form', async () => {
    const html = await render({ type: 'dismissed' }, { result: 'failed' });
    expect(html).toContain('Done — this lead won&#x27;t get follow-ups');
    expect(html).toContain('the contact is still there');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('role="alert"');
  });

  it('shows the shared messages', async () => {
    const html = await render({ type: 'message', message: { title: "This link isn't available", paragraphs: ['It may have expired.'] } });
    expect(html).toContain('This link isn&#x27;t available');
    expect(html).toContain('It may have expired.');
    expect(html).not.toContain('<form');
  });
});
