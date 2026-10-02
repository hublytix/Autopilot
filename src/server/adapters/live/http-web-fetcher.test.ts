import { gzipSync } from 'node:zlib';
import { MockAgent, type MockPool } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebFetchError } from '@/server/domain/errors';
import type { WebFetchErrorCode } from '@/server/domain/types';
import type { WebFetchOptions } from '@/server/ports/web-fetcher';
import type { ResolvedAddress } from '@/server/security/ssrf';
import { FakeClock } from '../fake/clock';
import { HttpWebFetcher, ROBOTS_CACHE_MS, webFetcherUserAgent } from './http-web-fetcher';

const APP_URL = 'https://app.autopilot.example';
const ORIGIN = 'https://site.example.com';
const HTML = { 'content-type': 'text/html; charset=utf-8' };
const TEXT = { 'content-type': 'text/plain' };
const MB2 = 2 * 1024 * 1024;

let mock: MockAgent;
let site: MockPool;

beforeEach(() => {
  mock = new MockAgent();
  mock.disableNetConnect();
  site = mock.get(ORIGIN);
});

afterEach(async () => {
  await mock.close();
});

function options(overrides: Partial<WebFetchOptions> = {}): WebFetchOptions {
  return { signal: new AbortController().signal, maxBytes: MB2, ...overrides };
}

function fetcher(clock?: FakeClock): HttpWebFetcher {
  return new HttpWebFetcher({ appUrl: APP_URL, dispatcher: mock, clock });
}

function robots(body = 'User-agent: *\nDisallow: /private\n', status = 200): void {
  site.intercept({ path: '/robots.txt', method: 'GET' }).reply(status, body, { headers: TEXT });
}

async function codeOf(promise: Promise<unknown>): Promise<WebFetchErrorCode | 'ok'> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    if (error instanceof WebFetchError) return error.code;
    throw error;
  }
}

describe('HttpWebFetcher: requests', () => {
  it('fetches an HTML page with our user agent and no cookie or auth headers', async () => {
    robots();
    let seen: Record<string, string> = {};
    site.intercept({ path: '/', method: 'GET' }).reply(200, (opts) => {
      seen = Object.fromEntries(Object.entries(opts.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]));
      return '<h1>Welcome</h1>';
    }, { headers: HTML });

    const page = await fetcher().fetch(`${ORIGIN}/`, options());
    expect(page).toEqual({ finalUrl: `${ORIGIN}/`, status: 200, contentType: 'text/html; charset=utf-8', body: '<h1>Welcome</h1>' });
    expect(seen['user-agent']).toBe(webFetcherUserAgent(APP_URL));
    expect(seen['user-agent']).toBe('HublytixAutopilot/1.0 (+https://app.autopilot.example)');
    expect(seen).not.toHaveProperty('cookie');
    expect(seen).not.toHaveProperty('authorization');
  });

  it('reads text/plain and decodes the declared charset', async () => {
    robots();
    site.intercept({ path: '/notes.txt' }).reply(200, Buffer.from([0x63, 0x61, 0x66, 0xe9]), { headers: { 'content-type': 'text/plain; charset=iso-8859-1' } });
    expect((await fetcher().fetch(`${ORIGIN}/notes.txt`, options())).body).toBe('café');
  });

  it('decodes an HTML page by its <meta charset> when the header has none', async () => {
    robots();
    const bytes = Buffer.concat([Buffer.from('<meta charset="iso-8859-1"><p>caf'), Buffer.from([0xe9]), Buffer.from('</p>')]);
    site.intercept({ path: '/' }).reply(200, bytes, { headers: { 'content-type': 'text/html' } });
    expect((await fetcher().fetch(`${ORIGIN}/`, options())).body).toContain('<p>café</p>');
  });

  it.each([
    ['application/pdf', { 'content-type': 'application/pdf' }],
    ['image/svg+xml', { 'content-type': 'image/svg+xml' }],
    ['no content type', {}],
  ])('refuses %s as bad_content_type', async (_name, headers) => {
    robots();
    site.intercept({ path: '/file' }).reply(200, 'x', { headers });
    expect(await codeOf(fetcher().fetch(`${ORIGIN}/file`, options()))).toBe('bad_content_type');
  });

  it('reports a non-2xx answer as http_error with its status', async () => {
    robots();
    site.intercept({ path: '/gone' }).reply(410, 'Gone', { headers: HTML });
    const error: unknown = await fetcher().fetch(`${ORIGIN}/gone`, options()).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'http_error', httpStatus: 410 });
  });

  it('stops at the caller signal (timeout)', async () => {
    robots();
    site.intercept({ path: '/slow' }).reply(200, 'late', { headers: HTML }).delay(5_000);
    const controller = new AbortController();
    const pending = fetcher().fetch(`${ORIGIN}/slow`, options({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);
    expect(await codeOf(pending)).toBe('timeout');
    expect(await codeOf(fetcher().fetch(`${ORIGIN}/`, options({ signal: AbortSignal.abort() })))).toBe('timeout');
  });
});

