import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeWebFetcher, FIXTURE_SITE_URL } from '@/server/adapters/fake/web-fetcher';
import { crawlSite, type CrawlResult } from '@/server/services/brief/crawl';
import { extractPage } from '@/server/services/brief/extract';
import { CRAWL_MAX_BYTES, MAX_SUBPAGES } from '@/server/services/brief/limits';
import { PAGE_KEYWORDS, rankLinks } from '@/server/services/brief/rank';

// The crawl (brief §5.3, PLAN §9.7, §10.4) on test/fixtures/site through the FakeWebFetcher: page
// selection and ranking, robots.txt, the per-page timeout, the 60 s budget, at most 4 fetches at once.

const SITE = 'https://brightside-plumbing.example';

function ok(result: CrawlResult): Extract<CrawlResult, { ok: true }> {
  if (!result.ok) throw new Error(`crawl failed: ${result.code}`);
  return result;
}

/** A fetcher whose fixture files are in memory: with setTimeout faked, no real read can lag behind. */
function preloaded(options: ConstructorParameters<typeof FakeWebFetcher>[0] = {}): Promise<FakeWebFetcher> {
  return new FakeWebFetcher(options).preload();
}

/**
 * Lets the crawl's promise chains run (setImmediate is not faked) until the fetcher logged `count`
 * fetches. Fails loudly instead of letting a later fake-time advance miss a page timer.
 */
