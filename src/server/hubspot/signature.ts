import 'server-only';
import { createHmac } from 'node:crypto';
import { timingSafeEqualString } from '@/server/security/keys';

// HubSpot webhook signature v3 (HS-WH-SIG-V3-ALGO, HS-WH-SIG-V3-URI, HS-WH-SIG-V3-SDK-PITFALLS,
// 03.1 V2; PLAN §10.1):
//   X-HubSpot-Signature-v3 = base64(HMAC-SHA256(clientSecret, UTF-8(method + uri + rawBody + timestamp)))
// - `uri` is the full URL HubSpot called: pass the configured HUBSPOT_WEBHOOK_TARGET_URL, never a URL
//   rebuilt from request headers. HubSpot decodes 12 percent-encodings before signing; so do we.
// - `rawBody` is the exact request text, read before any JSON parsing.
// - `timestamp` is the X-HubSpot-Request-Timestamp header: 13 digits (epoch ms), within ±300 000 ms of
//   now (HubSpot says "older than 5 minutes"; the future bound is our hardening).
// - The client secret signs, so during a rotation both the current and the previous one verify.
// - Comparison is constant-time; the legacy v1/v2 headers are ignored (HS-WH-SIG-V1-V2).
// Our own verifier, because the official SDK's defaults to v1, throws, compares in non-constant time
// and skips the age check for a non-numeric timestamp.

/** HubSpot rejects requests older than 5 minutes; we also reject ones more than 5 minutes ahead. */
export const HUBSPOT_SIGNATURE_MAX_SKEW_MS = 300_000;

const TIMESTAMP_PATTERN = /^\d{13}$/;

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

/** The `requestUri` HubSpot signs: the URL with the 12-entry decode table applied, in one pass. */
export function hubSpotSignedUri(uri: string): string {
  return uri.replace(SIGNED_URI_PATTERN, (match, hex: string) => SIGNED_URI_DECODES[hex.toUpperCase()] ?? match);
}

/** The expected `X-HubSpot-Signature-v3` value for one secret. */
export function computeHubSpotSignatureV3(input: {
  secret: string;
  method: string;
  uri: string;
  rawBody: string;
  timestamp: string;
}): string {
  return createHmac('sha256', Buffer.from(input.secret, 'utf8'))
    .update(Buffer.from(`${input.method}${hubSpotSignedUri(input.uri)}${input.rawBody}${input.timestamp}`, 'utf8'))
    .digest('base64');
}

export interface VerifyHubSpotSignatureInput {
  /** The request method as received (`POST`). */
  method: string;
  /** HUBSPOT_WEBHOOK_TARGET_URL. */
  uri: string;
  rawBody: string;
  /** The X-HubSpot-Request-Timestamp header; null or undefined when absent. */
  timestamp: string | null | undefined;
  /** The X-HubSpot-Signature-v3 header; null or undefined when absent. */
  signature: string | null | undefined;
  /** [HUBSPOT_CLIENT_SECRET, HUBSPOT_CLIENT_SECRET_PREVIOUS?]; empty or missing entries are skipped. */
  secrets: readonly (string | null | undefined)[];
  /** `clock.now().getTime()`. */
  nowMs: number;
}

/** Why a delivery was refused: codes safe to log. */
export type HubSpotSignatureFailure = 'missing_header' | 'bad_timestamp' | 'stale_timestamp' | 'bad_signature' | 'no_secret';

export type HubSpotSignatureResult =
  | { ok: true; /** Which secret matched (a rotation is complete once `previous` stops matching). */ secret: 'current' | 'previous' }
  | { ok: false; reason: HubSpotSignatureFailure };

export function verifyHubSpotSignatureV3(input: VerifyHubSpotSignatureInput): HubSpotSignatureResult {
  const { timestamp, signature } = input;
  if (timestamp === null || timestamp === undefined || signature === null || signature === undefined || signature === '') {
    return { ok: false, reason: 'missing_header' };
  }
  if (!TIMESTAMP_PATTERN.test(timestamp) || !Number.isFinite(input.nowMs)) return { ok: false, reason: 'bad_timestamp' };
  if (Math.abs(input.nowMs - Number(timestamp)) > HUBSPOT_SIGNATURE_MAX_SKEW_MS) return { ok: false, reason: 'stale_timestamp' };

  const candidates = input.secrets
    .map((secret, index) => ({ secret, which: index === 0 ? ('current' as const) : ('previous' as const) }))
    .filter((c): c is { secret: string; which: 'current' | 'previous' } => typeof c.secret === 'string' && c.secret.length > 0);
  if (candidates.length === 0) return { ok: false, reason: 'no_secret' };

  // Every candidate is compared, so timing does not reveal which secret (if any) matched.
  let matched: 'current' | 'previous' | null = null;
  for (const { secret, which } of candidates) {
    const expected = computeHubSpotSignatureV3({ secret, method: input.method, uri: input.uri, rawBody: input.rawBody, timestamp });
    if (timingSafeEqualString(expected, signature) && matched === null) matched = which;
  }
  return matched === null ? { ok: false, reason: 'bad_signature' } : { ok: true, secret: matched };
}
