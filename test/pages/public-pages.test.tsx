import { NextRequest } from 'next/server';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BASELINE_NOTE, DATA_SOURCE, EMAIL_METADATA_NOTE, HUBSPOT_DISCLOSURE, LEGAL_TODO, SUB_PROCESSORS } from '@/components/marketing';
import type { RefreshedSession } from '@/server/ports/auth';

// The public pages (brief §1, §5.13, PLAN §7.2, D-03, D-20, D-49; laws 1, 2, 3, 5): the landing page
// with the one-liner, three steps, the price, the Install button and the honest note; /privacy with
// what is stored and never stored, the HubSpot disclosure word for word, every sub-processor linked,
// day counts only for stores we control and the Vercel log note; /terms, /refunds and /shipping as
// marked placeholders. No testimonials or user counts anywhere, the D-37 copy rule on the rendered
// text, and the proxy leaves every public page cacheable and indexable.

type Refresh = (request: Request, response: Response) => Promise<RefreshedSession>;
vi.mock('@/server/adapters/fake/auth/proxy-session', () => ({ checkFakeProxySession: vi.fn<Refresh>() }));
vi.mock('@/server/adapters/live/auth', () => ({ refreshLiveProxySession: vi.fn() }));

const PRODUCT = 'Hublytix Autopilot';

type PageModule = { default: () => ReactElement; metadata?: { robots?: unknown; title?: unknown } };

const PAGES: Readonly<Record<string, () => Promise<PageModule>>> = {
  '/': () => import('@/app/page'),
  '/privacy': () => import('@/app/privacy/page'),
  '/terms': () => import('@/app/terms/page'),
  '/refunds': () => import('@/app/refunds/page'),
  '/shipping': () => import('@/app/shipping/page'),
};

const LEGAL = ['/privacy', '/terms', '/refunds', '/shipping'] as const;

async function html(path: string): Promise<string> {
  const load = PAGES[path];
  if (load === undefined) throw new Error(`no page ${path}`);
  const { default: Page } = await load();
  return renderToStaticMarkup(Page());
}

function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

function hrefs(markup: string): string[] {
  return [...markup.matchAll(/href="([^"]*)"/g)].map((m) => (m[1] ?? '').replace(/&amp;/g, '&'));
}

beforeEach(() => {
  vi.stubEnv('APP_MODE', 'fake');
  vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the landing page', () => {
  it('says what the product is, in three steps, with the price', async () => {
    const page = text(await html('/'));
    expect(page).toContain(
      `${PRODUCT} answers and follows up every new lead automatically for HubSpot Starter users — the follow-up HubSpot only offers on Professional — for $49 a month.`,
    );
    expect(page).toContain('$49/month after a 14-day free trial');
    expect(page).toContain('How it works');
    const steps = [...(await html('/')).matchAll(/<li class="flex gap-4">([\s\S]*?)<\/li>/g)].map((m) => text(m[1] ?? ''));
    expect(steps).toHaveLength(3);
    expect(steps[0]).toContain('A lead fills in your HubSpot form.');
    expect(steps[1]).toContain('You get an email with your reply already drafted.');
    expect(steps[2]).toContain('One tap opens your own mail app with your reply filled in.');
  });

  it('qualifies the verbatim one-liner right under it: drafts only, the owner sends (laws 1 and 5, D-83)', async () => {
    const markup = await html('/');
    const header = text(markup.match(/<header[\s\S]*?<\/header>/)?.[0] ?? '');
    expect(header).toContain('answers and follows up every new lead automatically');
    expect(header).toContain('It drafts your replies and follow-ups; you send each one yourself, from your own mail app.');
    const page = text(markup);
    expect(page).toContain("Spam and other submissions that aren't leads get no draft, and neither do leads over the daily limit");
    expect(page).toContain("aren't read at all, so check those in HubSpot.");
  });

  it('the site-wide description never repeats the one-liner: it says Autopilot drafts and the owner sends (D-86)', async () => {
    const { metadata } = await import('@/app/layout');
    const description = String(metadata.description);
    expect(description).not.toMatch(/answers|automatically|every new lead/i);
    expect(description).toContain('Drafts your replies');
    expect(description).toContain('you send them from your own mail app');
  });

  it('installs through /api/hubspot/install (a plain link) and says who can install', async () => {
    const markup = await html('/');
    expect(markup).toMatch(/<a href="\/api\/hubspot\/install"[^>]*>Install with HubSpot<\/a>/);
    expect(text(markup)).toContain('Installing needs a Super Admin or App Marketplace Access');
  });

  it('is honest about what it does and does not do (laws 1, 2, 3)', async () => {
    const page = text(await html('/'));
    expect(page).toContain('It never sends email for you');
    expect(page).toContain('It never connects to your Gmail or Outlook account.');
    expect(page).toContain(HUBSPOT_DISCLOSURE);
    expect(page).toContain("Your sends and your leads' replies count only when HubSpot shows them.");
    expect(page).toContain('Lead messages and drafts are deleted 30 days after the form was submitted.');
  });

  it('links every legal page and sign-in', async () => {
    const links = hrefs(await html('/'));
    for (const path of [...LEGAL, '/login']) expect(links).toContain(path);
  });
});

