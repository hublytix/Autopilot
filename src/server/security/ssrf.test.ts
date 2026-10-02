import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebFetchError } from '@/server/domain/errors';
import {
  createGuardedConnector,
  createGuardedLookup,
  isBlockedAddress,
  isSsrfRefusal,
  METADATA_ADDRESSES,
  parseFetchableUrl,
  resolveVetted,
  SsrfLookupError,
  urlRefusal,
  type ResolvedAddress,
  type Resolver,
} from './ssrf';

const PUBLIC_V4: ResolvedAddress = { address: '93.184.215.14', family: 4 };
const PUBLIC_V6: ResolvedAddress = { address: '2606:4700:4700::1111', family: 6 };

/** A resolver answering from a queue (one entry per call; the last entry repeats). */
function queuedResolver(...answers: (readonly ResolvedAddress[])[]): Resolver & { calls: string[] } {
  const calls: string[] = [];
  const resolver = async (hostname: string): Promise<readonly ResolvedAddress[]> => {
    calls.push(hostname);
    return answers[Math.min(calls.length - 1, answers.length - 1)] ?? [];
  };
  return Object.assign(resolver, { calls });
}

describe('isBlockedAddress: IPv4', () => {
  it.each([
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.1',
    '10.255.255.255',
    '100.64.0.1',
    '100.127.255.255',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.0.2.1',
    '192.88.99.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '239.255.255.250',
    '240.0.0.1',
    '255.255.255.255',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['93.184.215.14', '8.8.8.8', '1.1.1.1', '100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0', '169.253.255.255', '11.0.0.1'])(
    'allows the public address %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );

  it.each([...METADATA_ADDRESSES])('blocks the cloud metadata address %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });
});

describe('isBlockedAddress: IPv6 forms', () => {
  it.each([
    ['unspecified', '::'],
    ['loopback', '::1'],
    ['IPv4-mapped loopback (dotted)', '::ffff:127.0.0.1'],
    ['IPv4-mapped loopback (hex)', '::ffff:7f00:1'],
    ['IPv4-mapped metadata', '::ffff:169.254.169.254'],
    ['IPv4-mapped public (the whole range is refused)', '::ffff:8.8.8.8'],
    ['IPv4-mapped, fully written out', '0:0:0:0:0:ffff:a9fe:a9fe'],
    ['IPv4-compatible', '::127.0.0.1'],
    ['NAT64 metadata', '64:ff9b::a9fe:a9fe'],
    ['NAT64 public', '64:ff9b::8.8.8.8'],
    ['local-use NAT64', '64:ff9b:1::1'],
    ['discard-only', '100::1'],
    ['Teredo', '2001:0:4136:e378:8000:63bf:3fff:fdd2'],
    ['documentation', '2001:db8::1'],
    ['6to4 metadata', '2002:a9fe:a9fe::1'],
    ['6to4 private', '2002:c0a8:101::'],
    ['unique local', 'fc00::1'],
    ['AWS metadata', 'fd00:ec2::254'],
    ['link-local', 'fe80::1'],
    ['link-local with a zone id', 'fe80::1%eth0'],
    ['site-local', 'fec0::1'],
    ['multicast', 'ff02::1'],
    ['documentation (3fff::/20)', '3fff::1'],
  ])('blocks %s (%s)', (_name, address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001:80b::200e', '2600::1'])('allows the global address %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it.each(['', 'example.com', '1.2.3', '256.1.1.1', ':::1', '1::2::3', 'gggg::1'])('treats the non-address %j as blocked', (value) => {
    expect(isBlockedAddress(value)).toBe(true);
  });
});

describe('urlRefusal and parseFetchableUrl', () => {
  it.each([
    ['ftp://files.example.com/a', 'scheme_not_allowed'],
    ['file:///etc/passwd', 'scheme_not_allowed'],
    ['https://user:secret@site.example.com/', 'credentials_not_allowed'],
    ['https://site.example.com:8443/', 'port_not_allowed'],
    ['http://site.example.com:22/', 'port_not_allowed'],
    ['https://127.0.0.1/', 'ip_literal_host'],
    ['http://169.254.169.254/latest/meta-data/', 'ip_literal_host'],
    ['http://2130706433/', 'ip_literal_host'],
    ['http://0x7f.1/', 'ip_literal_host'],
    ['https://[::1]/', 'ip_literal_host'],
    ['https://[::ffff:169.254.169.254]/', 'ip_literal_host'],
    ['https://[fd00:ec2::254]/', 'ip_literal_host'],
    ['http://intranet/', 'single_label_host'],
    ['http://localhost/', 'single_label_host'],
    ['http://localhost./', 'single_label_host'],
    ['http://app.localhost/', 'local_host'],
    ['http://metadata.google.internal/', 'local_host'],
    ['http://printer.local/', 'local_host'],
    ['http://router.home.arpa/', 'local_host'],
  ])('refuses %s (%s)', (raw, reason) => {
    expect(urlRefusal(new URL(raw))).toBe(reason);
    expect(() => parseFetchableUrl(raw)).toThrow(WebFetchError);
  });

  it.each(['https://brightside-plumbing.example/', 'http://site.example.com:80/a?b=1', 'http://site.example.com:443/', 'https://example.com./'])(
    'accepts %s',
    (raw) => {
      expect(urlRefusal(new URL(raw))).toBeNull();
      expect(parseFetchableUrl(raw).href).toBe(new URL(raw).href);
    },
  );

  it('refuses an unparseable URL as blocked_by_ssrf', () => {
    expect(() => parseFetchableUrl('not a url')).toThrow(expect.objectContaining({ code: 'blocked_by_ssrf' }) as Error);
  });
});

describe('resolveVetted', () => {
  it('returns every answer when all of them are public', async () => {
    await expect(resolveVetted('site.example.com', { resolver: queuedResolver([PUBLIC_V4, PUBLIC_V6]) })).resolves.toEqual([PUBLIC_V4, PUBLIC_V6]);
  });

  it('refuses the whole host when any answer is private (a mixed answer cannot be used)', async () => {
    const resolver = queuedResolver([PUBLIC_V4, { address: '10.0.0.7', family: 4 }]);
    await expect(resolveVetted('site.example.com', { resolver })).rejects.toMatchObject({ code: 'ssrf_blocked_address' });
  });

  it('refuses an empty answer and turns a resolver failure into ssrf_dns_failed', async () => {
    await expect(resolveVetted('site.example.com', { resolver: queuedResolver([]) })).rejects.toMatchObject({ code: 'ssrf_no_address' });
    const failing: Resolver = () => Promise.reject(new Error('getaddrinfo ENOTFOUND site.example.com'));
    const error: unknown = await resolveVetted('site.example.com', { resolver: failing }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SsrfLookupError);
    expect((error as SsrfLookupError).message).toBe('ssrf_dns_failed');
  });

  it('checks an IP literal handed to the lookup without resolving it', async () => {
    const resolver = queuedResolver([PUBLIC_V4]);
    await expect(resolveVetted('169.254.169.254', { resolver })).rejects.toMatchObject({ code: 'ssrf_blocked_address' });
    expect(resolver.calls).toEqual([]);
  });
});

describe('createGuardedLookup', () => {
  type Answer = { error: NodeJS.ErrnoException | null; address: unknown; family?: number | undefined };

  function lookupOnce(lookup: ReturnType<typeof createGuardedLookup>, options: Parameters<ReturnType<typeof createGuardedLookup>>[1]): Promise<Answer> {
    return new Promise((resolve) => {
      lookup('site.example.com', options, (error, address, family) => resolve({ error, address, family }));
    });
  }

  it('answers in the all:true form Node uses with autoSelectFamily', async () => {
    const lookup = createGuardedLookup({ resolver: queuedResolver([PUBLIC_V4, PUBLIC_V6]) });
    const answer = await lookupOnce(lookup, { all: true });
    expect(answer.error).toBeNull();
    expect(answer.address).toEqual([PUBLIC_V4, PUBLIC_V6]);
  });

  it('answers with one vetted address in the single form, honouring the family', async () => {
    const lookup = createGuardedLookup({ resolver: queuedResolver([PUBLIC_V4, PUBLIC_V6]) });
    expect(await lookupOnce(lookup, {})).toEqual({ error: null, address: PUBLIC_V4.address, family: 4 });
    expect(await lookupOnce(lookup, { family: 6 })).toEqual({ error: null, address: PUBLIC_V6.address, family: 6 });
  });

  it('resolves and checks again on every connection: a rebinding host (public, then private) is refused the second time', async () => {
    const resolver = queuedResolver([PUBLIC_V4], [{ address: '169.254.169.254', family: 4 }]);
    const lookup = createGuardedLookup({ resolver });
    expect((await lookupOnce(lookup, { all: true })).error).toBeNull();
    const second = await lookupOnce(lookup, { all: true });
    expect(second.error).toBeInstanceOf(SsrfLookupError);
    expect(isSsrfRefusal(second.error)).toBe(true);
    expect(resolver.calls).toHaveLength(2);
  });

  it.each(['::ffff:127.0.0.1', '64:ff9b::a9fe:a9fe', '2002:a9fe:a9fe::1', 'fd00:ec2::254', 'fe80::1', '::1'])('refuses a host resolving to %s', async (address) => {
    const lookup = createGuardedLookup({ resolver: queuedResolver([{ address, family: 6 }]) });
    const answer = await lookupOnce(lookup, { all: true });
    expect(isSsrfRefusal(answer.error)).toBe(true);
  });
});

describe('createGuardedConnector (loopback test server only)', () => {
  let server: Server | undefined;
  const sockets: Socket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    await new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve())));
    server = undefined;
  });

  async function listen(): Promise<number> {
    server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    return address.port;
  }

  function connect(connector: ReturnType<typeof createGuardedConnector>, port: number): Promise<{ error: Error | null; socket: Socket | null }> {
    return new Promise((resolve) => {
      // On failure undici's connector calls back with the error alone.
      connector({ hostname: 'site.test', host: 'site.test', protocol: 'http:', port: String(port) }, (error, socket) => {
        if (socket !== null && socket !== undefined) sockets.push(socket);
        resolve({ error, socket: socket ?? null });
      });
    });
  }

  // Only the test server's loopback address is let through; every other rule is the real one.
  const isBlocked = (address: string): boolean => address !== '127.0.0.1' && isBlockedAddress(address);

  it('connects to the vetted address, then refuses the same host once DNS rebinds to a private address', async () => {
    const port = await listen();
    const resolver = queuedResolver([{ address: '127.0.0.1', family: 4 }], [{ address: '10.0.0.1', family: 4 }]);
    const connector = createGuardedConnector({ resolver, isBlocked });

    const first = await connect(connector, port);
    expect(first.error).toBeNull();
    expect(first.socket?.remoteAddress).toBe('127.0.0.1');

    const second = await connect(connector, port);
    expect(second.socket).toBeNull();
    expect(isSsrfRefusal(second.error)).toBe(true);
    // One resolution per connection, and nothing else resolved the name.
    expect(resolver.calls).toEqual(['site.test', 'site.test']);
  });

  it('refuses a host that resolves to the metadata address before opening a socket', async () => {
    const port = await listen();
    const connector = createGuardedConnector({ resolver: queuedResolver([{ address: '169.254.169.254', family: 4 }]), isBlocked });
    const result = await connect(connector, port);
    expect(result.socket).toBeNull();
    expect(isSsrfRefusal(result.error)).toBe(true);
  });
});

describe('isSsrfRefusal', () => {
  it('finds the refusal in a cause chain (undici wraps socket errors) and ignores DNS failures', () => {
    const wrapped = new TypeError('fetch failed', { cause: new Error('connect', { cause: new SsrfLookupError('ssrf_blocked_address') }) });
    expect(isSsrfRefusal(wrapped)).toBe(true);
    expect(isSsrfRefusal(new TypeError('fetch failed', { cause: new SsrfLookupError('ssrf_dns_failed') }))).toBe(false);
    expect(isSsrfRefusal(new Error('other'))).toBe(false);
    expect(isSsrfRefusal(undefined)).toBe(false);
  });
});
