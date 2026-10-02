import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../clock';
import { FakeHubSpot } from './fake-hubspot';
import { hubSpotSignedUri, signHubSpotV1, signHubSpotV3 } from './webhook';

// Known-answer vectors, verbatim from docs/research/03-hubspot-webhooks.md §03.2 (HS-WH-SIG-V3-VECTORS).
const VECTORS = [
  {
    id: 'HS-V3-PY-SDK',
    clientSecret: 'yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy',
    uri: 'https://www.example.com/webhook_uri',
    body: "{'example_field':'example_value'}",
    timestamp: '1693657560000',
    expected: 'K36dawei4A+QBNolUOqo7s91KQDWQ5MXZ/QufNYuk/Y=',
  },
  {
    id: 'HS-V3-RB-SDK',
    clientSecret: 'yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy',
    uri: 'https://www.example.com/webhook_uri',
    body: "{'example_field':'example_value'}",
    timestamp: '1700000300000',
    expected: 'RnbPH7+UMKVkbV32P8bz450N4M56aPmcru1+D3kSDtw=',
  },
  {
    id: 'HS-V3-AUTOPILOT-1',
    clientSecret: 'autopilot-test-client-secret-0001',
    uri: 'https://example.com/api/hubspot/webhooks',
    body: '[{"eventId":4100000001,"subscriptionId":5100001,"portalId":12345678,"appId":7100001,"occurredAt":1790000000000,"subscriptionType":"contact.creation","attemptNumber":0,"objectId":901,"changeFlag":"NEW","changeSource":"FORM"},{"eventId":4100000002,"subscriptionId":5100001,"portalId":12345678,"appId":7100001,"occurredAt":1790000000500,"subscriptionType":"contact.creation","attemptNumber":0,"objectId":902,"changeFlag":"NEW","changeSource":"CRM_UI"}]',
    timestamp: '1790000001000',
    expected: 'vc6X4JO1KMElXem9r7vSovD2GajkBW8j6R1JB/N89Rk=',
  },
  {
    id: 'HS-V3-AUTOPILOT-2-UTF8',
    clientSecret: 'autopilot-test-client-secret-0001',
    uri: 'https://example.com/api/hubspot/webhooks',
    body: '[{"appId":7100001,"eventId":4100000003,"subscriptionId":5100002,"portalId":12345678,"occurredAt":1790000002000,"subscriptionType":"object.creation","attemptNumber":1,"objectId":903,"objectTypeId":"0-1","changeSource":"FORM","note":"Zoë — café ☕"}]',
    timestamp: '1790000003000',
    expected: 'iwUOcQxOJMXtoVai85f7uLyYuAp58oXpeyP5gPQKS2k=',
  },
  {
    id: 'HS-V3-AUTOPILOT-3-QUERY',
    clientSecret: 'autopilot-test-client-secret-0001',
    // The raw request URI: the signer must apply HubSpot's decode table itself.
    uri: 'https://example.com/api/hubspot/webhooks?src=hs%3Aapp%2Fv3&x=%28a%29',
    body: '[]',
    timestamp: '1790000004000',
    expected: 'G8ddQlikFQ0ScZOZn+MHQ0E3WCV7vOJTzKlvrkvbvuk=',
  },
] as const;

const BODY_BYTES = { 'HS-V3-PY-SDK': 33, 'HS-V3-RB-SDK': 33, 'HS-V3-AUTOPILOT-1': 449, 'HS-V3-AUTOPILOT-2-UTF8': 253, 'HS-V3-AUTOPILOT-3-QUERY': 2 };

/** An independent v3 computation over an already-decoded URI (no code shared with the signer). */
function independentV3(secret: string, method: string, signedUri: string, body: string, timestamp: string): string {
  return createHmac('sha256', secret).update(method + signedUri + body + timestamp, 'utf8').digest('base64');
}

const TARGET = 'https://autopilot.example/api/hubspot/webhooks';

describe('HubSpot v3 signing', () => {
  it.each(VECTORS)('reproduces $id', (vector) => {
    expect(Buffer.byteLength(vector.body, 'utf8')).toBe(BODY_BYTES[vector.id]);
    const signature = signHubSpotV3({
      clientSecret: vector.clientSecret,
      method: 'POST',
      uri: vector.uri,
      body: vector.body,
      timestamp: vector.timestamp,
    });
    expect(signature).toBe(vector.expected);
    expect(signature).toHaveLength(44);
  });

  it('signs the decoded URI, not the raw one (HS-V3-AUTOPILOT-3-QUERY negative)', () => {
    const raw = 'https://example.com/api/hubspot/webhooks?src=hs%3Aapp%2Fv3&x=%28a%29';
    expect(hubSpotSignedUri(raw)).toBe('https://example.com/api/hubspot/webhooks?src=hs:app/v3&x=(a)');
    const overRaw = independentV3('autopilot-test-client-secret-0001', 'POST', raw, '[]', '1790000004000');
    expect(overRaw).toBe('KKwrtu49d26FrUsDQdYcfAcwFssKn+cmyppOAUwOO/Q=');
    expect(signHubSpotV3({ clientSecret: 'autopilot-test-client-secret-0001', method: 'POST', uri: raw, body: '[]', timestamp: '1790000004000' })).not.toBe(overRaw);
  });

  it('decodes only the twelve listed escapes, case-insensitively, in one pass', () => {
    expect(hubSpotSignedUri('https://x.example/a%3a%2f%3F%40%21%24%27%28%29%2A%2C%3B')).toBe("https://x.example/a:/?@!$'()*,;");
    expect(hubSpotSignedUri('https://x.example/a%20b%26c%3Dd%25')).toBe('https://x.example/a%20b%26c%3Dd%25');
    expect(hubSpotSignedUri('https://x.example/%253A')).toBe('https://x.example/%253A');
  });

  it('computes the legacy v1 signature HubSpot also sends', () => {
    const body =
      '[{"eventId":1,"subscriptionId":12345,"portalId":62515,"occurredAt":1564113600000,"subscriptionType":"contact.creation","attemptNumber":0,"objectId":123,"changeSource":"CRM","changeFlag":"NEW","appId":54321}]';
    expect(signHubSpotV1('yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy', body)).toBe(
      '232db2615f3d666fe21a8ec971ac7b5402d33b9a925784df3ca654d05f4817de',
    );
  });
});

