import 'server-only';
import { z } from 'zod';
import { CONNECTION_STATUSES } from '@/server/domain/types';
import type { Deps } from '@/server/ports';
import { decryptRefreshToken, revokeConnection } from '@/server/services/hubspot';

// The daily introspection probe (PLAN §9.1 step 4, D-10 signal 2): HubSpot sends no uninstall event,
// so every active connection's refresh token is introspected once a day, whatever the account's
// pause or billing state. `{"active": false}` takes the revoked path (services/hubspot/revoke.ts:
// tokens wiped, purge_after = +30 d, jobs cancelled, action tokens revoked, the reconnect email),
// guarded by the token_version read here, so a reconnect that stored fresh tokens meanwhile is never
// undone. An active answer refreshes the connection's `hub_domain` (D-12). One OAuth call, not
// portal-limited, bounded like a refresh (8 s).

export const INTROSPECT_TIMEOUT_MS = 8 * 1000;

export type IntrospectOutcome =
  /** No active connection holding a refresh token: nothing to probe. */
  | 'no_connection'
  | 'active'
  /** HubSpot says the token is inactive: this probe revoked the connection. */
  | 'revoked'
  /** Inactive, but the connection changed meanwhile (revoked elsewhere, or reconnected with newer tokens). */
  | 'unchanged';

const connectionSchema = z.object({
  id: z.string(),
  status: z.enum(CONNECTION_STATUSES),
  refresh_token_enc: z.string().nullable(),
  token_version: z.number(),
});

export async function probeConnection(deps: Deps, accountId: string): Promise<IntrospectOutcome> {
  const raw = await deps.db.maybeOne(`select id, status, refresh_token_enc, token_version from hubspot_connections where account_id = $1`, [accountId]);
  const connection = raw === null ? null : connectionSchema.parse(raw);
  if (connection === null || connection.status !== 'active' || connection.refresh_token_enc === null) return 'no_connection';

  const refreshToken = decryptRefreshToken(deps.env, connection.id, connection.refresh_token_enc);
  const info = await deps.hubspot.introspect(refreshToken, 'refresh_token', { signal: AbortSignal.timeout(INTROSPECT_TIMEOUT_MS) });
  if (info.active) {
    await deps.db.query(`update hubspot_connections set hub_domain = $2 where id = $1 and status = 'active' and hub_domain is distinct from $2`, [
      connection.id,
      info.hubDomain,
    ]);
    return 'active';
  }
  const outcome = await revokeConnection(deps, {
    accountId,
    connectionId: connection.id,
    tokenVersion: connection.token_version,
    reason: 'introspection_inactive',
  });
  return outcome === 'revoked' ? 'revoked' : 'unchanged';
}
