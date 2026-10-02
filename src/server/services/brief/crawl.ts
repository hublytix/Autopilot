import 'server-only';
import { WebFetchError } from '@/server/domain/errors';
import type { WebFetchErrorCode } from '@/server/domain/types';
import type { WebFetcher } from '@/server/ports/web-fetcher';
import { extractPage, type ExtractedPage } from './extract';
import {
  CRAWL_BUDGET_MS,
  CRAWL_MAX_BYTES,
  MAX_CONCURRENT_FETCHES,
  MAX_FETCH_ATTEMPTS,
  MAX_SUBPAGES,
  PAGE_MAX_BYTES,
  PAGE_TIMEOUT_MS,
} from './limits';
import { rankLinks } from './rank';

// The crawl (brief §5.3, PLAN §9.7, §10.4): the homepage, then up to 8 same-site pages in rank order
// with at most 4 fetches in flight. Each page has its own 10 s deadline inside the 60 s crawl budget;
// a page that fails (robots.txt, timeout, an error status, not HTML, too large) is skipped and the
// next candidate takes its place, within 16 attempts and 10 MB in all. The WebFetcher enforces the
// SSRF guard and robots.txt on every request. Pages come back homepage first, then in rank order,
// whatever order they finished in.

export interface CrawlOptions {
  /** The caller's own deadline (the job budget); the crawl budget runs inside it. */
  signal?: AbortSignal | undefined;
  /** Overrides for tests; default the PLAN §10.4 limits. */
  budgetMs?: number | undefined;
  pageTimeoutMs?: number | undefined;
}

export interface CrawlStats {
  /** Subpage fetches started (failed ones included). */
  attempted: number;
  /** Subpages kept. */
  fetched: number;
  /** Why subpages were skipped, by WebFetchError code. */
  skipped: Partial<Record<WebFetchErrorCode | 'error', number>>;
  bytes: number;
}

export type CrawlResult =
  | { ok: true; pages: ExtractedPage[]; stats: CrawlStats }
  /** The homepage could not be read; `retryable` for a timeout, a 5xx/429 or a network failure. */
  | { ok: false; code: WebFetchErrorCode; httpStatus: number | undefined; retryable: boolean };

interface Deadline {
  readonly signal: AbortSignal;
  clear(): void;
}

/** An AbortSignal that fires after `ms` (a cleared timer; fake timers drive it in tests). */
function deadline(ms: number, parent?: AbortSignal): Deadline {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
  const signal = parent === undefined ? controller.signal : AbortSignal.any([controller.signal, parent]);
  return { signal, clear: () => clearTimeout(timer) };
}

function isRetryableFailure(error: WebFetchError): boolean {
  if (error.code === 'timeout') return true;
  if (error.code !== 'http_error') return false;
  const status = error.httpStatus;
  return status === undefined || status === 429 || status >= 500;
}

async function fetchPage(
  fetcher: WebFetcher,
  url: string,
  crawl: AbortSignal,
  pageTimeoutMs: number,
  maxBytes: number,
): Promise<{ page: ExtractedPage; bytes: number }> {
  const page = deadline(pageTimeoutMs, crawl);
  try {
    const fetched = await fetcher.fetch(url, { signal: page.signal, maxBytes });
    const extracted = extractPage({ url: fetched.finalUrl, contentType: fetched.contentType, body: fetched.body });
    return { page: extracted, bytes: Buffer.byteLength(fetched.body, 'utf8') };
  } finally {
    page.clear();
  }
}

export async function crawlSite(fetcher: WebFetcher, startUrl: string, options: CrawlOptions = {}): Promise<CrawlResult> {
  const pageTimeoutMs = options.pageTimeoutMs ?? PAGE_TIMEOUT_MS;
  const crawl = deadline(options.budgetMs ?? CRAWL_BUDGET_MS, options.signal);
  try {
    let home: { page: ExtractedPage; bytes: number };
    try {
      home = await fetchPage(fetcher, startUrl, crawl.signal, pageTimeoutMs, PAGE_MAX_BYTES);
    } catch (error) {
      if (!(error instanceof WebFetchError)) throw error;
      return { ok: false, code: error.code, httpStatus: error.httpStatus, retryable: isRetryableFailure(error) };
    }

    const candidates = rankLinks(home.page.links, home.page.url);
    const found: (ExtractedPage | undefined)[] = [];
    const stats: CrawlStats = { attempted: 0, fetched: 0, skipped: {}, bytes: home.bytes };
    let next = 0;
    let inFlight = 0;

    await new Promise<void>((resolve) => {
      const pump = (): void => {
        while (
          inFlight < MAX_CONCURRENT_FETCHES &&
          stats.fetched + inFlight < MAX_SUBPAGES &&
          next < candidates.length &&
          stats.attempted < MAX_FETCH_ATTEMPTS &&
          stats.bytes < CRAWL_MAX_BYTES &&
          !crawl.signal.aborted
        ) {
          const index = next;
          const candidate = candidates[index];
          next += 1;
          if (candidate === undefined) continue;
          stats.attempted += 1;
          inFlight += 1;
          const maxBytes = Math.min(PAGE_MAX_BYTES, CRAWL_MAX_BYTES - stats.bytes);
          fetchPage(fetcher, candidate.url, crawl.signal, pageTimeoutMs, maxBytes).then(
            ({ page, bytes }) => {
              inFlight -= 1;
              if (stats.bytes + bytes > CRAWL_MAX_BYTES || stats.fetched >= MAX_SUBPAGES) {
                stats.skipped.too_large = (stats.skipped.too_large ?? 0) + 1;
              } else {
                stats.bytes += bytes;
                stats.fetched += 1;
                found[index] = page;
              }
              pump();
            },
            (error: unknown) => {
              inFlight -= 1;
              const code = error instanceof WebFetchError ? error.code : 'error';
              stats.skipped[code] = (stats.skipped[code] ?? 0) + 1;
              pump();
            },
          );
        }
        if (inFlight === 0) resolve();
      };
      pump();
    });

    const pages = [home.page, ...found.filter((page): page is ExtractedPage => page !== undefined)];
    return { ok: true, pages, stats };
  } finally {
    crawl.clear();
  }
}
