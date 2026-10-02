import 'server-only';
import { createHmac } from 'node:crypto';
import { timingSafeEqualBytes } from './keys';

// Razorpay webhook signature (RZP-WH-SIGNATURE, RZP-WH-TEST-VECTORS, PLAN §10.1, D-19):
//   X-Razorpay-Signature = lowercase hex HMAC-SHA256(webhook secret, raw request body bytes)
// - the key is the WEBHOOK secret (RAZORPAY_WEBHOOK_SECRET), never the API key secret;
// - the message is the raw body exactly as received: verify before any JSON parsing;
// - the header must be exactly 64 lowercase hex characters (Razorpay sends lowercase; uppercase is
//   refused, as the official helper refuses it);
// - comparison is constant-time (the SDK helper uses `===`);
// - an empty secret is refused: the SDK helper accepts a forgery keyed with "" (the research's
//   empty-secret vector), so a missing secret must never verify anything;
// - during a rotation Razorpay retries older events signed with the old secret, so the previous
//   secret (RAZORPAY_WEBHOOK_SECRET_PREVIOUS) is accepted too.
// Razorpay sends no signed timestamp: the event's `created_at` window is checked after parsing
// (services/billing/webhook.ts, RZP-WH-REPLAY-TIMESTAMP).

const SIGNATURE = /^[0-9a-f]{64}$/;

/** Why a delivery was refused: codes safe to log. */
export type RazorpaySignatureFailure = 'no_secret' | 'missing_header' | 'bad_header' | 'bad_signature';

export type RazorpaySignatureResult =
  | { readonly ok: true; /** Which secret matched (a rotation is complete once `previous` stops matching). */ readonly secret: 'current' | 'previous' }
  | { readonly ok: false; readonly reason: RazorpaySignatureFailure };

function bytesOf(body: string | Uint8Array): Uint8Array {
  return typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
}

/** The lowercase hex HMAC-SHA256 of `body` keyed with `secret` (UTF-8). Refuses an empty secret. */
export function computeRazorpaySignature(body: string | Uint8Array, secret: string): string {
  if (secret.length === 0) throw new RangeError('razorpay_signature_empty_secret');
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(bytesOf(body)).digest('hex');
}

export interface VerifyRazorpaySignatureInput {
  /** The raw request body, as received (bytes, or the exact text). */
  readonly rawBody: string | Uint8Array;
  /** The X-Razorpay-Signature header; null or undefined when absent. */
  readonly signature: string | null | undefined;
  /** [RAZORPAY_WEBHOOK_SECRET, RAZORPAY_WEBHOOK_SECRET_PREVIOUS?]: empty or missing entries are skipped. */
  readonly secrets: readonly (string | null | undefined)[];
}

export function verifyRazorpaySignature(input: VerifyRazorpaySignatureInput): RazorpaySignatureResult {
  const [current, previous] = input.secrets;
  const usable: { secret: string; which: 'current' | 'previous' }[] = [];
  if (typeof current === 'string' && current.length > 0) usable.push({ secret: current, which: 'current' });
  if (typeof previous === 'string' && previous.length > 0) usable.push({ secret: previous, which: 'previous' });
  if (usable.length === 0) return { ok: false, reason: 'no_secret' };

  const header = input.signature;
  if (header === null || header === undefined || header.length === 0) return { ok: false, reason: 'missing_header' };
  if (!SIGNATURE.test(header)) return { ok: false, reason: 'bad_header' };

  const received = Buffer.from(header, 'hex');
  const body = bytesOf(input.rawBody);
  let matched: 'current' | 'previous' | null = null;
  // Every usable secret is tried (no early exit), so the timing says nothing about which one matched.
  for (const { secret, which } of usable) {
    const expected = Buffer.from(computeRazorpaySignature(body, secret), 'hex');
    if (timingSafeEqualBytes(expected, received) && matched === null) matched = which;
  }
  return matched === null ? { ok: false, reason: 'bad_signature' } : { ok: true, secret: matched };
}
