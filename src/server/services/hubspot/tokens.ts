import 'server-only';
import type { Env } from '@/server/env';
import { createTokenCipher, hubspotTokenAad, type TokenCipher } from '@/server/security/crypto';

// Encrypting HubSpot tokens at rest (D-51): AES-256-GCM, kid, and an AAD that binds each ciphertext
// to its connection row and column ('hubspot_connections:<id>:access_token' / ':refresh_token'), so
// a ciphertext copied to another row or column fails to decrypt. TOKEN_ENCRYPTION_KEY encrypts;
// TOKEN_ENCRYPTION_KEY_PREVIOUS only decrypts. Plaintext tokens never leave this module's callers'
// locals: they are never logged or put into errors (law 4).

const ciphers = new WeakMap<Env, TokenCipher>();

export function tokenCipher(env: Env): TokenCipher {
  let cipher = ciphers.get(env);
  if (cipher === undefined) {
    cipher = createTokenCipher({ current: env.TOKEN_ENCRYPTION_KEY, previous: env.TOKEN_ENCRYPTION_KEY_PREVIOUS });
    ciphers.set(env, cipher);
  }
  return cipher;
}

export interface EncryptedTokens {
  readonly accessTokenEnc: string;
  readonly refreshTokenEnc: string;
}

export function encryptTokens(env: Env, connectionId: string, tokens: { accessToken: string; refreshToken: string }): EncryptedTokens {
  const cipher = tokenCipher(env);
  return {
    accessTokenEnc: cipher.encrypt(tokens.accessToken, hubspotTokenAad(connectionId, 'access_token')),
    refreshTokenEnc: cipher.encrypt(tokens.refreshToken, hubspotTokenAad(connectionId, 'refresh_token')),
  };
}

export function decryptAccessToken(env: Env, connectionId: string, ciphertext: string): string {
  return tokenCipher(env).decrypt(ciphertext, hubspotTokenAad(connectionId, 'access_token'));
}

export function decryptRefreshToken(env: Env, connectionId: string, ciphertext: string): string {
  return tokenCipher(env).decrypt(ciphertext, hubspotTokenAad(connectionId, 'refresh_token'));
}
