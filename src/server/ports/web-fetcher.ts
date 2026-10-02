import 'server-only';

// Live: undici with the SSRF-guarded lookup (checks at socket open, ports 80/443, at most 3 redirects
// through the same agent), robots.txt honoured with our own user agent, no cookies or auth headers,
// only text/html and text/plain read (PLAN §10.4). Fake: the fixture site in test/fixtures/site.
//
// Errors: WebFetchError (from '@/server/domain/errors') with one of WEB_FETCH_ERROR_CODES:
// `blocked_by_ssrf`, `robots_disallowed`, `too_large` (over `maxBytes` after decompression),
// `timeout` (also when `signal` aborts), `bad_content_type`, `http_error` (non-2xx, `httpStatus` set).

export interface WebFetchOptions {
  /** Per-page deadline (10 s) combined with the crawl's total budget. */
  signal: AbortSignal;
  /** Body limit after decompression (2 MB per page). */
  maxBytes: number;
}

export interface FetchedPage {
  /** The URL after redirects. */
  finalUrl: string;
  /** Always 2xx; other statuses throw `http_error`. */
  status: number;
  /** The response `content-type` (text/html or text/plain). */
  contentType: string;
  /** The decoded body. */
  body: string;
}

export interface WebFetcher {
  /** Fetches one public page for the brief builder, enforcing the SSRF guard, robots.txt and limits. */
  fetch(url: string, options: WebFetchOptions): Promise<FetchedPage>;
}
