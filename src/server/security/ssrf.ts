import 'server-only';
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { isIP, isIPv4, isIPv6 } from 'node:net';
import { Agent, buildConnector } from 'undici';
import { WebFetchError } from '@/server/domain/errors';

// The SSRF guard for the brief crawler (PLAN §10.4, D-47). Two layers:
// 1. URL checks, before any request and again for every redirect target: http(s) only, ports 80 and
//    443 only, no credentials, no IP-literal or single-label hosts, no local-only suffixes.
// 2. Address checks when the socket opens: the undici Agent's connector resolves the hostname with
//    a guarded `lookup`, refuses the host if ANY answer is a disallowed address, and hands the
//    socket only the vetted answers, so the connection goes to an address that was checked (no
//    second resolution, so DNS rebinding between check and connect is impossible). Every new
//    connection resolves and checks again.
// Disallowed: every IPv4 special-purpose range that is not globally reachable (private, loopback,
// link-local and the metadata address, CGNAT, 0.0.0.0/8, documentation, benchmarking, multicast,
// reserved, broadcast); for IPv6 anything outside global unicast 2000::/3 (loopback, unspecified,
// IPv4-mapped ::ffff:0:0/96, IPv4-compatible, NAT64 64:ff9b::/96 and 64:ff9b:1::/48, discard,
// ULA fc00::/7 with the AWS metadata fd00:ec2::254, link-local, multicast) plus Teredo, 6to4
// 2002::/16, ORCHID, benchmarking and documentation inside it.

/** One DNS answer. */
export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/** Resolves a hostname to every address it has (tests pass a stub). */
export type Resolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

/** The operating system's resolver (getaddrinfo), every answer, in the resolver's order. */
export const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error !== null) {
        reject(new SsrfLookupError('ssrf_dns_failed'));
        return;
      }
      resolve(addresses.flatMap((a) => (a.family === 4 || a.family === 6 ? [{ address: a.address, family: a.family }] : [])));
    });
  });

/** Ports a crawl may connect to. */
export const ALLOWED_PORTS: ReadonlySet<string> = new Set(['', '80', '443']);

/** Suffixes that name local-only zones (RFC 6761, RFC 8375, common internal TLDs). */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan', '.intranet', '.corp'];

/** Cloud metadata addresses, named for clarity; each also lies in a blocked range below. */
export const METADATA_ADDRESSES = ['169.254.169.254', '169.254.170.2', '100.100.100.200', 'fd00:ec2::254'] as const;

/** A lookup or connection the guard refused; `code` is the reason (never the host or address). */
export class SsrfLookupError extends Error {
  override readonly name: string = 'SsrfLookupError';
  readonly code: 'ssrf_blocked_address' | 'ssrf_dns_failed' | 'ssrf_no_address';

