import 'server-only';
import { Receiver } from '@upstash/qstash';

// QStash request signatures (PLAN §10.1, D-15, QS-SIG-JWT, QS-RECEIVER-API, QS-DEVMODE-KEY-OVERRIDE).
// Every delivery and failure callback carries an HS256 JWT in `Upstash-Signature`: `iss` Upstash,
// `sub` the destination URL, `body` the base64url SHA-256 of the raw body, a 5-minute `exp`. The
// Receiver is always built with explicit current and next keys and `devMode: false`, so QSTASH_DEV
// can never swap in the public dev-server keys; `url` is the route's own configured URL (never
// `request.url`, which differs behind proxies); clock tolerance 5 s. Verify the RAW body string,
// before any JSON parsing.

export const QSTASH_CLOCK_TOLERANCE_SECONDS = 5;

export interface QstashVerifyConfig {
  currentSigningKey: string;
  nextSigningKey: string;
  /** The exact destination URL the message was published to, e.g. `${APP_URL}/api/jobs/run`. */
  url: string;
}

export type QstashVerifyResult = { ok: true } | { ok: false; reason: 'missing_signature' | 'invalid_signature' };

/** Checks the `Upstash-Signature` of `req` against `rawBody`. Never throws. */
export async function verifyQstashRequest(req: Request, rawBody: string, config: QstashVerifyConfig): Promise<QstashVerifyResult> {
  const signature = req.headers.get('upstash-signature');
  if (signature === null || signature.length === 0) return { ok: false, reason: 'missing_signature' };
  if (config.currentSigningKey.length === 0 || config.nextSigningKey.length === 0) return { ok: false, reason: 'invalid_signature' };
  const receiver = new Receiver({
    currentSigningKey: config.currentSigningKey,
    nextSigningKey: config.nextSigningKey,
    devMode: false,
  });
  try {
    // Resolves true or throws SignatureError; never false (QS-RECEIVER-API).
    const valid = await receiver.verify({
      signature,
      body: rawBody,
      url: config.url,
      clockTolerance: QSTASH_CLOCK_TOLERANCE_SECONDS,
    });
    return valid ? { ok: true } : { ok: false, reason: 'invalid_signature' };
  } catch {
    // The SDK's message quotes the claims; it is not logged.
    return { ok: false, reason: 'invalid_signature' };
  }
}
