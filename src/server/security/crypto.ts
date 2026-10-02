import 'server-only';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { AppError } from '@/server/domain/errors';

// Token encryption at rest (D-51, PLAN §10.2): AES-256-GCM with a key id and AAD.
//
//   v1.<kid>.<iv>.<ct>.<tag>
//
// - kid: the first 8 hex characters of sha256(key), so rotation can tell keys apart;
// - iv (12 random bytes), ct and tag (16 bytes): base64url without padding, so no part contains
//   '.' (the hubspot_connections CHECK constraint relies on that);
// - AAD binds a ciphertext to its row and column, e.g. "hubspot_connections:<id>:refresh_token",
//   so a ciphertext copied to another row or field fails authentication. encrypt and decrypt
//   refuse any AAD that is not `<table>:<row id>:<column>`, so a forgotten columnAad() cannot
//   silently drop the binding;
// - IVs always come from the CSPRNG: GCM nonce reuse under one key leaks the authentication key.
//   Only createTokenCipherForTest (refused outside NODE_ENV=test) takes another IV source.
// TOKEN_ENCRYPTION_KEY encrypts; TOKEN_ENCRYPTION_KEY_PREVIOUS only decrypts, picked by kid. A
// daily job re-encrypts rows whose kid is not the current one (needsReencrypt).

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
export const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KID = /^[0-9a-f]{8}$/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;
const BASE64_KEY = /^(?:[A-Za-z0-9+/]{43}=?|[A-Za-z0-9_-]{43}=?)$/;
/** `<table>:<row id>:<column>` (columnAad). */
const AAD_FORMAT = /^[a-z_]+:[^:\s]{1,128}:[a-z_]+$/;

export type CryptoErrorCode =
  /** A key is not base64 for exactly 32 bytes, or the previous key equals the current one. */
  | 'crypto_bad_key'
  /** The ciphertext is not in the v1 format. */
  | 'crypto_malformed'
  /** The ciphertext was made with a key that is neither the current nor the previous one. */
  | 'crypto_unknown_kid'
  /** Authentication failed: tampered ciphertext, wrong AAD or wrong key. */
  | 'crypto_auth_failed'
  /** The AAD is not `<table>:<row id>:<column>`. */
  | 'crypto_bad_aad'
  /** A test-only factory was called outside NODE_ENV=test. */
  | 'crypto_test_only';

/** Carries only the code: never the ciphertext, the plaintext, the AAD or the key. */
export class CryptoError extends AppError {
  override readonly name: string = 'CryptoError';
  declare readonly code: CryptoErrorCode;
  readonly kind: 'config' | 'permanent';

  constructor(code: CryptoErrorCode) {
    super(code, undefined);
    this.kind = code === 'crypto_bad_key' || code === 'crypto_unknown_kid' || code === 'crypto_test_only' ? 'config' : 'permanent';
  }
}

export function isCryptoError(e: unknown): e is CryptoError {
  return e instanceof CryptoError;
}

/** Decodes a base64 or base64url key that must be exactly 32 bytes; null otherwise. */
export function tryDecodeKey(encoded: string): Buffer | null {
  if (!BASE64_KEY.test(encoded)) return null;
  const bytes = Buffer.from(encoded, 'base64');
  return bytes.length === KEY_BYTES ? bytes : null;
}

export function decodeKey(encoded: string | Uint8Array): Buffer {
  if (typeof encoded !== 'string') {
    if (encoded.length !== KEY_BYTES) throw new CryptoError('crypto_bad_key');
    return Buffer.from(encoded);
  }
  const bytes = tryDecodeKey(encoded);
  if (bytes === null) throw new CryptoError('crypto_bad_key');
  return bytes;
}

/** The first 8 hex characters of sha256(key). */
export function keyId(key: Uint8Array): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

/** AAD for an encrypted column: `<table>:<row id>:<column>`. */
export function columnAad(table: string, rowId: string, column: string): string {
  return `${table}:${rowId}:${column}`;
}

/** AAD for a HubSpot connection token (D-51). */
export function hubspotTokenAad(connectionId: string, field: 'access_token' | 'refresh_token'): string {
  return columnAad('hubspot_connections', connectionId, field);
}

interface ParsedCiphertext {
  kid: string;
  iv: Buffer;
  ct: Buffer;
  tag: Buffer;
}