  constructor(code: 'ssrf_blocked_address' | 'ssrf_dns_failed' | 'ssrf_no_address') {
    super(code);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------------------------

interface Cidr {
  readonly version: 4 | 6;
  readonly base: bigint;
  readonly prefix: number;
}

function ipv4ToBigInt(address: string): bigint | null {
  if (!isIPv4(address)) return null;
  let value = 0n;
  for (const part of address.split('.')) value = (value << 8n) | BigInt(Number(part));
  return value;
}

/** Parses an IPv6 address (with `::` and an optional dotted IPv4 tail; a zone id is ignored). */
function ipv6ToBigInt(raw: string): bigint | null {
  const address = raw.split('%')[0] ?? '';
  if (!isIPv6(address)) return null;
  let text = address.toLowerCase();
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail?.[1] !== undefined) {
    const v4 = ipv4ToBigInt(tail[1]);
    if (v4 === null) return null;
    text = `${text.slice(0, -tail[1].length)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head = '', rest] = text.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const restGroups = rest === undefined || rest === '' ? [] : rest.split(':');
  const missing = 8 - headGroups.length - restGroups.length;
  if (rest === undefined ? missing !== 0 : missing < 1) return null;
  const groups = [...headGroups, ...Array<string>(rest === undefined ? 0 : missing).fill('0'), ...restGroups];
  let value = 0n;
  for (const group of groups) value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  return value;
}

function cidr(text: string): Cidr {
  const [address = '', prefixText = ''] = text.split('/');
  const prefix = Number(prefixText);
  const v4 = ipv4ToBigInt(address);
  if (v4 !== null) return { version: 4, base: v4, prefix };
  const v6 = ipv6ToBigInt(address);
  if (v6 === null) throw new RangeError('ssrf_bad_cidr');
  return { version: 6, base: v6, prefix };
}

function contains(range: Cidr, version: 4 | 6, value: bigint): boolean {
  if (range.version !== version) return false;
  const bits = BigInt(version === 4 ? 32 : 128);
  const shift = bits - BigInt(range.prefix);
  return value >> shift === range.base >> shift;
}

/** IPv4 ranges that are not globally reachable (IANA special-purpose registry). */
const BLOCKED_V4 = [
  '0.0.0.0/8', // "this network"
  '10.0.0.0/8', // private
  '100.64.0.0/10', // CGNAT (includes 100.100.100.200, a metadata address)
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local (includes 169.254.169.254, the metadata address)
  '172.16.0.0/12', // private
  '192.0.0.0/24', // IETF protocol assignments
  '192.0.2.0/24', // documentation
  '192.88.99.0/24', // 6to4 relay anycast
  '192.168.0.0/16', // private
  '198.18.0.0/15', // benchmarking
  '198.51.100.0/24', // documentation
  '203.0.113.0/24', // documentation
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved, including 255.255.255.255 broadcast
].map(cidr);

/** IPv6: only global unicast is reachable, minus the special ranges inside it. */
const GLOBAL_UNICAST_V6 = cidr('2000::/3');
const BLOCKED_V6 = [
  '::ffff:0:0/96', // IPv4-mapped
  '::/96', // IPv4-compatible, :: and ::1
  '64:ff9b::/96', // NAT64
  '64:ff9b:1::/48', // local-use NAT64
  '100::/64', // discard-only
  '2001::/32', // Teredo (embeds an IPv4 address)
  '2001:2::/48', // benchmarking
  '2001:10::/28', // ORCHID
  '2001:20::/28', // ORCHIDv2
  '2001:db8::/32', // documentation
  '2002::/16', // 6to4 (embeds an IPv4 address)
  '3fff::/20', // documentation
  'fc00::/7', // unique local (includes fd00:ec2::254, a metadata address)
  'fe80::/10', // link-local
  'fec0::/10', // site-local (deprecated)
  'ff00::/8', // multicast
].map(cidr);

/** True for any address a crawl must not connect to, and for anything that does not parse as an IP. */
export function isBlockedAddress(address: string): boolean {
  const v4 = ipv4ToBigInt(address);
  if (v4 !== null) return BLOCKED_V4.some((range) => contains(range, 4, v4));
  const v6 = ipv6ToBigInt(address);
  if (v6 === null) return true;
  if (!contains(GLOBAL_UNICAST_V6, 6, v6)) return true;
  return BLOCKED_V6.some((range) => contains(range, 6, v6));
}

// ---------------------------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------------------------

/** Why a URL is refused before any request; logged as a code, never with the URL. */
export type UrlRefusal =
  | 'scheme_not_allowed'
  | 'credentials_not_allowed'
  | 'port_not_allowed'
  | 'ip_literal_host'
  | 'single_label_host'
  | 'local_host';

/** The hostname without IPv6 brackets or a trailing dot, lower case. */
function bareHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/** The reason `url` may not be fetched, or null when its form is acceptable (the address is checked at connect). */
export function urlRefusal(url: URL): UrlRefusal | null {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'scheme_not_allowed';
  if (url.username !== '' || url.password !== '') return 'credentials_not_allowed';
  if (!ALLOWED_PORTS.has(url.port)) return 'port_not_allowed';
  const host = bareHostname(url);
  if (isIP(host) !== 0 || url.hostname.startsWith('[')) return 'ip_literal_host';
  if (!host.includes('.')) return 'single_label_host';
  if (host === 'localhost' || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return 'local_host';
  return null;
}

/** Throws WebFetchError('blocked_by_ssrf') unless `url` has a fetchable form. */
export function assertFetchableUrl(url: URL): void {
  if (urlRefusal(url) !== null) throw new WebFetchError('blocked_by_ssrf');
}

/** Parses and checks a URL; anything unparseable is refused like a blocked one. */
export function parseFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebFetchError('blocked_by_ssrf');
  }
  assertFetchableUrl(url);
  return url;
}

// ---------------------------------------------------------------------------------------------
// Connect-time checks
// ---------------------------------------------------------------------------------------------

export interface GuardOptions {
  /** Default: the operating system's resolver. */
  resolver?: Resolver | undefined;
  /** Default isBlockedAddress. Tests only: lets a loopback test server through, nothing else changes. */
  isBlocked?: ((address: string) => boolean) | undefined;
}

/**
 * Resolves `hostname` and returns its answers when every one of them is allowed. A host with any
 * disallowed answer is refused outright, so a mixed answer cannot be used to reach an internal address.
 */
export async function resolveVetted(hostname: string, options: GuardOptions = {}): Promise<ResolvedAddress[]> {
  const isBlocked = options.isBlocked ?? isBlockedAddress;
  const literal = isIP(hostname);
  if (literal !== 0) {
    if (isBlocked(hostname)) throw new SsrfLookupError('ssrf_blocked_address');
    return [{ address: hostname, family: literal === 4 ? 4 : 6 }];
  }
  let answers: readonly ResolvedAddress[];
  try {
    answers = await (options.resolver ?? systemResolver)(hostname);
  } catch (error) {
    if (error instanceof SsrfLookupError) throw error;
    throw new SsrfLookupError('ssrf_dns_failed');
  }
  if (answers.length === 0) throw new SsrfLookupError('ssrf_no_address');
  if (answers.some((a) => isBlocked(a.address))) throw new SsrfLookupError('ssrf_blocked_address');
  return answers.map((a) => ({ address: a.address, family: a.family }));
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function wantedFamily(options: LookupOptions): 4 | 6 | null {
  const family: unknown = options.family;
  if (family === 4 || family === 'IPv4') return 4;
  if (family === 6 || family === 'IPv6') return 6;
  return null;
}

/**
 * A `net.connect`/`tls.connect` `lookup` that answers only with vetted addresses. Handles both
 * forms Node uses (`all: true` with autoSelectFamily, and a single answer).
 */
export function createGuardedLookup(options: GuardOptions = {}) {
  return (hostname: string, lookupOptions: LookupOptions, callback: LookupCallback): void => {
    resolveVetted(hostname, options).then(
      (answers) => {
        const family = wantedFamily(lookupOptions);
        const usable = family === null ? answers : answers.filter((a) => a.family === family);
        const first = usable[0];
        if (first === undefined) {
          callback(new SsrfLookupError('ssrf_no_address'), '', 0);
          return;
        }
        if (lookupOptions.all === true) callback(null, usable.map((a) => ({ address: a.address, family: a.family })));
        else callback(null, first.address, first.family);
      },
      (error: unknown) => callback(error instanceof SsrfLookupError ? error : new SsrfLookupError('ssrf_dns_failed'), '', 0),
    );
  };
}

export interface SsrfAgentOptions extends GuardOptions {
  /** TCP + TLS connect timeout; default 10 s (the per-page budget bounds it further). */
  connectTimeoutMs?: number | undefined;
}

/** The undici connector behind the guarded Agent (exported for the connect-level tests). */
export function createGuardedConnector(options: SsrfAgentOptions = {}): buildConnector.connector {
  return buildConnector({ lookup: createGuardedLookup(options), timeout: options.connectTimeoutMs ?? 10_000 });
}

/**
 * The Agent every crawl request goes through: robots.txt, each page and each redirect hop. One
 * connection at a time per origin, no HTTP/2, no pipelining; the per-page AbortSignal and the
 * caller's byte limit bound everything else.
 */
export function createSsrfAgent(options: SsrfAgentOptions = {}): Agent {
  return new Agent({
    connect: createGuardedConnector(options),
    connections: 4,
    pipelining: 1,
    allowH2: false,
    headersTimeout: 10_000,
    bodyTimeout: 10_000,
    maxHeaderSize: 32 * 1024,
  });
}

/** True when `error` (or any error in its `cause` chain) is the guard refusing an address. */
export function isSsrfRefusal(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    if (current instanceof SsrfLookupError) return current.code === 'ssrf_blocked_address';
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}
