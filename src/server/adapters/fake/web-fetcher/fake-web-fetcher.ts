import 'server-only';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { WebFetchError } from '@/server/domain/errors';
import type { WebFetchErrorCode } from '@/server/domain/types';
import type { FetchedPage, WebFetcher, WebFetchOptions } from '@/server/ports/web-fetcher';
import { isAllowedByRobots, parseRobots, type RobotsRules } from './robots';

/** The fictional fixture business (test/fixtures/site). */
export const FIXTURE_SITE_HOST = 'brightside-plumbing.example';
export const FIXTURE_SITE_URL = `https://${FIXTURE_SITE_HOST}/`;
/** The booking link the fixture shows on /contact. */
export const FIXTURE_BOOKING_LINK = 'https://cal.example.com/brightside/visit';
/** The user-agent token robots.txt groups are matched against. */
export const DEFAULT_USER_AGENT_TOKEN = 'HublytixAutopilot';
/** Redirects followed per fetch (PLAN §10.4). */
export const MAX_REDIRECTS = 3;
/**
 * Hostnames the fake treats as resolving to a private, loopback or metadata address (the live guard
 * decides at socket open; here the "DNS answer" is this list).
 */
export const FAKE_SSRF_BLOCKED_HOSTS = ['internal.brightside-plumbing.example', 'metadata.example', 'rebind.example'] as const;

const HTML = 'text/html; charset=utf-8';
const TEXT = 'text/plain; charset=utf-8';
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

/** A virtual page served in addition to the fixture files. */
export interface FakeRoute {
  /** Default 200, or 301 when `redirectTo` is set. */
  status?: number | undefined;
  contentType?: string | undefined;
  body?: string | undefined;
  /** Absolute or site-relative target; the response is a redirect. */
  redirectTo?: string | undefined;
}

/**
 * Virtual routes for paths the fixture files cannot express: redirects, a non-HTML document, a server
 * error, a redirect chain longer than MAX_REDIRECTS and a redirect to a metadata address.
 */
export const DEFAULT_FAKE_ROUTES: Readonly<Record<string, FakeRoute>> = {
  '/home': { redirectTo: '/' },
  '/old-services': { redirectTo: '/services' },
  '/brochure.pdf': { contentType: 'application/pdf', body: '%PDF-1.4 fictional brochure' },
  '/broken': { status: 500, contentType: HTML, body: '<h1>Internal Server Error</h1>' },
  '/gone': { status: 410, contentType: HTML, body: '<h1>Gone</h1>' },
  '/loop-1': { redirectTo: '/loop-2' },
  '/loop-2': { redirectTo: '/loop-3' },
  '/loop-3': { redirectTo: '/loop-4' },
  '/loop-4': { redirectTo: '/' },
  '/metadata-redirect': { redirectTo: 'http://169.254.169.254/latest/meta-data/' },
};

export interface FakeWebFetcherOptions {
  /** Directory holding the fixture site. Default: `<cwd>/test/fixtures/site`. */
  siteDir?: string | undefined;
  /** The fixture's canonical host. Default FIXTURE_SITE_HOST. */
  host?: string | undefined;
  /** Hosts that 301 to the canonical host (same path). Default: `www.<host>`. */
  aliasHosts?: readonly string[] | undefined;
  userAgentToken?: string | undefined;
  /** Paths that never answer: the fetch ends only when its signal aborts (`timeout`). Default `['/slow']`. */
  slowPaths?: readonly string[] | undefined;
  /** Hosts treated as resolving to blocked addresses. Default FAKE_SSRF_BLOCKED_HOSTS. */
  ssrfBlockedHosts?: readonly string[] | undefined;
  /** Extra or replacement virtual routes, merged over DEFAULT_FAKE_ROUTES. */
  routes?: Readonly<Record<string, FakeRoute>> | undefined;
}

/** One `fetch` call as the fake saw it (for tests: robots, ordering, concurrency). */
export interface FakeFetchRecord {
  url: string;
  outcome: 'ok' | WebFetchErrorCode;
  finalUrl?: string | undefined;
}

interface Resolved {
  status: number;
  contentType: string;
  body: string;
}

