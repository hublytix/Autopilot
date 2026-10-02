import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardPlaceholderView } from '@/server/views/dashboard';

// /dashboard, the M3 placeholder (M6 builds the dashboard): Finish lands here, so setup never ends
// on a not-found page. The session guard and the view are stubbed.

const state: { view: DashboardPlaceholderView | null } = { view: null };

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/server/container', () => ({ getDeps: async () => ({}) }));
vi.mock('@/server/http/auth/guards', () => ({ requireOwnerPage: async () => ({ accountId: 'a', userId: 'u' }) }));
vi.mock('@/server/views/dashboard', () => ({
  dashboardPlaceholderView: async () => {
    if (state.view === null) throw new Error('no view');
    return state.view;
  },
}));

const GATE: DashboardPlaceholderView['gate'] = {
  ready: true,
  missing: [],
  completedAt: new Date('2000-01-03T09:04:30Z'),
  processingState: 'active',
  noConfirmedNotifyAddress: false,
};

async function render(view: DashboardPlaceholderView, query: Record<string, string> = {}): Promise<string> {
  state.view = view;
  const { default: Page } = await import('@/app/dashboard/page');
  return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(query) }));
}

beforeEach(() => {
  state.view = null;
});

describe('/dashboard placeholder', () => {
  it('says setup is complete and promises nothing more', async () => {
    const html = await render({ gate: GATE });
    expect(html).toContain('Setup is complete');
    expect(html).toContain('New leads will appear here.');
    expect(html).not.toContain('Reconnect');
  });

  it('sends an owner who has not finished back to the setup steps', async () => {
    const html = await render({ gate: { ...GATE, ready: false, missing: ['forms'], completedAt: null, processingState: 'onboarding' } });
    expect(html).toContain('Setup isn&#x27;t finished yet');
    expect(html).toContain('href="/onboarding/baseline"');
  });

  it('offers Reconnect HubSpot when a reconnect sign-in link brought the owner here', async () => {
    const html = await render({ gate: { ...GATE, processingState: 'revoked' } }, { reconnect: '1' });
    expect(html).toContain('href="/api/hubspot/install"');
    expect(html).toContain('Reconnect HubSpot');
  });
});
