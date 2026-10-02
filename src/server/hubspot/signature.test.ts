import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FAKE_HUBSPOT_CLIENT_SECRET, FakeHubSpot } from '@/server/adapters/fake/hubspot';
import { FakeClock } from '@/server/adapters/fake/clock';
import {
  HUBSPOT_SIGNATURE_MAX_SKEW_MS,
  computeHubSpotSignatureV3,
  hubSpotSignedUri,
  verifyHubSpotSignatureV3,
  type VerifyHubSpotSignatureInput,
} from './signature';

// HS-WH-SIG-V3-VECTORS: the five research vectors (two published in HubSpot's official SDK tests,
// three generated for Autopilot and reproduced with the official code), plus the negatives listed in
// HS-WH-SIG-V3-SDK-PITFALLS and the 300000/300001 boundary from 03.1 V2.

const vectorSchema = z.object({
  id: z.string(),
  clientSecret: z.string(),
  method: z.string(),
  rawRequestUri: z.string().optional(),
  signedUri: z.string(),
  body: z.string(),
  bodyUtf8Bytes: z.number(),
  timestampHeader: z.string(),
  expectedSignatureV3: z.string(),
  signatureOverUndecodedUri: z.string().optional(),
});
const fixture = z
  .object({ maxSkewMs: z.number(), vectors: z.array(vectorSchema).length(5) })
  .parse(JSON.parse(readFileSync(path.join(process.cwd(), 'test/fixtures/hubspot-signature-v3.json'), 'utf8')));
type Vector = z.infer<typeof vectorSchema>;

function vector(id: string): Vector {
  const found = fixture.vectors.find((v) => v.id === id);
  if (found === undefined) throw new Error(`missing vector ${id}`);
  return found;
}

/** The verifier input for a vector, as the webhook route would build it, one second after signing. */
function inputFor(v: Vector, overrides: Partial<VerifyHubSpotSignatureInput> = {}): VerifyHubSpotSignatureInput {
  return {
    method: v.method,
    uri: v.rawRequestUri ?? v.signedUri,
    rawBody: v.body,
    timestamp: v.timestampHeader,
    signature: v.expectedSignatureV3,
    secrets: [v.clientSecret],
    nowMs: Number(v.timestampHeader) + 1000,
    ...overrides,
  };
}

describe('the vectors fixture', () => {
  it('holds exact body strings', () => {
    expect(fixture.maxSkewMs).toBe(HUBSPOT_SIGNATURE_MAX_SKEW_MS);
    for (const v of fixture.vectors) expect(Buffer.byteLength(v.body, 'utf8'), v.id).toBe(v.bodyUtf8Bytes);
  });
});

describe('computeHubSpotSignatureV3', () => {
  it.each(fixture.vectors.map((v) => [v.id, v] as const))('reproduces %s', (_id, v) => {
    expect(
      computeHubSpotSignatureV3({ secret: v.clientSecret, method: v.method, uri: v.signedUri, rawBody: v.body, timestamp: v.timestampHeader }),
    ).toBe(v.expectedSignatureV3);
  });
});

describe('hubSpotSignedUri', () => {
  it('decodes only the 12 documented percent-encodings, in either case', () => {
    expect(hubSpotSignedUri('https://example.com/a?src=hs%3Aapp%2Fv3&x=%28a%29')).toBe('https://example.com/a?src=hs:app/v3&x=(a)');
    expect(hubSpotSignedUri('%3a%2f%3f%40%21%24%27%28%29%2a%2c%3b')).toBe(":/?@!$'()*,;");
    expect(hubSpotSignedUri('a%20b%26c%3Dd%25')).toBe('a%20b%26c%3Dd%25');
  });

  it('decodes in one pass', () => {
    expect(hubSpotSignedUri('%253A')).toBe('%253A');
  });
});