function parseCiphertext(ciphertext: string): ParsedCiphertext {
  const parts = ciphertext.split('.');
  if (parts.length !== 5) throw new CryptoError('crypto_malformed');
  const [version, kid, iv, ct, tag] = parts as [string, string, string, string, string];
  if (version !== VERSION || !KID.test(kid) || ![iv, ct, tag].every((part) => BASE64URL.test(part))) {
    throw new CryptoError('crypto_malformed');
  }
  const parsed = { kid, iv: Buffer.from(iv, 'base64url'), ct: Buffer.from(ct, 'base64url'), tag: Buffer.from(tag, 'base64url') };
  if (parsed.iv.length !== IV_BYTES || parsed.tag.length !== TAG_BYTES) throw new CryptoError('crypto_malformed');
  return parsed;
}

/** The kid a ciphertext was made with. Throws crypto_malformed. */
export function ciphertextKid(ciphertext: string): string {
  return parseCiphertext(ciphertext).kid;
}

export interface TokenCipherKeys {
  /** TOKEN_ENCRYPTION_KEY (base64, 32 bytes) or its bytes. */
  current: string | Uint8Array;
  /** TOKEN_ENCRYPTION_KEY_PREVIOUS: decrypt only. */
  previous?: string | Uint8Array | undefined;
}

export interface TokenCipher {
  /** kid of the current key. */
  readonly currentKid: string;
  encrypt(plaintext: string, aad: string): string;
  /** Decrypts with the key named by the ciphertext's kid (current, else previous). */
  decrypt(ciphertext: string, aad: string): string;
  /** True when the ciphertext was not made with the current key (the re-encrypt job's filter). */
  needsReencrypt(ciphertext: string): boolean;
}

interface Keyed {
  kid: string;
  key: Buffer;
}

function checkAad(aad: string): Buffer {
  if (!AAD_FORMAT.test(aad)) throw new CryptoError('crypto_bad_aad');
  return Buffer.from(aad, 'utf8');
}

export function createTokenCipher(keys: TokenCipherKeys): TokenCipher {
  return buildTokenCipher(keys, (size) => randomBytes(size));
}

/**
 * Known-answer tests only: the same cipher with an injected IV source. Refused outside
 * NODE_ENV=test, so production code can never encrypt with a fixed or reused IV.
 */
export function createTokenCipherForTest(keys: TokenCipherKeys, ivSource: (size: number) => Uint8Array): TokenCipher {
  if (process.env.NODE_ENV !== 'test') throw new CryptoError('crypto_test_only');
  return buildTokenCipher(keys, ivSource);
}

function buildTokenCipher(keys: TokenCipherKeys, random: (size: number) => Uint8Array): TokenCipher {
  const currentKey = decodeKey(keys.current);
  const current: Keyed = { key: currentKey, kid: keyId(currentKey) };
  let previous: Keyed | undefined;
  if (keys.previous !== undefined) {
    const key = decodeKey(keys.previous);
    previous = { key, kid: keyId(key) };
    if (previous.kid === current.kid) throw new CryptoError('crypto_bad_key');
  }

  function keyFor(kid: string): Buffer {
    if (kid === current.kid) return current.key;
    if (previous !== undefined && kid === previous.kid) return previous.key;
    throw new CryptoError('crypto_unknown_kid');
  }

  return {
    currentKid: current.kid,

    encrypt(plaintext, aad) {
      const aadBytes = checkAad(aad);
      const iv = Buffer.from(random(IV_BYTES));
      if (iv.length !== IV_BYTES) throw new CryptoError('crypto_bad_key');
      const cipher = createCipheriv(ALGORITHM, current.key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(aadBytes);
      const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, current.kid, iv.toString('base64url'), ct.toString('base64url'), tag.toString('base64url')].join('.');
    },

    decrypt(ciphertext, aad) {
      const aadBytes = checkAad(aad);
      const parsed = parseCiphertext(ciphertext);
      const key = keyFor(parsed.kid);
      try {
        const decipher = createDecipheriv(ALGORITHM, key, parsed.iv, { authTagLength: TAG_BYTES });
        decipher.setAAD(aadBytes);
        decipher.setAuthTag(parsed.tag);
        return Buffer.concat([decipher.update(parsed.ct), decipher.final()]).toString('utf8');
      } catch {
        // Node's message says nothing secret, but the typed error carries only the code.
        throw new CryptoError('crypto_auth_failed');
      }
    },

    needsReencrypt(ciphertext) {
      return parseCiphertext(ciphertext).kid !== current.kid;
    },
  };
}