describe('HttpWebFetcher: size limit after decompression', () => {
  it('accepts a body of exactly maxBytes and refuses one byte more', async () => {
    robots();
    site.intercept({ path: '/exact' }).reply(200, 'a'.repeat(1000), { headers: HTML });
    site.intercept({ path: '/over' }).reply(200, 'a'.repeat(1001), { headers: HTML });
    const f = fetcher();
    expect((await f.fetch(`${ORIGIN}/exact`, options({ maxBytes: 1000 }))).body).toHaveLength(1000);
    expect(await codeOf(f.fetch(`${ORIGIN}/over`, options({ maxBytes: 1000 })))).toBe('too_large');
  });

  it('counts decompressed bytes: a small gzip body that inflates past 2 MB is too_large', async () => {
    robots();
    const bomb = gzipSync(Buffer.alloc(MB2 + 1, 0x61));
    expect(bomb.byteLength).toBeLessThan(10_000);
    site.intercept({ path: '/bomb' }).reply(200, bomb, { headers: { ...HTML, 'content-encoding': 'gzip' } });
    site.intercept({ path: '/small' }).reply(200, gzipSync(Buffer.from('<p>compressed page</p>')), { headers: { ...HTML, 'content-encoding': 'gzip' } });
    const f = fetcher();
    expect(await codeOf(f.fetch(`${ORIGIN}/bomb`, options()))).toBe('too_large');
    expect((await f.fetch(`${ORIGIN}/small`, options())).body).toBe('<p>compressed page</p>');
  });

  it('refuses early on a declared Content-Length above the limit', async () => {
    robots();
    site.intercept({ path: '/big' }).reply(200, 'a'.repeat(3000), { headers: { ...HTML, 'content-length': '3000' } });
    expect(await codeOf(fetcher().fetch(`${ORIGIN}/big`, options({ maxBytes: 2000 })))).toBe('too_large');
  });
});

describe('HttpWebFetcher: redirects', () => {
  it('follows up to 3 redirects and reports the final URL', async () => {
    robots();
    site.intercept({ path: '/a' }).reply(301, '', { headers: { location: '/b' } });
    site.intercept({ path: '/b' }).reply(302, '', { headers: { location: `${ORIGIN}/c` } });
    site.intercept({ path: '/c' }).reply(308, '', { headers: { location: '/d#frag' } });
    site.intercept({ path: '/d' }).reply(200, '<p>d</p>', { headers: HTML });
    const page = await fetcher().fetch(`${ORIGIN}/a`, options());
    expect(page.finalUrl).toBe(`${ORIGIN}/d`);
    expect(page.body).toBe('<p>d</p>');
  });

  it('refuses a fourth redirect', async () => {
    robots();
    for (const [from, to] of [['/1', '/2'], ['/2', '/3'], ['/3', '/4'], ['/4', '/5']] as const) {
      site.intercept({ path: from }).reply(301, '', { headers: { location: to } });
    }
    const error: unknown = await fetcher().fetch(`${ORIGIN}/1`, options()).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'http_error', httpStatus: 301 });
  });

  it.each([
    ['the metadata IP', 'http://169.254.169.254/latest/meta-data/'],
    ['an IPv6 metadata literal', 'http://[fd00:ec2::254]/'],
    ['an IPv4-mapped loopback literal', 'http://[::ffff:127.0.0.1]/'],
    ['a decimal loopback host', 'http://2130706433/'],
    ['an internal name', 'http://metadata.google.internal/computeMetadata/v1/'],
    ['a single-label host', 'http://intranet/'],
    ['another port', 'https://site.example.com:8443/'],
    ['another scheme', 'file:///etc/passwd'],
  ])('refuses a redirect to %s before following it', async (_name, location) => {
    robots();
    site.intercept({ path: '/' }).reply(302, '', { headers: { location } });
    expect(await codeOf(fetcher().fetch(`${ORIGIN}/`, options()))).toBe('blocked_by_ssrf');
  });

  it('checks robots.txt for the redirect target too', async () => {
    robots();
    site.intercept({ path: '/staff' }).reply(302, '', { headers: { location: '/private/rota' } });
    expect(await codeOf(fetcher().fetch(`${ORIGIN}/staff`, options()))).toBe('robots_disallowed');
  });
});