describe('verifyHubSpotSignatureV3', () => {
  it.each(fixture.vectors.map((v) => [v.id, v] as const))('accepts %s', (_id, v) => {
    expect(verifyHubSpotSignatureV3(inputFor(v))).toEqual({ ok: true, secret: 'current' });
  });

  it('accepts the query vector against the raw URI HubSpot called (decoded before signing)', () => {
    const v = vector('HS-V3-AUTOPILOT-3-QUERY');
    expect(v.rawRequestUri).toBeDefined();
    expect(verifyHubSpotSignatureV3(inputFor(v, { uri: v.rawRequestUri ?? '' }))).toEqual({ ok: true, secret: 'current' });
    expect(verifyHubSpotSignatureV3(inputFor(v, { uri: v.signedUri }))).toEqual({ ok: true, secret: 'current' });
  });

  it('rejects a signature computed over the undecoded URI', () => {
    const v = vector('HS-V3-AUTOPILOT-3-QUERY');
    expect(v.signatureOverUndecodedUri).toBeDefined();
    expect(verifyHubSpotSignatureV3(inputFor(v, { signature: v.signatureOverUndecodedUri ?? '' }))).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  describe('negatives (HS-V3-AUTOPILOT-1)', () => {
    const v = vector('HS-V3-AUTOPILOT-1');
    const ts = Number(v.timestampHeader);

    it.each<[string, Partial<VerifyHubSpotSignatureInput>]>([
      ['a tampered body', { rawBody: v.body.replace('"objectId":901', '"objectId":904') }],
      ['a body with one extra byte', { rawBody: `${v.body} ` }],
      ['a re-serialised body', { rawBody: JSON.stringify(JSON.parse(v.body), null, 1) }],
      ['the timestamp + 1 ms', { timestamp: String(ts + 1), nowMs: ts + 1000 }],
      ['the wrong secret', { secrets: ['autopilot-test-client-secret-0002'] }],
      ['GET instead of POST', { method: 'GET' }],
      ['lower-case post', { method: 'post' }],
      ['http:// instead of https://', { uri: v.signedUri.replace('https://', 'http://') }],
      ['a trailing slash', { uri: `${v.signedUri}/` }],
      ['another host', { uri: v.signedUri.replace('example.com', 'www.example.com') }],
      ['a signature with a trailing newline', { signature: `${v.expectedSignatureV3}\n` }],
      ['a base64url signature', { signature: v.expectedSignatureV3.replaceAll('+', '-').replaceAll('/', '_') }],
      ['an unpadded signature', { signature: v.expectedSignatureV3.replace(/=+$/, '') }],
      ['the hex digest', { signature: Buffer.from(v.expectedSignatureV3, 'base64').toString('hex') }],
    ])('rejects %s', (_name, overrides) => {
      expect(verifyHubSpotSignatureV3(inputFor(v, overrides))).toEqual({ ok: false, reason: 'bad_signature' });
    });

    it('accepts exactly 300 000 ms after the timestamp and rejects 300 001 ms', () => {
      expect(verifyHubSpotSignatureV3(inputFor(v, { nowMs: ts + 300_000 })).ok).toBe(true);
      expect(verifyHubSpotSignatureV3(inputFor(v, { nowMs: ts + 300_001 }))).toEqual({ ok: false, reason: 'stale_timestamp' });
    });

    it('accepts exactly 300 000 ms before the timestamp and rejects a timestamp further in the future', () => {
      expect(verifyHubSpotSignatureV3(inputFor(v, { nowMs: ts - 300_000 })).ok).toBe(true);
      expect(verifyHubSpotSignatureV3(inputFor(v, { nowMs: ts - 300_001 }))).toEqual({ ok: false, reason: 'stale_timestamp' });
      expect(verifyHubSpotSignatureV3(inputFor(v, { nowMs: ts - 600_000 }))).toEqual({ ok: false, reason: 'stale_timestamp' });
    });

    it.each<[string, Partial<VerifyHubSpotSignatureInput>]>([
      ['no timestamp header', { timestamp: undefined }],
      ['a null timestamp header', { timestamp: null }],
      ['no signature header', { signature: undefined }],
      ['a null signature header', { signature: null }],
      ['an empty signature header', { signature: '' }],
    ])('rejects %s', (_name, overrides) => {
      expect(verifyHubSpotSignatureV3(inputFor(v, overrides))).toEqual({ ok: false, reason: 'missing_header' });
    });

    it.each(['abc', '', '1790000001000.0', '179000000100', '17900000010000', ' 1790000001000', '1790000001000 ', '-179000000100', '1.79e12'])(
      'rejects the timestamp %j before computing anything',
      (timestamp) => {
        expect(verifyHubSpotSignatureV3(inputFor(v, { timestamp }))).toEqual({ ok: false, reason: 'bad_timestamp' });
      },
    );

    it('rejects a timestamp signed consistently but not digits (the SDK NaN bypass)', () => {
      const signature = computeHubSpotSignatureV3({ secret: v.clientSecret, method: 'POST', uri: v.signedUri, rawBody: v.body, timestamp: 'abc' });
      expect(verifyHubSpotSignatureV3(inputFor(v, { timestamp: 'abc', signature }))).toEqual({ ok: false, reason: 'bad_timestamp' });
    });

    it('rejects a non-finite now', () => {
      expect(verifyHubSpotSignatureV3(inputFor(v, { nowMs: Number.NaN }))).toEqual({ ok: false, reason: 'bad_timestamp' });
    });

    it('refuses to verify without a secret', () => {
      expect(verifyHubSpotSignatureV3(inputFor(v, { secrets: [] }))).toEqual({ ok: false, reason: 'no_secret' });
      expect(verifyHubSpotSignatureV3(inputFor(v, { secrets: ['', undefined, null] }))).toEqual({ ok: false, reason: 'no_secret' });
    });

    it('accepts the previous secret during a rotation and says so', () => {
      expect(verifyHubSpotSignatureV3(inputFor(v, { secrets: ['rotated-secret-0002', v.clientSecret] }))).toEqual({
        ok: true,
        secret: 'previous',
      });
      expect(verifyHubSpotSignatureV3(inputFor(v, { secrets: [v.clientSecret, 'rotated-secret-0002'] }))).toEqual({
        ok: true,
        secret: 'current',
      });
      expect(verifyHubSpotSignatureV3(inputFor(v, { secrets: [undefined, v.clientSecret] }))).toEqual({ ok: true, secret: 'previous' });
    });
  });
});

describe('round trip with FakeHubSpot.signedWebhook', () => {
  const TARGET = 'http://localhost:3000/api/hubspot/webhooks';

  function setup(): { clock: FakeClock; hubspot: FakeHubSpot } {
    const clock = new FakeClock(new Date('2026-10-06T14:00:00.000Z'));
    return { clock, hubspot: new FakeHubSpot({ clock }) };
  }

  function verify(delivery: { body: string; headers: Record<string, string> }, nowMs: number, secrets: readonly string[]) {
    return verifyHubSpotSignatureV3({
      method: 'POST',
      uri: TARGET,
      rawBody: delivery.body,
      timestamp: delivery.headers['X-HubSpot-Request-Timestamp'],
      signature: delivery.headers['X-HubSpot-Signature-v3'],
      secrets,
      nowMs,
    });
  }

  it('verifies a fake delivery signed with the fake client secret', () => {
    const { clock, hubspot } = setup();
    const delivery = hubspot.signedWebhook(
      [
        { subscriptionType: 'object.creation', objectId: '1001' },
        { subscriptionType: 'contact.privacyDeletion', objectId: '101' },
      ],
      { uri: TARGET },
    );
    expect(verify(delivery, clock.nowMs(), [FAKE_HUBSPOT_CLIENT_SECRET])).toEqual({ ok: true, secret: 'current' });
  });

  it('rejects the same delivery five minutes and one millisecond later', () => {
    const { clock, hubspot } = setup();
    const delivery = hubspot.signedWebhook([{ subscriptionType: 'object.creation', objectId: '1001' }], { uri: TARGET });
    clock.advance(300_001);
    expect(verify(delivery, clock.nowMs(), [FAKE_HUBSPOT_CLIENT_SECRET])).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('verifies a delivery signed with the previous secret after a rotation', () => {
    const { clock, hubspot } = setup();
    const delivery = hubspot.signedWebhook([{ subscriptionType: 'object.creation', objectId: '1001' }], {
      uri: TARGET,
      clientSecret: 'old-client-secret-0001',
    });
    expect(verify(delivery, clock.nowMs(), [FAKE_HUBSPOT_CLIENT_SECRET])).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verify(delivery, clock.nowMs(), [FAKE_HUBSPOT_CLIENT_SECRET, 'old-client-secret-0001'])).toEqual({ ok: true, secret: 'previous' });
  });

  it('agrees with the fake on the decode table', () => {
    const { clock, hubspot } = setup();
    const uri = 'https://example.com/api/hubspot/webhooks?src=hs%3Aapp%2Fv3';
    const delivery = hubspot.signedWebhook([{ subscriptionType: 'object.creation', objectId: '1001' }], { uri });
    expect(
      verifyHubSpotSignatureV3({
        method: 'POST',
        uri,
        rawBody: delivery.body,
        timestamp: delivery.headers['X-HubSpot-Request-Timestamp'],
        signature: delivery.headers['X-HubSpot-Signature-v3'],
        secrets: [FAKE_HUBSPOT_CLIENT_SECRET],
        nowMs: clock.nowMs(),
      }).ok,
    ).toBe(true);
  });
});
