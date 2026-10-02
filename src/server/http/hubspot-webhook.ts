import 'server-only';
import { errorCode } from '@/server/domain/errors';
import { verifyHubSpotSignatureV3 } from '@/server/hubspot/signature';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { sha256Hex } from '@/server/security/keys';
import { parseWebhookBody, processHubSpotWebhook } from '@/server/services/intake';

// POST /api/hubspot/webhooks (PLAN §7.3, §10.1, D-05, D-06; HS-WH-DELIVERY):
// 1. read the raw body (bounded) and verify the v3 signature on it, with HUBSPOT_WEBHOOK_TARGET_URL
//    as the URI and the current or previous client secret: 401 when it fails;
// 2. parse: an array of at most 100 events, each validated on its own (Zod);
// 3. record and act (services/intake/webhook.ts), publish the jobs after commit.
// Every verified delivery gets a quick 200 (unknown portals, other apps' events, malformed entries
// included): HubSpot retries any 4xx/5xx for 24 hours, and retrying would not change the outcome. A
// database failure answers 500, so HubSpot retries and the dedupe keys make the retry safe. Nothing
// from the body is logged except counts.

/** HubSpot sends at most 100 small events; anything far larger is not HubSpot. */
export const HUBSPOT_WEBHOOK_MAX_BODY_BYTES = 512 * 1024;

function json(status: number, body: Record<string, string | number | boolean>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function tooLarge(req: Request): boolean {
  const declared = req.headers.get('content-length');
  return declared !== null && /^\d{1,15}$/.test(declared) && Number(declared) > HUBSPOT_WEBHOOK_MAX_BODY_BYTES;
}

export async function handleHubSpotWebhook(req: Request, deps: Deps): Promise<Response> {
  if (tooLarge(req)) return json(413, { ok: false, code: 'webhook_body_too_large' });
  const raw = await req.text();
  if (Buffer.byteLength(raw, 'utf8') > HUBSPOT_WEBHOOK_MAX_BODY_BYTES) return json(413, { ok: false, code: 'webhook_body_too_large' });

  const verified = verifyHubSpotSignatureV3({
    method: req.method,
    uri: deps.env.HUBSPOT_WEBHOOK_TARGET_URL,
    rawBody: raw,
    timestamp: req.headers.get('x-hubspot-request-timestamp'),
    signature: req.headers.get('x-hubspot-signature-v3'),
    secrets: [deps.env.HUBSPOT_CLIENT_SECRET, deps.env.HUBSPOT_CLIENT_SECRET_PREVIOUS],
    nowMs: deps.clock.now().getTime(),
  });
  if (!verified.ok) {
    log.warn('hubspot webhook refused', { event: 'webhook.hubspot_refused', provider: 'hubspot', reason: verified.reason });
    return json(401, { ok: false, code: 'invalid_signature' });
  }

  const parsed = parseWebhookBody(parseJson(raw));
  if (parsed === null) {
    log.warn('hubspot webhook body not understood', { event: 'webhook.hubspot_bad_body', provider: 'hubspot' });
    return json(200, { ok: true, code: 'webhook_body_ignored' });
  }

  try {
    const summary = await processHubSpotWebhook(deps, { ...parsed, bodySha256: sha256Hex(raw) });
    return json(200, { ok: true, ...summary });
  } catch (error) {
    log.error('hubspot webhook failed', { event: 'webhook.hubspot_error', provider: 'hubspot', code: errorCode(error) }, error);
    return json(500, { ok: false, code: 'webhook_error' });
  }
}