function isIpLiteral(hostname: string): boolean {
  return hostname.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

function normalisePath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.split('/').includes('..')) return null;
  const trimmed = decoded.replace(/\/+$/, '');
  return trimmed.length === 0 ? '/' : trimmed;
}

function abortedError(): WebFetchError {
  return new WebFetchError('timeout');
}

/** Resolves when the signal aborts; never otherwise (a page that does not answer). */
function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * The fake `WebFetcher` over the fixture site (PLAN §4): enforces the SSRF rules that can be checked
 * without DNS (scheme, port, credentials, IP-literal and single-label hosts, plus a list of hosts
 * that "resolve" to blocked addresses), robots.txt, at most 3 redirects, content type, `maxBytes`
 * and the abort signal. It reads files only; it never touches the network.
 */
export class FakeWebFetcher implements WebFetcher {
  readonly #siteDir: string;
  readonly #host: string;
  readonly #aliasHosts: ReadonlySet<string>;
  readonly #userAgentToken: string;
  readonly #slowPaths: ReadonlySet<string>;
  readonly #blockedHosts: ReadonlySet<string>;
  readonly #routes: Readonly<Record<string, FakeRoute>>;
  #robots: RobotsRules | null = null;
  /** After preload(): every fixture file by its path relative to the site directory. */
  #preloaded: Map<string, string> | null = null;
  #inFlight = 0;
  #peakInFlight = 0;
  readonly #log: FakeFetchRecord[] = [];

  constructor(options: FakeWebFetcherOptions = {}) {
    // Read from the working directory at run time (fake mode only); turbopackIgnore keeps `next build`
    // from tracing the whole project because of this path.
    this.#siteDir = path.resolve(/*turbopackIgnore: true*/ options.siteDir ?? path.join(/*turbopackIgnore: true*/ process.cwd(), 'test', 'fixtures', 'site'));
    this.#host = (options.host ?? FIXTURE_SITE_HOST).toLowerCase();
    this.#aliasHosts = new Set((options.aliasHosts ?? [`www.${this.#host}`]).map((h) => h.toLowerCase()));
    this.#userAgentToken = options.userAgentToken ?? DEFAULT_USER_AGENT_TOKEN;
    this.#slowPaths = new Set(options.slowPaths ?? ['/slow']);
    this.#blockedHosts = new Set((options.ssrfBlockedHosts ?? FAKE_SSRF_BLOCKED_HOSTS).map((h) => h.toLowerCase()));
    this.#routes = { ...DEFAULT_FAKE_ROUTES, ...options.routes };
  }

