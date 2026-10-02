import 'server-only';
import { z } from 'zod';
import { errorCode } from '@/server/domain/errors';
import { isSameOriginRequest } from '@/server/security/same-origin';
import { clientIp } from '@/server/http/hubspot-install';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { recordBeacon } from '@/server/services/action-links';

// POST /a/{token}/beacon (D-26): the page beacon of the interstitial, the copy page and (M4) the
// edit page. Same-origin only (PLAN §7.1 "origin"), a JSON body `{"n": "<nonce>"}` of at most 1 KiB,
// /a/* rate limits. Answers carry no content: 204 accepted (recorded, or ignored for a scanner),
// 400 malformed, 403 cross-origin, 404 unknown token or nonce, 413 too large, 429 rate limited.

const MAX_BODY_BYTES = 1024;
const bodySchema = z.object({ n: z.string().max(64) }).strict();
const NO_STORE = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'same-origin' } as const;

function empty(status: number, extra: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { ...NO_STORE, ...extra } });
}

async function readSmallBody(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const text = await req.text();
  return Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES ? null : text;
}

export async function handleBeacon(req: Request, deps: Deps, token: string): Promise<Response> {
  if (!isSameOriginRequest(req, deps.env.APP_URL)) return empty(403);
  try {
    const text = await readSmallBody(req);
    if (text === null) return empty(413);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return empty(400);
    }
    const body = bodySchema.safeParse(json);
    if (!body.success) return empty(400);
    const outcome = await recordBeacon(deps, { token, ip: clientIp(req), nonce: body.data.n, userAgent: req.headers.get('user-agent') });
    switch (outcome.type) {
      case 'recorded':
      case 'ignored':
        return empty(204);
      case 'invalid':
        return empty(404);
      case 'rate_limited':
        return empty(429, { 'Retry-After': String(outcome.retryAfterSeconds) });
    }
  } catch (error) {
    log.error('action link beacon failed', { event: 'action_link.beacon_failed', code: errorCode(error) }, error);
    return empty(503);
  }
}