describe('the legal pages', () => {
  it.each(LEGAL)('%s is a marked placeholder with one h1 and the footer', async (path) => {
    const markup = await html(path);
    expect(text(markup)).toContain(LEGAL_TODO);
    expect(markup.match(/<h1[\s>]/g)).toHaveLength(1);
    const links = hrefs(markup);
    for (const other of LEGAL) expect(links).toContain(other);
  });

  it('/privacy: what is stored and why, with day counts for our own stores', async () => {
    const page = text(await html('/privacy'));
    expect(page).toContain("the message from the form, the lead's first name, last name, company and email address, and the drafts we write");
    expect(page).toContain('This content is deleted 30 days after the form was submitted.');
    expect(page).toContain('the test address you use for it are deleted after 24 hours');
    // inbox_checks.test_address_hmac outlives the address (the intake skip): said, not hidden.
    expect(page).toContain('We keep only a one-way fingerprint of that address, so later test submissions from it are never treated as leads, until your account is deleted.');
    expect(page).toContain('HubSpot ids, timestamps and statuses');
  });

  it('/privacy: the setup baseline sends past submissions to the AI provider, in memory, never stored (D-38, D-49)', async () => {
    const page = text(await html('/privacy'));
    expect(page).toContain(BASELINE_NOTE);
    expect(BASELINE_NOTE).toContain('the last 30 days of submissions on the forms you chose');
    expect(BASELINE_NOTE).toContain("each one's message, first name, company and form name go to our AI provider (Anthropic)");
    expect(BASELINE_NOTE).toContain('never the submissions themselves');
    const anthropic = SUB_PROCESSORS.find((p) => p.name === 'Anthropic');
    expect(anthropic?.role).toContain('at setup, it also sorts your recent form submissions');
    expect(anthropic?.data).toContain('For a follow-up, also your earlier draft.');
    expect(anthropic?.data).toContain('At setup, the same fields of your recent form submissions (see "Your starting point" above), sorted in memory; nothing from them is stored.');
    expect(page).toContain('Your starting point:');
  });

  it('/privacy: what is never stored, and the HubSpot disclosure word for word (D-03)', async () => {
    const page = text(await html('/privacy'));
    expect(page).toContain(EMAIL_METADATA_NOTE);
    expect(page).toContain('never asks for subjects or bodies');
    expect(page).toContain(
      "Autopilot never changes your HubSpot data. HubSpot's 'forms' permission would also allow edits; Autopilot never makes any. Disconnecting uninstalls the app.",
    );
    expect(page).toContain('your card details never reach us');
  });

  it('/privacy: names every sub-processor of brief §5.13 and links its policy over https', async () => {
    const markup = await html('/privacy');
    const page = text(markup);
    const links = hrefs(markup);
    expect(SUB_PROCESSORS.map((p) => p.name)).toEqual(['Anthropic', 'Supabase', 'Vercel', 'Upstash', 'Resend', 'Razorpay', 'Sentry']);
    for (const processor of [...SUB_PROCESSORS, DATA_SOURCE]) {
      expect(page).toContain(processor.name);
      expect(page).toContain(`${processor.name}'s privacy policy`);
      expect(processor.policyUrl).toMatch(/^https:\/\/[a-z0-9.-]+\//);
      expect(links).toContain(processor.policyUrl);
    }
  });

  it('/privacy: gives no day counts for stores we do not control (D-49)', () => {
    for (const processor of [...SUB_PROCESSORS, DATA_SOURCE]) {
      expect(`${processor.role} ${processor.data}`, processor.name).not.toMatch(/\d/);
    }
  });

  it('/privacy: the Vercel request-log note, disconnection and the 30-day purge, a contact placeholder', async () => {
    const page = text(await html('/privacy'));
    expect(page).toContain('Vercel, which hosts Hublytix Autopilot, keeps its own request logs');
    expect(page).toContain('We send these logs nowhere else and use the shortest log retention Vercel offers.');
    expect(page).toContain('Everything we store about your account is deleted 30 days later, unless you reconnect before then.');
    expect(page).toContain('contact details will be added here before launch (TODO: legal review)');
  });

  it('/refunds: cancelling as the billing code does it (D-20), and no refund promise not yet decided', async () => {
    const page = text(await html('/refunds'));
    // Razorpay can't cancel paused/pending/halted subscriptions (D-48): never an unqualified "at any time".
    expect(page).not.toMatch(/at any time/i);
    expect(page).toContain(
      'You can cancel on your billing page in Hublytix Autopilot, or when you disconnect HubSpot. The exception is while a payment has failed or your subscription is paused',
    );
    expect(page).toContain("If a payment has failed or your subscription is paused, it can't be cancelled from Hublytix Autopilot.");
    expect(page).toContain('Cancel before then and nothing is charged: the subscription ends at once');
    expect(page).toContain('The subscription ends at the end of the month you have paid for, and nothing more is charged.');
    expect(page).toContain('Whether payments already made can be refunded, and how, is still to be decided (TODO: legal review).');
  });

  it('/shipping: a digital service, nothing is shipped', async () => {
    expect(text(await html('/shipping'))).toContain('is an online service. Nothing is shipped: there are no physical goods.');
  });

  it('/terms: drafts only, read before sending', async () => {
    const page = text(await html('/terms'));
    expect(page).toContain('never sends email for you');
    expect(page).toContain('Read each draft before you send it.');
  });
});

describe('honest copy on every public page (law 5, D-37)', () => {
  const OWNER_WORDS = new Set(['you', 'your', 'yours']);
  const LEAD_SIDE = [/\b(?:\p{Lu}[\p{L}'-]*|lead) replied\b/gu, /\blead(?:'s|s') (?:reply|replies)\b/giu, /\blead replies\b/giu];

  /** D-37: an unqualified reply/replies/replied is the lead's; the owner's is qualified with you/your. */
  function unqualified(value: string): string[] {
    const lead: [number, number][] = LEAD_SIDE.flatMap((pattern) => [...value.matchAll(pattern)].map((m) => [m.index, m.index + m[0].length] as [number, number]));
    return [...value.matchAll(/\b(?:reply|replies|replied)\b/giu)].flatMap((m) => {
      if (lead.some(([from, to]) => m.index >= from && m.index < to)) return [];
      const clause = value.slice(0, m.index).split(/[.!?;:\n—–(]/u).at(-1) ?? '';
      const before = clause.toLowerCase().match(/[\p{L}']+/gu) ?? [];
      return before.slice(-3).some((word) => OWNER_WORDS.has(word)) ? [] : [value.slice(Math.max(0, m.index - 40), m.index + 20)];
    });
  }

  it.each(Object.keys(PAGES))('%s: no testimonials, ratings or user counts', async (path) => {
    const page = text(await html(path));
    expect(page).not.toMatch(/testimonial|trusted by|loved by|customers say|★|\b\d[\d,.]*\+?\s*(?:users|customers|businesses|companies|teams)\b/i);
  });

  it.each(Object.keys(PAGES))('%s: every reply is the lead’s unless qualified as yours', async (path) => {
    expect(unqualified(text(await html(path)))).toEqual([]);
  });

  it.each(Object.keys(PAGES))('%s: public and cacheable through the proxy, and not marked noindex', async (path) => {
    const { proxy } = await import('@/proxy');
    const res = await proxy(new NextRequest(`http://localhost:3000${path}`));
    expect(res.headers.get('x-robots-tag')).toBeNull();
    expect(res.headers.get('cache-control')).toBeNull();
    const load = PAGES[path];
    expect((await load?.())?.metadata?.robots).toBeUndefined();
  });
});