describe('FakeHubSpot.signedWebhook', () => {
  let clock: FakeClock;
  let hubspot: FakeHubSpot;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    clock = new FakeClock(new Date('2026-10-06T14:00:00.000Z'));
    hubspot = new FakeHubSpot({ clock, clientSecret: 'autopilot-test-client-secret-0001' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers object.creation and contact.privacyDeletion events that verify with an independent HMAC', () => {
    const occurredAt = new Date('2026-10-06T13:59:58.000Z');
    const { body, headers } = hubspot.signedWebhook(
      [
        { subscriptionType: 'object.creation', objectId: '1001', occurredAt },
        { subscriptionType: 'contact.privacyDeletion', objectId: '101', occurredAt },
      ],
      { uri: TARGET },
    );

    const timestamp = headers['X-HubSpot-Request-Timestamp'];
    expect(timestamp).toBe(String(Date.parse('2026-10-06T14:00:00.000Z')));
    expect(headers['X-HubSpot-Signature-v3']).toBe(
      independentV3('autopilot-test-client-secret-0001', 'POST', TARGET, body, timestamp ?? ''),
    );
    expect(headers['X-HubSpot-Signature']).toBe(
      createHash('sha256').update(`autopilot-test-client-secret-0001${body}`, 'utf8').digest('hex'),
    );
    expect(headers['Content-Type']).toBe('application/json');

    expect(JSON.parse(body)).toEqual([
      {
        eventId: 4100000001,
        subscriptionId: 5100001,
        portalId: 1234567,
        appId: 7100001,
        occurredAt: occurredAt.getTime(),
        subscriptionType: 'object.creation',
        attemptNumber: 0,
        objectId: 1001,
        objectTypeId: '0-1',
        changeFlag: 'NEW',
        changeSource: 'FORM',
      },
      {
        eventId: 4100000002,
        subscriptionId: 5100002,
        portalId: 1234567,
        appId: 7100001,
        occurredAt: occurredAt.getTime(),
        subscriptionType: 'contact.privacyDeletion',
        attemptNumber: 0,
        objectId: 101,
      },
    ]);
    // Raw JSON with no whitespace, field order as HubSpot sends it.
    expect(body.startsWith('[{"eventId":4100000001,"subscriptionId":5100001,"portalId":1234567,"appId":7100001,')).toBe(true);
  });

  it('signs with the given secret, method, URI and timestamp, decoding the URI like HubSpot', () => {
    const uri = 'https://autopilot.example/api/hubspot/webhooks?src=hs%3Aapp';
    const { body, headers } = hubspot.signedWebhook([{ subscriptionType: 'contact.creation', objectId: '902' }], {
      clientSecret: 'another-secret',
      method: 'POST',
      uri,
      timestampMs: 1790000001000,
    });
    expect(headers['X-HubSpot-Request-Timestamp']).toBe('1790000001000');
    expect(headers['X-HubSpot-Signature-v3']).toBe(
      independentV3('another-secret', 'POST', 'https://autopilot.example/api/hubspot/webhooks?src=hs:app', body, '1790000001000'),
    );
    expect(headers['X-HubSpot-Signature-v3']).not.toBe(independentV3('another-secret', 'POST', uri, body, '1790000001000'));
  });

  it('replays a delivery with the same eventId and a higher attemptNumber, freshly signed', () => {
    const event = { subscriptionType: 'object.creation', objectId: '1001', eventId: 4200000000, occurredAt: clock.now() } as const;
    const first = hubspot.signedWebhook([event], { uri: TARGET });
    clock.advance({ minutes: 1 });
    const retry = hubspot.signedWebhook([{ ...event, attemptNumber: 1 }], { uri: TARGET });
    const [a] = JSON.parse(first.body) as [{ eventId: number; attemptNumber: number }];
    const [b] = JSON.parse(retry.body) as [{ eventId: number; attemptNumber: number }];
    expect([a.eventId, a.attemptNumber]).toEqual([4200000000, 0]);
    expect([b.eventId, b.attemptNumber]).toEqual([4200000000, 1]);
    expect(retry.headers['X-HubSpot-Request-Timestamp']).not.toBe(first.headers['X-HubSpot-Request-Timestamp']);
  });

  it('lets a test forge a foreign appId or portalId', () => {
    const { body } = hubspot.signedWebhook([{ subscriptionType: 'object.creation', objectId: '5', appId: '999', portalId: '42' }], {
      uri: TARGET,
    });
    expect(JSON.parse(body)).toMatchObject([{ appId: 999, portalId: 42 }]);
  });

  it('refuses more than 100 events and non-numeric ids', () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ subscriptionType: 'object.creation' as const, objectId: String(i + 1) }));
    expect(() => hubspot.signedWebhook(many, { uri: TARGET })).toThrow(/at most 100/);
    expect(() => hubspot.signedWebhook([{ subscriptionType: 'object.creation', objectId: 'abc' }], { uri: TARGET })).toThrow();
  });
});