async function untilLogHas(fetcher: FakeWebFetcher, count: number): Promise<void> {
  for (let i = 0; i < 10_000 && fetcher.log.length < count; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  if (fetcher.log.length < count) throw new Error(`untilLogHas: ${fetcher.log.length} of ${count} fetches logged`);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('rankLinks', () => {
  it('ranks keyword pages (path, then link text) first, then the rest in homepage order; drops the homepage, files and other sites', () => {
    const links = [
      { url: `${SITE}/`, text: 'Home' },
      { url: `${SITE}/blog/1`, text: 'Five signs' },
      { url: `${SITE}/team`, text: 'About the team' },
      { url: `${SITE}/our-services/`, text: 'What we do' },
      { url: `${SITE}/brochure.pdf`, text: 'Pricing brochure' },
      { url: 'https://other.example/pricing', text: 'Pricing' },
      { url: 'https://www.brightside-plumbing.example/faq', text: 'FAQ' },
      { url: `${SITE}/our-services`, text: 'Services' },
      { url: `${SITE}/careers`, text: 'Careers' },
    ];
    expect(rankLinks(links, `${SITE}/`)).toEqual([
      { url: `${SITE}/our-services/`, score: 3 },
      { url: 'https://www.brightside-plumbing.example/faq', score: 3 },
      { url: `${SITE}/team`, score: 1 },
      { url: `${SITE}/blog/1`, score: 0 },
      { url: `${SITE}/careers`, score: 0 },
    ]);
  });

  it('uses the PLAN §9.7 keywords', () => {
    expect([...PAGE_KEYWORDS]).toEqual(['services', 'pricing', 'about', 'contact', 'faq']);
  });

  it('orders the fixture homepage: the five keyword pages, then careers and the blog, private and slow last', async () => {
    const home = await new FakeWebFetcher().fetch(FIXTURE_SITE_URL, { signal: new AbortController().signal, maxBytes: 2_000_000 });
    const page = extractPage({ url: home.finalUrl, contentType: home.contentType, body: home.body });
    expect(rankLinks(page.links, page.url).map((link) => link.url.replace(SITE, ''))).toEqual([
      '/services',
      '/pricing',
      '/about',
      '/contact',
      '/faq',
      '/careers',
      '/blog/1',
      '/blog/2',
      '/blog/3',
      '/blog/4',
      '/blog/5',
      '/blog/6',
      '/private',
      '/slow',
    ]);
  });
});

describe('crawlSite on the fixture site', () => {
  it('fetches the homepage plus the 8 best-ranked pages, returned in rank order', async () => {
    const fetcher = new FakeWebFetcher();
    const result = ok(await crawlSite(fetcher, FIXTURE_SITE_URL));
    expect(result.pages.map((page) => page.url.replace(SITE, ''))).toEqual(['/', '/services', '/pricing', '/about', '/contact', '/faq', '/careers', '/blog/1', '/blog/2']);
    expect(result.stats).toMatchObject({ attempted: MAX_SUBPAGES, fetched: MAX_SUBPAGES, skipped: {} });
    const fetched = fetcher.log.map((entry) => entry.url.replace(SITE, ''));
    expect(fetched).not.toContain('/private');
    expect(fetched).not.toContain('/slow');
    expect(fetched.some((url) => url.includes('social.example'))).toBe(false);
  });

  it('runs at most 4 fetches at once', async () => {
    const fetcher = new FakeWebFetcher();
    ok(await crawlSite(fetcher, FIXTURE_SITE_URL));
    expect(fetcher.peakConcurrency).toBe(4);
  });

  it('follows a redirected homepage and ranks links against the final host', async () => {
    const result = ok(await crawlSite(new FakeWebFetcher(), 'https://www.brightside-plumbing.example/'));
    expect(result.pages[0]?.url).toBe(FIXTURE_SITE_URL);
    expect(result.pages).toHaveLength(1 + MAX_SUBPAGES);
  });

  it('honours robots.txt: a disallowed page is never read and the next candidate takes its slot', async () => {
    const fetcher = new FakeWebFetcher({
      routes: {
        '/': {
          contentType: 'text/html',
          body: '<main><h1>Brightside</h1><a href="/private">About the staff area</a><a href="/services">Services</a><a href="/careers">Careers</a></main>',
        },
      },
    });
    const result = ok(await crawlSite(fetcher, FIXTURE_SITE_URL));
    expect(result.pages.map((page) => page.url.replace(SITE, ''))).toEqual(['/', '/services', '/careers']);
    expect(result.stats.skipped).toEqual({ robots_disallowed: 1 });
    expect(fetcher.log).toContainEqual({ url: `${SITE}/private`, outcome: 'robots_disallowed' });
    expect(result.pages.map((page) => page.text).join('\n')).not.toContain('Internal rota');
  });

  it('gives each page its own 10 s deadline: a hanging page times out and the crawl moves on', async () => {
    const fetcher = await preloaded({ slowPaths: ['/pricing'] });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let settled = false;
    const pending = crawlSite(fetcher, FIXTURE_SITE_URL).then((result) => {
      settled = true;
      return result;
    });
    // Homepage + 7 pages answer; /pricing hangs.
    await untilLogHas(fetcher, 8);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = ok(await pending);
    expect(result.pages.map((page) => page.url.replace(SITE, ''))).toEqual(['/', '/services', '/about', '/contact', '/faq', '/careers', '/blog/1', '/blog/2', '/blog/3']);
    expect(result.stats).toMatchObject({ attempted: 9, fetched: 8, skipped: { timeout: 1 } });
    expect(fetcher.log).toContainEqual({ url: `${SITE}/pricing`, outcome: 'timeout' });
  });

  it('times out the fixture /slow page at 10 s without holding up the other pages', async () => {
    const fetcher = await preloaded({
      routes: { '/': { contentType: 'text/html', body: '<main><a href="/slow">Contact</a><a href="/services">Services</a><a href="/about">About</a></main>' } },
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let settled = false;
    const pending = crawlSite(fetcher, FIXTURE_SITE_URL).then((result) => {
      settled = true;
      return result;
    });
    await untilLogHas(fetcher, 3);
    expect(fetcher.log.map((entry) => entry.url.replace(SITE, ''))).toEqual(['/', '/services', '/about']);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = ok(await pending);
    expect(result.pages.map((page) => page.url.replace(SITE, ''))).toEqual(['/', '/services', '/about']);
    expect(fetcher.log).toContainEqual({ url: `${SITE}/slow`, outcome: 'timeout' });
  });

  it('stops at the 60 s crawl budget, keeping what was fetched', async () => {
    const slowPaths = ['/services', '/pricing', '/about', '/contact', '/faq', '/careers', '/blog/1', '/blog/2', '/blog/3', '/blog/4', '/blog/5', '/blog/6'];
    const fetcher = await preloaded({ slowPaths });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let settled = false;
    const pending = crawlSite(fetcher, FIXTURE_SITE_URL, { pageTimeoutMs: 45_000 }).then((result) => {
      settled = true;
      return result;
    });
    await untilLogHas(fetcher, 1);
    await vi.advanceTimersByTimeAsync(45_000);
    // The first four timed out; four more started at 45 s and are cut off by the budget at 60 s.
    await untilLogHas(fetcher, 5);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = ok(await pending);
    expect(result.pages.map((page) => page.url)).toEqual([FIXTURE_SITE_URL]);
    expect(result.stats).toMatchObject({ attempted: 8, fetched: 0, skipped: { timeout: 8 } });
  });

  it('stops before 10 MB in all', async () => {
    // Plain text keeps the test fast (no HTML parse); the byte accounting is the same.
    const big = 'water heater repairs and plumbing services\n'.repeat(47_500);
    const routes = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`/big-${i}`, { contentType: 'text/plain', body: big }]));
    const links = Array.from({ length: 8 }, (_, i) => `<a href="/big-${i}">Services ${i}</a>`).join('');
    const fetcher = new FakeWebFetcher({ routes: { ...routes, '/': { contentType: 'text/html', body: `<main>${links}</main>` } } });
    const result = ok(await crawlSite(fetcher, FIXTURE_SITE_URL));
    expect(Buffer.byteLength(big)).toBeGreaterThan(2_000_000);
    expect(result.stats.bytes).toBeLessThanOrEqual(CRAWL_MAX_BYTES);
    expect(result.stats.fetched).toBeLessThan(8);
    expect(result.stats.fetched).toBeGreaterThanOrEqual(4);
  });
});

describe('crawlSite when the homepage cannot be read', () => {
  it.each([
    ['an unknown host (network failure)', 'https://unknown-host.example/', 'http_error', true],
    ['a host resolving to a blocked address', 'https://metadata.example/', 'blocked_by_ssrf', false],
    ['an IP literal', 'http://169.254.169.254/', 'blocked_by_ssrf', false],
    ['a 500', `${SITE}/broken`, 'http_error', true],
    ['a 410', `${SITE}/gone`, 'http_error', false],
    ['a PDF', `${SITE}/brochure.pdf`, 'bad_content_type', false],
    ['robots.txt', `${SITE}/private`, 'robots_disallowed', false],
    ['a redirect to the metadata address', `${SITE}/metadata-redirect`, 'blocked_by_ssrf', false],
  ])('reports %s', async (_name, url, code, retryable) => {
    const result = await crawlSite(new FakeWebFetcher(), url);
    expect(result).toMatchObject({ ok: false, code, retryable });
  });

  it('reports a hanging homepage as a retryable timeout after 10 s', async () => {
    const fetcher = await preloaded({ slowPaths: ['/'] });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = crawlSite(fetcher, FIXTURE_SITE_URL);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ ok: false, code: 'timeout', httpStatus: undefined, retryable: true });
  });
});
