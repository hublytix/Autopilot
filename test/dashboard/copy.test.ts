import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bannerCopy, NOT_PROCESSED_TEXT, SIGNALS_TEXT } from '@/app/dashboard/copy';
import type { DashboardBanner } from '@/server/views/dashboard';

// The dashboard's copy (PLAN §7.5, law 5): every link a banner offers leads to a page or route that
// exists in this build, and the sentences that once overstated say what is true (D-77).

const BANNERS: readonly DashboardBanner[] = [
  { type: 'reconnect', connected: false, daysLeft: 12, purgeOn: '5 Nov 2026' },
  { type: 'reconnect', connected: true, daysLeft: null, purgeOn: null },
  { type: 'setup_incomplete' },
  { type: 'billing_inactive' },
  { type: 'payment_grace', until: '9 Oct 2026' },
  { type: 'trial_ending', daysLeft: 2 },
  { type: 'paused', since: 'Tue 6 Oct, 10:00', skippedLeads: 1 },
  { type: 'resumed', pausedFrom: 'Tue 6 Oct, 10:00', skippedLeads: 1 },
  { type: 'daily_cap', limit: 50, reachedToday: true, deferredToday: 2, deferredEarlier: 1 },
  { type: 'ai_limit' },
  { type: 'needs_touch', count: 2 },
  { type: 'logging', mode: 'none' },
  { type: 'logging', mode: 'sends_only' },
  { type: 'logging', mode: 'unknown' },
  { type: 'email_scope_missing' },
  { type: 'inbox_check_pending' },
];

/** The file that serves `href` in this build: a route handler under /api, else a page. */
function servedBy(href: string): string {
  const path = href.split('?')[0] ?? href;
  const segments = path.split('/').filter((segment) => segment !== '');
  return join(process.cwd(), 'src', 'app', ...segments, path.startsWith('/api/') ? 'route.ts' : 'page.tsx');
}

describe('dashboard banners', () => {
  it.each(BANNERS.map((banner) => [banner.type, banner] as const))('%s links only to a page that exists', (_type, banner) => {
    const link = bannerCopy(banner).link;
    if (link !== undefined) expect(existsSync(servedBy(link.href)), link.href).toBe(true);
  });

  it('offers no billing link until the billing page exists (M7), and promises no action it cannot take', () => {
    for (const banner of BANNERS.filter((b) => b.type === 'billing_inactive' || b.type === 'payment_grace' || b.type === 'trial_ending')) {
      const copy = bannerCopy(banner);
      expect(copy.link === undefined || existsSync(servedBy(copy.link.href))).toBe(true);
      expect(copy.lines.join(' ')).not.toMatch(/Go to billing/);
    }
  });

  it('words the logging limits as limits: a send or reply may simply not be logged', () => {
    const none = bannerCopy({ type: 'logging', mode: 'none' }).lines.join(' ');
    expect(none).toContain("some of your sends and your leads' replies may not show up here");
    expect(none).not.toContain("can't confirm your sends");
    const unknown = bannerCopy({ type: 'logging', mode: 'unknown' }).lines.join(' ');
    expect(unknown).toContain("a send of yours or a lead's reply that's missing here may simply not be logged in HubSpot");
    expect(unknown).not.toContain("can't confirm your sends");
  });

  it("says a deferred lead missed that day's limit (it may be an earlier day's)", () => {
    expect(NOT_PROCESSED_TEXT.daily_cap).toBe("Not drafted: it arrived after that day's limit of drafted leads was reached.");
  });

  it('gives a disconnected account its own reason on the lead page, not the missing-scope one', () => {
    expect(SIGNALS_TEXT.disconnected).toBe("HubSpot is disconnected, so this lead can't be checked there until you reconnect.");
    expect(SIGNALS_TEXT.disconnected).not.toBe(SIGNALS_TEXT.noScope);
  });
});