  /**
   * Reads every fixture file into memory once, so later fetches do no file I/O. Tests that fake
   * timers use it: their pages then resolve on microtasks alone, never on a real read that could
   * finish after a fake-time advance.
   */
  async preload(): Promise<this> {
    const files = new Map<string, string>();
    const entries = await readdir(/*turbopackIgnore: true*/ this.#siteDir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const file = path.join(/*turbopackIgnore: true*/ entry.parentPath, entry.name);
      files.set(path.relative(this.#siteDir, file).split(path.sep).join('/'), await readFile(/*turbopackIgnore: true*/ file, 'utf8'));
    }
    this.#preloaded = files;
    return this;
  }

  /** Every fetch so far, oldest first. */
  get log(): readonly FakeFetchRecord[] {
    return [...this.#log];
  }

  /** The most fetches that were in flight at once. */
  get peakConcurrency(): number {
    return this.#peakInFlight;
  }

  async fetch(url: string, options: WebFetchOptions): Promise<FetchedPage> {
    if (!Number.isFinite(options.maxBytes) || options.maxBytes < 0) throw new RangeError('fake_web_fetcher_invalid_max_bytes');
    this.#inFlight += 1;
    this.#peakInFlight = Math.max(this.#peakInFlight, this.#inFlight);
    try {
      const page = await this.#fetchFollowingRedirects(url, options);
      this.#log.push({ url, outcome: 'ok', finalUrl: page.finalUrl });
      return page;
    } catch (error) {
      if (error instanceof WebFetchError) this.#log.push({ url, outcome: error.code });
      throw error;
    } finally {
      this.#inFlight -= 1;
    }
  }

  async #fetchFollowingRedirects(url: string, { signal, maxBytes }: WebFetchOptions): Promise<FetchedPage> {
    let current = this.#parse(url);
    for (let redirects = 0; ; redirects += 1) {
      if (signal.aborted) throw abortedError();
      this.#assertNotBlocked(current);
      const hostname = current.hostname.toLowerCase();
      if (this.#aliasHosts.has(hostname)) {
        if (redirects >= MAX_REDIRECTS) throw new WebFetchError('http_error', { httpStatus: 301 });
        const next = new URL(current.href);
        next.hostname = this.#host;
        current = next;
        continue;
      }
      // Any other host fails as an unresolvable name would: no status.
      if (hostname !== this.#host) throw new WebFetchError('http_error');

      const pagePath = normalisePath(current.pathname);
      if (pagePath === null) throw new WebFetchError('http_error', { httpStatus: 404 });
      if (pagePath !== '/robots.txt' && !(await this.#allowedByRobots(`${pagePath}${current.search}`))) {
        throw new WebFetchError('robots_disallowed');
      }
      if (this.#slowPaths.has(pagePath)) {
        await untilAborted(signal);
        throw abortedError();
      }

      const route = this.#routes[pagePath];
      if (route?.redirectTo !== undefined) {
        if (redirects >= MAX_REDIRECTS) throw new WebFetchError('http_error', { httpStatus: route.status ?? 301 });
        current = this.#parse(new URL(route.redirectTo, current).href);
        continue;
      }

      const resolved = route !== undefined ? this.#fromRoute(route) : await this.#fromFile(pagePath);
      if (signal.aborted) throw abortedError();
      if (resolved.status < 200 || resolved.status > 299) throw new WebFetchError('http_error', { httpStatus: resolved.status });
      const mediaType = resolved.contentType.split(';')[0]?.trim().toLowerCase();
      if (mediaType !== 'text/html' && mediaType !== 'text/plain') throw new WebFetchError('bad_content_type');
      if (Buffer.byteLength(resolved.body, 'utf8') > maxBytes) throw new WebFetchError('too_large');
      return { finalUrl: current.href, status: resolved.status, contentType: resolved.contentType, body: resolved.body };
    }
  }

  #parse(url: string): URL {
    try {
      return new URL(url);
    } catch {
      throw new WebFetchError('blocked_by_ssrf');
    }
  }

  #assertNotBlocked(url: URL): void {
    const hostname = url.hostname.toLowerCase();
    const blocked =
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username !== '' ||
      url.password !== '' ||
      (url.port !== '' && url.port !== '80' && url.port !== '443') ||
      isIpLiteral(hostname) ||
      !hostname.includes('.') ||
      BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
      this.#blockedHosts.has(hostname);
    if (blocked) throw new WebFetchError('blocked_by_ssrf');
  }

  async #allowedByRobots(pathWithQuery: string): Promise<boolean> {
    if (this.#robots === null) {
      const file = await this.#readFixture('robots.txt');
      this.#robots = parseRobots(file ?? '');
    }
    return isAllowedByRobots(this.#robots, this.#userAgentToken, pathWithQuery);
  }

  #fromRoute(route: FakeRoute): Resolved {
    return { status: route.status ?? 200, contentType: route.contentType ?? HTML, body: route.body ?? '' };
  }

  async #fromFile(pagePath: string): Promise<Resolved> {
    const candidates =
      pagePath === '/'
        ? ['index.html']
        : /\.(?:html|txt)$/.test(pagePath)
          ? [pagePath.slice(1)]
          : [`${pagePath.slice(1)}.html`, `${pagePath.slice(1)}/index.html`];
    for (const relative of candidates) {
      const body = await this.#readFixture(relative);
      if (body !== null) return { status: 200, contentType: relative.endsWith('.txt') ? TEXT : HTML, body };
    }
    return { status: 404, contentType: HTML, body: '<h1>Not found</h1>' };
  }

  async #readFixture(relative: string): Promise<string | null> {
    const file = path.resolve(this.#siteDir, relative);
    if (!file.startsWith(this.#siteDir + path.sep)) return null;
    if (this.#preloaded !== null) return this.#preloaded.get(path.relative(this.#siteDir, file).split(path.sep).join('/')) ?? null;
    try {
      return await readFile(/*turbopackIgnore: true*/ file, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'EISDIR')) return null;
      throw error;
    }
  }
}
