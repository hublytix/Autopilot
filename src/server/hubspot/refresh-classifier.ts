import 'server-only';
import { z } from 'zod';
import type { RefreshFailureClass } from '@/server/domain/types';

// D-11's table for a failed token-endpoint call (HS-OAUTH-REFRESH-ERRORS, HS-HTTP-ERROR-CODES,
// HS-429-SHAPE):
// - transient: no response (timeout, network), 423, 429, 477 and every 5xx (502-504, 521-526),
//   whatever the body says;
// - revoked: any other 4xx whose RFC 6749 `error` is `invalid_grant` or `access_denied`, or whose
//   HubSpot `status` is `BAD_REFRESH_TOKEN` or `BAD_HUB`;
// - config: `invalid_client`, `unauthorized_client`, `invalid_request`, `unsupported_grant_type`,
//   `BAD_CLIENT_ID`, `BAD_CLIENT_SECRET`, `BAD_REDIRECT_URI`, `BAD_GRANT_TYPE`, and every other 4xx,
//   including a 401 without a revoked marker. An unknown error therefore never revokes a portal, so a
//   rotated client secret cannot mass-revoke every connection.
// HubSpot recommends branching on `error` first (2026-01 RFC 6749 change), so `error` decides before
// the legacy `status` field does.

const REVOKED_ERRORS: ReadonlySet<string> = new Set(['invalid_grant', 'access_denied']);
const CONFIG_ERRORS: ReadonlySet<string> = new Set(['invalid_client', 'unauthorized_client', 'invalid_request', 'unsupported_grant_type']);
const REVOKED_STATUSES: ReadonlySet<string> = new Set(['BAD_REFRESH_TOKEN', 'BAD_HUB']);

const TRANSIENT_HTTP_STATUSES: ReadonlySet<number> = new Set([423, 429, 477]);

/** Every field is optional and a mistyped one is ignored: a gateway may answer with HTML or nothing at all. */
const oauthErrorBody = z.object({
  error: z.string().optional().catch(undefined),
  status: z.string().optional().catch(undefined),
});

function parseBody(body: unknown): z.infer<typeof oauthErrorBody> {
  let value = body;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  const parsed = oauthErrorBody.safeParse(value);
  return parsed.success ? parsed.data : {};
}

/**
 * Classifies a failed `POST /oauth/{v}/token` refresh. `status` is null when no response arrived;
 * `body` is the parsed JSON (or the raw text when it was not JSON).
 */
export function classifyRefreshFailure(status: number | null, body: unknown): RefreshFailureClass {
  // Outside 4xx (including a redirect or an unreadable 2xx) nothing proves a revocation or a config error.
  if (status === null || status < 400 || status >= 500 || TRANSIENT_HTTP_STATUSES.has(status)) return 'transient';
  const { error, status: hubspotStatus } = parseBody(body);
  if (error !== undefined && REVOKED_ERRORS.has(error)) return 'revoked';
  if (error !== undefined && CONFIG_ERRORS.has(error)) return 'config';
  if (hubspotStatus !== undefined && REVOKED_STATUSES.has(hubspotStatus)) return 'revoked';
  return 'config';
}
