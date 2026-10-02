import 'server-only';
import { createHash, createHmac } from 'node:crypto';

// Builds webhook deliveries the way HubSpot signs them (HS-WH-SIG-V3-ALGO, HS-WH-SIG-V3-URI,
// HS-WH-PAYLOAD), so the real verifier and handler can be tested end to end on fakes.

/** The only percent-encodings HubSpot decodes in the URI before signing; everything else stays encoded. */
const SIGNED_URI_DECODES: Readonly<Record<string, string>> = {
  '3A': ':',
  '2F': '/',
  '3F': '?',
  '40': '@',
  '21': '!',
  '24': '$',
  '27': "'",
  '28': '(',
  '29': ')',
  '2A': '*',
  '2C': ',',
  '3B': ';',
};
const SIGNED_URI_PATTERN = /%(3A|2F|3F|40|21|24|27|28|29|2A|2C|3B)/gi;

/** The `requestUri` HubSpot signs: the full URL with the 12-entry decode table applied (one pass). */
export function hubSpotSignedUri(uri: string): string {
  return uri.replace(SIGNED_URI_PATTERN, (_match, hex: string) => SIGNED_URI_DECODES[hex.toUpperCase()] ?? _match);
}

export interface SignV3Input {
  clientSecret: string;
  method: string;
  /** The URL HubSpot called, as configured; decoded with `hubSpotSignedUri` before signing. */
  uri: string;
  /** The exact raw body. */
  body: string;
  /** The exact `X-HubSpot-Request-Timestamp` header value (epoch ms). */
  timestamp: string;
}

/** `X-HubSpot-Signature-v3`: base64(HMAC-SHA256(clientSecret, method + signedUri + body + timestamp)), UTF-8. */
export function signHubSpotV3(input: SignV3Input): string {
  return createHmac('sha256', Buffer.from(input.clientSecret, 'utf8'))
    .update(Buffer.from(`${input.method}${hubSpotSignedUri(input.uri)}${input.body}${input.timestamp}`, 'utf8'))
    .digest('base64');
}

/** The legacy v1 `X-HubSpot-Signature` HubSpot still sends alongside v3: hex(SHA-256(clientSecret + body)). */
export function signHubSpotV1(clientSecret: string, body: string): string {
  return createHash('sha256').update(Buffer.from(`${clientSecret}${body}`, 'utf8')).digest('hex');
}

export const WEBHOOK_SUBSCRIPTION_TYPES = ['object.creation', 'contact.creation', 'contact.privacyDeletion'] as const;
export type WebhookSubscriptionType = (typeof WEBHOOK_SUBSCRIPTION_TYPES)[number];

/** One event to deliver. Defaults come from the fake portal; overrides exist for replay and mismatch tests. */
export interface FakeWebhookEvent {
  subscriptionType: WebhookSubscriptionType;
  /** The contact id. */
  objectId: string;
  /** Defaults to the fake clock's now. */
  occurredAt?: Date | undefined;
  /** Defaults to the next id from the portal's counter; pass the same id to replay a delivery. */
  eventId?: number | undefined;
  /** 0 on the first delivery, then 1, 2, … on HubSpot's retries. */
  attemptNumber?: number | undefined;
  /** Defaults to `FORM` for creations; absent for privacy deletions (payload not captured, HS-WH-GDPR-PRIVACY-DELETION). */
  changeSource?: string | undefined;
  portalId?: string | undefined;
  appId?: string | undefined;
  subscriptionId?: number | undefined;
}

export interface SignedWebhookOptions {
  /** Defaults to the fake's client secret. */
  clientSecret?: string | undefined;
  /** Defaults to POST. */
  method?: string | undefined;
  /** The webhook target URL HubSpot calls (`HUBSPOT_WEBHOOK_TARGET_URL`). */
  uri: string;
  /** Defaults to the fake clock's now: HubSpot signs each delivery attempt afresh. */
  timestampMs?: number | undefined;
}

export interface SignedWebhook {
  /** The raw body: a JSON array, no whitespace. */
  body: string;
  headers: Record<string, string>;
}

/** Fixed per subscription type, as a HubSpot app's subscriptions would be. */
export const WEBHOOK_SUBSCRIPTION_IDS: Readonly<Record<WebhookSubscriptionType, number>> = {
  'object.creation': 5100001,
  'contact.privacyDeletion': 5100002,
  'contact.creation': 5100003,
};

function wireNumber(id: string): number {
  if (!/^\d{1,15}$/.test(id)) throw new Error('fake_hubspot_webhook: ids must be digit strings below 2^53');
  return Number(id);
}

export interface ResolvedWebhookEvent extends FakeWebhookEvent {
  occurredAt: Date;
  eventId: number;
  portalId: string;
  appId: string;
}

/** The wire object for one event, with HubSpot's field order (HS-WH-PAYLOAD). */
export function webhookEventBody(event: ResolvedWebhookEvent): Record<string, unknown> {
  const isCreation = event.subscriptionType !== 'contact.privacyDeletion';
  const body: Record<string, unknown> = {
    eventId: event.eventId,
    subscriptionId: event.subscriptionId ?? WEBHOOK_SUBSCRIPTION_IDS[event.subscriptionType],
    portalId: wireNumber(event.portalId),
    appId: wireNumber(event.appId),
    occurredAt: event.occurredAt.getTime(),
    subscriptionType: event.subscriptionType,
    attemptNumber: event.attemptNumber ?? 0,
    objectId: wireNumber(event.objectId),
  };
  if (event.subscriptionType === 'object.creation') body.objectTypeId = '0-1';
  if (isCreation) body.changeFlag = 'NEW';
  const changeSource = event.changeSource ?? (isCreation ? 'FORM' : undefined);
  if (changeSource !== undefined) body.changeSource = changeSource;
  return body;
}

/** Serialises and signs a batch exactly as HubSpot delivers it (≤ 100 events). */
export function buildSignedWebhook(
  events: readonly ResolvedWebhookEvent[],
  options: { clientSecret: string; method: string; uri: string; timestampMs: number },
): SignedWebhook {
  if (events.length > 100) throw new Error('fake_hubspot_webhook: HubSpot sends at most 100 events per request');
  if (!Number.isSafeInteger(options.timestampMs) || options.timestampMs < 0) {
    throw new Error('fake_hubspot_webhook: timestampMs must be epoch milliseconds');
  }
  const body = JSON.stringify(events.map(webhookEventBody));
  const timestamp = String(options.timestampMs);
  return {
    body,
    headers: {
      'Content-Type': 'application/json',
      'X-HubSpot-Signature-v3': signHubSpotV3({ clientSecret: options.clientSecret, method: options.method, uri: options.uri, body, timestamp }),
      'X-HubSpot-Request-Timestamp': timestamp,
      'X-HubSpot-Signature': signHubSpotV1(options.clientSecret, body),
      'X-HubSpot-Signature-Version': 'v1',
    },
  };
}
