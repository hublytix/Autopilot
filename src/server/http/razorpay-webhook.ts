import 'server-only';
import { errorCode } from '@/server/domain/errors';
import { raiseAlert } from '@/server/jobs/alert';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { verifyRazorpaySignature } from '@/server/security/razorpay-signature';
import { processRazorpayWebhook } from '@/server/services/billing';
import { readBoundedBody } from './bounded-body';

// POST /api/razorpay/webhook (PLAN §7.3, §10.1, D-05, D-19; RZP-WH-SIGNATURE, RZP-WH-RETRY-TIMEOUT):
// 1. read the raw body (bounded) and verify X-Razorpay-Signature on its exact bytes with the webhook
//    secret (or the previous one during a rotation): 401 when it fails; 500 and an alert when no
//    secret is configured (an unsigned webhook is never accepted);
// 2. record, window, fetch-and-apply (services/billing/webhook.ts);
// 3. a quick 200 (duplicates, unknown events and unknown subscriptions included), or 503 when the
//    subscription could not be read yet, so Razorpay delivers it again (it retries for 24 h).
// Razorpay's IPs are not allow-listed (RZP-WH-RETRY-TIMEOUT); nothing from the body is logged.

/** Razorpay's subscription events are a few KiB; anything far larger is not Razorpay. */
export const RAZORPAY_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

function json(status: number, body: Record<string, string | boolean>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export async function handleRazorpayWebhook(req: Request, deps: Deps): Promise<Response> {
  // Counted while it streams (a chunked body has no Content-Length): never buffered past the limit.
  const body = await readBoundedBody(req, RAZORPAY_WEBHOOK_MAX_BODY_BYTES);
  if (!body.ok) return json(413, { ok: false, code: 'webhook_body_too_large' });
  const rawBody = body.bytes;

  const verified = verifyRazorpaySignature({
    rawBody,
    signature: req.headers.get('x-razorpay-signature'),
    secrets: [deps.env.RAZORPAY_WEBHOOK_SECRET, deps.env.RAZORPAY_WEBHOOK_SECRET_PREVIOUS],
  });
  if (!verified.ok) {
    if (verified.reason === 'no_secret') {
      raiseAlert('billing_webhook_secret_missing');
      return json(500, { ok: false, code: 'webhook_not_configured' });
    }
    log.warn('razorpay webhook refused', { event: 'webhook.razorpay_refused', provider: 'razorpay', reason: verified.reason });
    return json(401, { ok: false, code: 'invalid_signature' });
  }

  try {
    const result = await processRazorpayWebhook(deps, { rawBody, eventId: req.headers.get('x-razorpay-event-id') });
    return json(result.status, { ok: result.status === 200, outcome: result.outcome });
  } catch (error) {
    log.error('razorpay webhook failed', { event: 'webhook.razorpay_error', provider: 'razorpay', code: errorCode(error) }, error);
    return json(500, { ok: false, code: 'webhook_error' });
  }
}
