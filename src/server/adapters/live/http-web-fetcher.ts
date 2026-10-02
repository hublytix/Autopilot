import 'server-only';
import { fetch as undiciFetch, type Dispatcher, type Response as UndiciResponse } from 'undici';
import { WebFetchError } from '@/server/domain/errors';
import { ALLOW_ALL_ROBOTS, DISALLOW_ALL_ROBOTS, isAllowedByRobots, parseRobots, type RobotsRules } from '@/server/domain/robots';
import type { Clock } from '@/server/ports/clock';
import type { FetchedPage, WebFetcher, WebFetchOptions } from '@/server/ports/web-fetcher';
import { assertFetchableUrl, createSsrfAgent, isSsrfRefusal, parseFetchableUrl, type Resolver } from '@/server/security/ssrf';

// The live WebFetcher (PLAN §9.7, §10.4) on undici 7 with the SSRF-guarded Agent:
// - every request (robots.txt, the page, each redirect hop) goes through the same guarded Agent, and
//   every redirect target is checked again (URL form, robots.txt, then the address at connect);
// - at most 3 redirects, followed by hand (`redirect: 'manual'`);
// - only text/html and text/plain are read, at most `maxBytes` after decompression (counted while
//   streaming, so a compressed bomb is cut off early);
// - our own user agent, no cookies and no auth headers (undici's fetch has no cookie jar);
// - robots.txt per origin (RFC 9309): 2xx → its rules; 4xx → allow all; 5xx, 429, a timeout or an
//   unreachable server → disallow all; cached per origin for 10 minutes.
// Errors are WebFetchError codes only; URLs, bodies and provider messages are never logged or kept.

/** The robots.txt product token (PLAN §10.4). */
export const WEB_FETCHER_PRODUCT_TOKEN = 'HublytixAutopilot';

export function webFetcherUserAgent(appUrl: string): string {
  return `${WEB_FETCHER_PRODUCT_TOKEN}/1.0 (+${appUrl})`;
}

/** Redirects followed per fetch (PLAN §10.4). */
export const WEB_FETCH_MAX_REDIRECTS = 3;
/** robots.txt: at most 500 KiB (RFC 9309 §2.5), 10 s, cached 10 minutes per origin. */
export const ROBOTS_MAX_BYTES = 500 * 1024;
export const ROBOTS_TIMEOUT_MS = 10_000;
export const ROBOTS_CACHE_MS = 10 * 60 * 1000;
const ROBOTS_CACHE_ENTRIES = 64;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const READABLE_TYPES: ReadonlySet<string> = new Set(['text/html', 'text/plain']);

export interface HttpWebFetcherOptions {
  /** APP_URL, named in the user agent. */
  appUrl: string;
  /** Default: the guarded Agent from createSsrfAgent (tests pass a MockAgent). */
  dispatcher?: Dispatcher | undefined;
  /** Used for the default Agent only; default the system resolver. */
  resolver?: Resolver | undefined;
  /** For the robots.txt cache's age; without it entries live as long as the instance (bounded in number). */
  clock?: Clock | undefined;
}

type RobotsOutcome = { readonly kind: 'rules'; readonly rules: RobotsRules } | { readonly kind: 'blocked' };

interface RobotsEntry {
  readonly outcome: Promise<RobotsOutcome>;
  readonly at: number | null;
}

interface Hop {
  readonly checkRobots: boolean;
  readonly signal: AbortSignal;
  readonly maxBytes: number;
}

function mediaTypeOf(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

function charsetOf(contentType: string): string | null {
  const match = /;\s*charset\s*=\s*"?([A-Za-z0-9_.:-]{1,40})"?/i.exec(contentType);
  return match?.[1]?.toLowerCase() ?? null;
}

/** A `<meta charset>` in the first bytes of an HTML document that sent no charset header. */
function sniffMetaCharset(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, 2048)).toString('latin1');
  const match = /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_.:-]{1,40})/i.exec(head);
  return match?.[1]?.toLowerCase() ?? null;
}

function decode(bytes: Uint8Array, contentType: string): string {
  const label = charsetOf(contentType) ?? (mediaTypeOf(contentType) === 'text/html' ? sniffMetaCharset(bytes) : null) ?? 'utf-8';
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  return decoder.decode(bytes);
}

async function discard(response: UndiciResponse): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The connection is closed either way.
  }
}