describe('HttpWebFetcher: robots.txt', () => {
  it('refuses a disallowed path without requesting it, and caches the rules per origin', async () => {
    robots('User-agent: *\nDisallow: /private\n\nUser-agent: HublytixAutopilot\nDisallow: /no-autopilot\n');
    site.intercept({ path: '/about' }).reply(200, '<p>about</p>', { headers: HTML });
    site.intercept({ path: '/private' }).reply(200, '<p>secret</p>', { headers: HTML });
    const f = fetcher();
    // Our own group applies (it replaces the * group).
    expect(await codeOf(f.fetch(`${ORIGIN}/no-autopilot`, options()))).toBe('robots_disallowed');
    expect(await codeOf(f.fetch(`${ORIGIN}/about`, options()))).toBe('ok');
    expect(await codeOf(f.fetch(`${ORIGIN}/private`, options()))).toBe('ok');
    // robots.txt was intercepted once: the second and third fetches used the cache.
    expect(mock.pendingInterceptors()).toEqual([]);
  });

  it('allows everything when robots.txt is missing (404)', async () => {
    robots('Not found', 404);
    site.intercept({ path: '/private' }).reply(200, '<p>ok</p>', { headers: HTML });
    expect(await codeOf(fetcher().fetch(`${ORIGIN}/private`, options()))).toBe('ok');
  });

  it.each([500, 503, 429])('refuses everything while robots.txt answers %i', async (status) => {
    robots('error', status);
    expect(await codeOf(fetcher().fetch(`${ORIGIN}/`, options()))).toBe('robots_disallowed');
  });

  it('fetches robots.txt again once the cached copy is 10 minutes old', async () => {
    const clock = new FakeClock(new Date('2026-10-02T09:00:00.000Z'));
    const f = fetcher(clock);
    robots('User-agent: *\nDisallow: /a\n');
    site.intercept({ path: '/b' }).reply(200, '<p>b</p>', { headers: HTML });
    expect(await codeOf(f.fetch(`${ORIGIN}/b`, options()))).toBe('ok');
    clock.advance(ROBOTS_CACHE_MS);
    robots('User-agent: *\nDisallow: /b\n');
    expect(await codeOf(f.fetch(`${ORIGIN}/b`, options()))).toBe('robots_disallowed');
  });
});

describe('HttpWebFetcher: the SSRF guard at connect (real Agent, stubbed resolver, no socket opened)', () => {
  const resolving =
    (...addresses: string[]) =>
    async (): Promise<readonly ResolvedAddress[]> =>
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }) as const);

  it.each([
    ['a private IPv4 address', ['10.0.0.5']],
    ['the metadata address', ['169.254.169.254']],
    ['CGNAT', ['100.64.12.1']],
    ['an IPv4-mapped loopback', ['::ffff:127.0.0.1']],
    ['NAT64 of the metadata address', ['64:ff9b::a9fe:a9fe']],
    ['6to4 of the metadata address', ['2002:a9fe:a9fe::1']],
    ['the AWS IPv6 metadata address', ['fd00:ec2::254']],
    ['a mixed public and private answer', ['93.184.215.14', '192.168.0.10']],
  ])('refuses a host resolving to %s', async (_name, addresses) => {
    const f = new HttpWebFetcher({ appUrl: APP_URL, resolver: resolving(...addresses) });
    expect(await codeOf(f.fetch('https://rebind.example.com/', options()))).toBe('blocked_by_ssrf');
  });

  it('refuses IP-literal and single-label URLs before resolving anything', async () => {
    let calls = 0;
    const f = new HttpWebFetcher({
      appUrl: APP_URL,
      resolver: async () => {
        calls += 1;
        return [];
      },
    });
    for (const url of ['https://93.184.215.14/', 'https://[2606:4700:4700::1111]/', 'http://localhost/', 'https://site.example.com:8080/', 'not a url']) {
      expect(await codeOf(f.fetch(url, options()))).toBe('blocked_by_ssrf');
    }
    expect(calls).toBe(0);
  });
});
