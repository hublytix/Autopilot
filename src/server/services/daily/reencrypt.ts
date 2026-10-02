import 'server-only';
import { z } from 'zod';
import { raiseAlert } from '@/server/jobs/alert';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { hubspotTokenAad } from '@/server/security/crypto';
import { tokenCipher } from '@/server/services/hubspot';

// Key rotation (D-51, PLAN §9.1 step 4): a ciphertext whose kid is not TOKEN_ENCRYPTION_KEY's is
// decrypted (with TOKEN_ENCRYPTION_KEY_PREVIOUS) and encrypted again under the current key, keeping
// its AAD (row and column). The write is a compare-and-set on the exact ciphertexts read, so tokens a
// refresh or a reconnect stored meanwhile (already under the current key) are never overwritten.
// A ciphertext neither key can open raises one alert per run and is left alone: the token manager
// cannot use it either, and the next refresh or reconnect replaces it.

export type ReencryptOutcome =
  /** No tokens stored (revoked or disconnected). */
  | 'no_tokens'
  /** Already under the current key. */
  | 'current'
  | 'reencrypted'
  /** The tokens changed meanwhile (they are under the current key). */
  | 'changed'
  /** Neither key opens a ciphertext. */
  | 'unreadable';

const rowSchema = z.object({ id: z.string(), access_token_enc: z.string().nullable(), refresh_token_enc: z.string().nullable() });

export async function reencryptConnectionTokens(deps: Pick<Deps, 'db' | 'env'>, accountId: string): Promise<ReencryptOutcome> {
  const raw = await deps.db.maybeOne(`select id, access_token_enc, refresh_token_enc from hubspot_connections where account_id = $1`, [accountId]);
  if (raw === null) return 'no_tokens';
  const row = rowSchema.parse(raw);
  if (row.access_token_enc === null && row.refresh_token_enc === null) return 'no_tokens';
  const cipher = tokenCipher(deps.env);
  const stale = (value: string | null): value is string => value !== null && cipher.needsReencrypt(value);
  if (!stale(row.access_token_enc) && !stale(row.refresh_token_enc)) return 'current';

  let access: string | null;
  let refresh: string | null;
  try {
    const again = (value: string | null, field: 'access_token' | 'refresh_token'): string | null => {
      if (value === null || !cipher.needsReencrypt(value)) return value;
      const aad = hubspotTokenAad(row.id, field);
      return cipher.encrypt(cipher.decrypt(value, aad), aad);
    };
    access = again(row.access_token_enc, 'access_token');
    refresh = again(row.refresh_token_enc, 'refresh_token');
  } catch (error) {
    raiseAlert('token_reencrypt_failed', { accountId, connectionId: row.id });
    log.warn('connection tokens not re-encrypted', { event: 'daily.reencrypt_failed', accountId, connectionId: row.id }, error);
    return 'unreadable';
  }

  const written = await deps.db.maybeOne(
    `update hubspot_connections set access_token_enc = $4, refresh_token_enc = $5
      where id = $1 and access_token_enc is not distinct from $2 and refresh_token_enc is not distinct from $3
      returning id`,
    [row.id, row.access_token_enc, row.refresh_token_enc, access, refresh],
  );
  if (written === null) return 'changed';
  log.info('connection tokens re-encrypted', { event: 'daily.reencrypted', accountId, connectionId: row.id, kid: cipher.currentKid });
  return 'reencrypted';
}