/** Reads the (already decompressed) body, refusing it once it passes `maxBytes`. */
async function readCapped(response: UndiciResponse, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (response.headers.get('content-encoding') === null && Number.isFinite(declared) && declared > maxBytes) {
    await discard(response);
    throw new WebFetchError('too_large');
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new WebFetchError('too_large');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Waits for `promise`, or rejects with `timeout` as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new WebFetchError('timeout'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new WebFetchError('timeout'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export class HttpWebFetcher implements WebFetcher {
  readonly #dispatcher: Dispatcher;
  readonly #userAgent: string;
  readonly #clock: Clock | undefined;
  readonly #robots = new Map<string, RobotsEntry>();

  constructor(options: HttpWebFetcherOptions) {
    this.#dispatcher = options.dispatcher ?? createSsrfAgent({ resolver: options.resolver });
    this.#userAgent = webFetcherUserAgent(options.appUrl);
    this.#clock = options.clock;
  }

  async fetch(url: string, options: WebFetchOptions): Promise<FetchedPage> {
    if (!Number.isFinite(options.maxBytes) || options.maxBytes < 0) throw new RangeError('web_fetcher_invalid_max_bytes');
    const start = parseFetchableUrl(url);
    return this.#follow(start, { checkRobots: true, signal: options.signal, maxBytes: options.maxBytes });
  }

  async #follow(start: URL, hop: Hop): Promise<FetchedPage> {
    let current = start;
    for (let redirects = 0; ; redirects += 1) {
      if (hop.signal.aborted) throw new WebFetchError('timeout');
      if (hop.checkRobots && current.pathname !== '/robots.txt') await this.#assertRobotsAllow(current, hop.signal);
      const response = await this.#request(current, hop.signal);
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        await discard(response);
        if (location === null || redirects >= WEB_FETCH_MAX_REDIRECTS) throw new WebFetchError('http_error', { httpStatus: response.status });
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new WebFetchError('http_error', { httpStatus: response.status });
        }
        assertFetchableUrl(next);
        next.hash = '';
        current = next;
        continue;
      }
      if (response.status < 200 || response.status > 299) {
        await discard(response);
        throw new WebFetchError('http_error', { httpStatus: response.status });
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!READABLE_TYPES.has(mediaTypeOf(contentType))) {
        await discard(response);
        throw new WebFetchError('bad_content_type');
      }
      const bytes = await this.#read(response, hop);
      return { finalUrl: current.href, status: response.status, contentType, body: decode(bytes, contentType) };
    }
  }

  async #request(url: URL, signal: AbortSignal): Promise<UndiciResponse> {
    try {
      return await undiciFetch(url.href, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        signal,
        dispatcher: this.#dispatcher,
        headers: { 'user-agent': this.#userAgent, accept: 'text/html, text/plain;q=0.9', 'accept-language': 'en' },
      });
    } catch (error) {
      throw this.#networkError(error, signal);
    }
  }

  async #read(response: UndiciResponse, hop: Hop): Promise<Uint8Array> {
    try {
      return await readCapped(response, hop.maxBytes);
    } catch (error) {
      if (error instanceof WebFetchError) throw error;
      throw this.#networkError(error, hop.signal);
    }
  }

  #networkError(error: unknown, signal: AbortSignal): WebFetchError {
    if (isSsrfRefusal(error)) return new WebFetchError('blocked_by_ssrf');
    if (signal.aborted) return new WebFetchError('timeout');
    // DNS failure, refused connection, TLS failure, reset: no status.
    return new WebFetchError('http_error');
  }

  async #assertRobotsAllow(url: URL, signal: AbortSignal): Promise<void> {
    const outcome = await untilAborted(this.#robotsFor(url.origin), signal);
    if (outcome.kind === 'blocked') throw new WebFetchError('blocked_by_ssrf');
    if (!isAllowedByRobots(outcome.rules, WEB_FETCHER_PRODUCT_TOKEN, `${url.pathname}${url.search}`)) {
      throw new WebFetchError('robots_disallowed');
    }
  }

  #robotsFor(origin: string): Promise<RobotsOutcome> {
    const now = this.#clock?.now().getTime() ?? null;
    const cached = this.#robots.get(origin);
    if (cached !== undefined && (now === null || cached.at === null || now - cached.at < ROBOTS_CACHE_MS)) return cached.outcome;
    if (cached !== undefined) this.#robots.delete(origin);
    while (this.#robots.size >= ROBOTS_CACHE_ENTRIES) {
      const oldest = this.#robots.keys().next();
      if (oldest.done === true) break;
      this.#robots.delete(oldest.value);
    }
    const outcome = this.#loadRobots(origin);
    this.#robots.set(origin, { outcome, at: now });
    return outcome;
  }

  async #loadRobots(origin: string): Promise<RobotsOutcome> {
    try {
      const page = await this.#follow(parseFetchableUrl(`${origin}/robots.txt`), {
        checkRobots: false,
        signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS),
        maxBytes: ROBOTS_MAX_BYTES,
      });
      return { kind: 'rules', rules: parseRobots(page.body) };
    } catch (error) {
      if (!(error instanceof WebFetchError)) return { kind: 'rules', rules: DISALLOW_ALL_ROBOTS };
      switch (error.code) {
        case 'blocked_by_ssrf':
          return { kind: 'blocked' };
        case 'bad_content_type':
          // Not a robots file (e.g. an image or a download): as if there were none.
          return { kind: 'rules', rules: ALLOW_ALL_ROBOTS };
        case 'http_error': {
          const status = error.httpStatus;
          const unavailable = status !== undefined && status >= 400 && status <= 499 && status !== 429;
          return { kind: 'rules', rules: unavailable ? ALLOW_ALL_ROBOTS : DISALLOW_ALL_ROBOTS };
        }
        default:
          return { kind: 'rules', rules: DISALLOW_ALL_ROBOTS };
      }
    }
  }
}
