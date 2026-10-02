import { createHash } from 'node:crypto';
import { Receiver } from '@upstash/qstash';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyQstashRequest } from './qstash';

// QS-SIG-JWT / QS-RECEIVER-API vectors, re-signed at runtime with jose (no JWT literals in the
// source). The clock is pinned through the Date constructor: jose reads `new Date()`, so stubbing
// Date.now alone would leave verification on the real clock (07.y).

const join = (...parts: string[]): string => parts.join('');
const CURRENT_KEY = join('sig_', 'testCurrentKey', '000000000000');
const NEXT_KEY = join('sig_', 'testNextKey', '000000000000000');
const OTHER_KEY = join('sig_', 'someOtherKey', '00000000000000');
/** QStash's public dev-server signing key (QS-DEVMODE-KEY-OVERRIDE): never valid here. */
const DEV_KEY = join('sig_', '7kYjw48mhY7kAjqNGcy6cr29RJ6r');

const URL = 'https://autopilot.hublytix.ai/api/jobs/follow-up';
const BODY = '{"leadId":"123","n":1}';
const IAT = 1_790_000_000;
const EXP = 1_790_000_300;

function bodyHash(body: string, padded = false): string {
  const hash = createHash('sha256').update(body).digest('base64url');
  return padded ? `${hash}=` : hash;
}

async function sign(key: string, options: { body?: string; url?: string; nbf?: number; padded?: boolean } = {}): Promise<string> {
  return new SignJWT({ body: bodyHash(options.body ?? BODY, options.padded) })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('Upstash')
    .setSubject(options.url ?? URL)
    .setIssuedAt(IAT)
    .setNotBefore(options.nbf ?? 0)
    .setExpirationTime(EXP)
    .setJti('jwt_testvector0001')
    .sign(new TextEncoder().encode(key));
}

function request(signature: string | null, body = BODY): Request {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (signature !== null) headers.set('Upstash-Signature', signature);
  return new Request(URL, { method: 'POST', headers, body });
}

const config = { currentSigningKey: CURRENT_KEY, nextSigningKey: NEXT_KEY, url: URL };

function at(unixSeconds: number): void {
  vi.setSystemTime(new Date(unixSeconds * 1000));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(IAT + 10);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('verifyQstashRequest', () => {
  it('accepts a token signed with the current key', async () => {
    expect(await verifyQstashRequest(request(await sign(CURRENT_KEY)), BODY, config)).toEqual({ ok: true });
  });

  it('accepts a token signed with the next key (key roll)', async () => {
    expect(await verifyQstashRequest(request(await sign(NEXT_KEY)), BODY, config)).toEqual({ ok: true });
  });

  it('accepts the production shape: nbf 0 and a padded body claim', async () => {
    expect(await verifyQstashRequest(request(await sign(CURRENT_KEY, { padded: true })), BODY, config)).toEqual({ ok: true });
  });

  it('rejects a token signed with any other key', async () => {
    expect(await verifyQstashRequest(request(await sign(OTHER_KEY)), BODY, config)).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('rejects a token for another URL (sub must equal the configured URL)', async () => {
    const token = await sign(CURRENT_KEY);
    expect(await verifyQstashRequest(request(token), BODY, { ...config, url: `${URL}?x=1` })).toEqual({ ok: false, reason: 'invalid_signature' });
    const forOtherRoute = await sign(CURRENT_KEY, { url: 'https://autopilot.hublytix.ai/api/jobs/failed' });
    expect(await verifyQstashRequest(request(forOtherRoute), BODY, config)).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('rejects an expired token beyond the 5-second tolerance, and accepts one inside it', async () => {
    const token = await sign(CURRENT_KEY);
    at(EXP + 4);
    expect(await verifyQstashRequest(request(token), BODY, config)).toEqual({ ok: true });
    at(EXP + 6);
    expect(await verifyQstashRequest(request(token), BODY, config)).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('rejects a body whose hash does not match, including a re-serialised body', async () => {
    const token = await sign(CURRENT_KEY);
    const other = '{"leadId":"124","n":1}';
    expect(await verifyQstashRequest(request(token, other), other, config)).toEqual({ ok: false, reason: 'invalid_signature' });
    const spaced = '{"leadId": "123", "n": 1}';
    expect(await verifyQstashRequest(request(token, spaced), spaced, config)).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('rejects a request without a signature', async () => {
    expect(await verifyQstashRequest(request(null), BODY, config)).toEqual({ ok: false, reason: 'missing_signature' });
  });

  it('rejects a token signed with the public dev key even when QSTASH_DEV is set', async () => {
    vi.stubEnv('QSTASH_DEV', 'true');
    const token = await sign(DEV_KEY);
    expect(await verifyQstashRequest(request(token), BODY, config)).toEqual({ ok: false, reason: 'invalid_signature' });
    // And a real key still verifies: devMode false ignores QSTASH_DEV entirely.
    expect(await verifyQstashRequest(request(await sign(CURRENT_KEY)), BODY, config)).toEqual({ ok: true });
  });

  it('guards a real hazard: without devMode false the SDK accepts the dev-key token under QSTASH_DEV', async () => {
    vi.stubEnv('QSTASH_DEV', 'true');
    vi.stubEnv('NODE_ENV', 'production');
    const receiver = new Receiver({ currentSigningKey: CURRENT_KEY, nextSigningKey: NEXT_KEY });
    expect(await receiver.verify({ signature: await sign(DEV_KEY), body: BODY, url: URL, clockTolerance: 5 })).toBe(true);
  });

  it('refuses to verify with an empty key', async () => {
    const token = await sign(CURRENT_KEY);
    expect(await verifyQstashRequest(request(token), BODY, { ...config, nextSigningKey: '' })).toEqual({ ok: false, reason: 'invalid_signature' });
  });
});
