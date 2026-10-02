import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CryptoError,
  ciphertextKid,
  columnAad,
  createTokenCipher,
  createTokenCipherForTest,
  decodeKey,
  hubspotTokenAad,
  keyId,
  tryDecodeKey,
} from './crypto';

// Fixed, obviously non-secret test keys (bytes 0..31, 1..32, 2..33).
const keyBytes = (offset: number): Buffer => Buffer.from(Array.from({ length: 32 }, (_, i) => i + offset));
const KEY_A = keyBytes(0).toString('base64');
const KEY_B = keyBytes(1).toString('base64');
const KEY_C = keyBytes(2).toString('base64url');

const CONNECTION_ID = '00000000-0000-4000-8000-000000000001';
const AAD = hubspotTokenAad(CONNECTION_ID, 'refresh_token');
const REFRESH_TOKEN = ['na1', 'aaaa-bbbb-cccc-dddd-eeeeeeeeeeee'].join('-');
// The hubspot_connections CHECK constraint (supabase/migrations/20261001000001_init.sql).
const DB_FORMAT = /^v1\.[0-9a-f]{8}\.[^.]+\.[^.]*\.[^.]+$/;

const errorCode = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof CryptoError ? error.code : `unexpected:${String(error)}`;
  }
  return undefined;
};

describe('token encryption (D-51)', () => {
  it('matches the known-answer vector for AES-256-GCM with a fixed key, IV and AAD', () => {
    const fixedIv = Buffer.from(Array.from({ length: 12 }, (_, i) => 0xa0 + i));
    const cipher = createTokenCipherForTest({ current: KEY_A }, () => fixedIv);
    const ciphertext = cipher.encrypt(REFRESH_TOKEN, AAD);
    expect(ciphertext).toBe(
      'v1.630dcd29.oKGio6Slpqeoqaqr.iHlNACSqY95PB-WxZVejvRPPdHT20yZB-WtD4xrOEGS3EyKa.oQdQQoXOveHyj8ujA7KVLw',
    );
    expect(cipher.decrypt(ciphertext, AAD)).toBe(REFRESH_TOKEN);
  });

  it('uses kid = first 8 hex characters of sha256(key) and the v1 format the database checks', () => {
    const cipher = createTokenCipher({ current: KEY_A });
    const expectedKid = createHash('sha256').update(keyBytes(0)).digest('hex').slice(0, 8);
    expect(cipher.currentKid).toBe(expectedKid);
    expect(keyId(keyBytes(0))).toBe(expectedKid);
    const ciphertext = cipher.encrypt(REFRESH_TOKEN, AAD);
    expect(ciphertext).toMatch(DB_FORMAT);
    expect(ciphertextKid(ciphertext)).toBe(expectedKid);
    expect(ciphertext).not.toContain(REFRESH_TOKEN);
  });

  it('uses a fresh IV for every encryption', () => {
    const cipher = createTokenCipher({ current: KEY_A });
    const first = cipher.encrypt(REFRESH_TOKEN, AAD);
    const second = cipher.encrypt(REFRESH_TOKEN, AAD);
    expect(first).not.toBe(second);
    expect(cipher.decrypt(first, AAD)).toBe(REFRESH_TOKEN);
    expect(cipher.decrypt(second, AAD)).toBe(REFRESH_TOKEN);
  });

  it('round-trips an empty plaintext and unicode, still in the database format', () => {
    const cipher = createTokenCipher({ current: KEY_A });
    const empty = cipher.encrypt('', AAD);
    expect(empty).toMatch(DB_FORMAT);
    expect(cipher.decrypt(empty, AAD)).toBe('');
    expect(cipher.decrypt(cipher.encrypt('tökén ✓', AAD), AAD)).toBe('tökén ✓');
  });

  it('accepts base64url keys and raw 32-byte keys', () => {
    const fromUrl = createTokenCipher({ current: KEY_C });
    const fromBytes = createTokenCipher({ current: keyBytes(2) });
    expect(fromUrl.currentKid).toBe(fromBytes.currentKid);
    expect(fromBytes.decrypt(fromUrl.encrypt(REFRESH_TOKEN, AAD), AAD)).toBe(REFRESH_TOKEN);
  });

  describe('AAD binding', () => {
    it('refuses a ciphertext moved to another connection or another column', () => {
      const cipher = createTokenCipher({ current: KEY_A });
      const ciphertext = cipher.encrypt(REFRESH_TOKEN, AAD);
      const otherRow = hubspotTokenAad('00000000-0000-4000-8000-000000000002', 'refresh_token');
      const otherColumn = hubspotTokenAad(CONNECTION_ID, 'access_token');
      expect(errorCode(() => cipher.decrypt(ciphertext, otherRow))).toBe('crypto_auth_failed');
      expect(errorCode(() => cipher.decrypt(ciphertext, otherColumn))).toBe('crypto_auth_failed');
    });

    it('builds the documented AAD string', () => {
      expect(AAD).toBe(`hubspot_connections:${CONNECTION_ID}:refresh_token`);
      expect(columnAad('inbox_checks', '42', 'test_address')).toBe('inbox_checks:42:test_address');
    });

    // A forgotten columnAad() must fail loudly, not encrypt without the row and column binding.
    it.each([
      ['empty', ''],
      ['a bare id', CONNECTION_ID],
      ['two parts', `hubspot_connections:${CONNECTION_ID}`],
      ['an empty row id', 'hubspot_connections::refresh_token'],
      ['an extra part', `hubspot_connections:${CONNECTION_ID}:refresh_token:x`],
      ['upper case table', `Hubspot_Connections:${CONNECTION_ID}:refresh_token`],
      ['whitespace in the id', 'hubspot_connections:a b:refresh_token'],
      ['an over-long id', `hubspot_connections:${'a'.repeat(129)}:refresh_token`],
    ])('refuses %s as AAD in encrypt and decrypt (crypto_bad_aad)', (_name, aad) => {
      const cipher = createTokenCipher({ current: KEY_A });
      expect(errorCode(() => cipher.encrypt(REFRESH_TOKEN, aad))).toBe('crypto_bad_aad');
      expect(errorCode(() => cipher.decrypt(cipher.encrypt(REFRESH_TOKEN, AAD), aad))).toBe('crypto_bad_aad');
    });
  });

  describe('IV source', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('createTokenCipher takes no IV source: the public factory has one parameter', () => {
      expect(createTokenCipher.length).toBe(1);
    });

    it.each(['production', 'development', ''])('refuses the test-only factory under NODE_ENV=%s', (nodeEnv) => {
      vi.stubEnv('NODE_ENV', nodeEnv);
      expect(errorCode(() => createTokenCipherForTest({ current: KEY_A }, () => Buffer.alloc(12)))).toBe('crypto_test_only');
    });
  });

  describe('tampering', () => {
    const cipher = createTokenCipher({ current: KEY_A });
    const ciphertext = cipher.encrypt(REFRESH_TOKEN, AAD);
    const parts = ciphertext.split('.');
    const flip = (index: number): string => {
      const copy = [...parts];
      const bytes = Buffer.from(copy[index] ?? '', 'base64url');
      bytes[0] = (bytes[0] ?? 0) ^ 0x01;
      copy[index] = bytes.toString('base64url');
      return copy.join('.');
    };

    it.each([
      ['iv', 2],
      ['ciphertext', 3],
      ['tag', 4],
    ])('fails with crypto_auth_failed when the %s is modified', (_part, index) => {
      expect(errorCode(() => cipher.decrypt(flip(index), AAD))).toBe('crypto_auth_failed');
    });

    it('raises a typed error that carries only the code', () => {
      let caught: unknown;
      try {
        cipher.decrypt(flip(3), AAD);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CryptoError);
      const error = caught as CryptoError;
      expect(error.message).toBe('crypto_auth_failed');
      expect(error.kind).toBe('permanent');
      expect('cause' in error).toBe(false);
      const exposed = JSON.stringify({ ...error, message: error.message, stack: error.stack });
      for (const secret of [REFRESH_TOKEN, ciphertext, parts[3] ?? '', AAD, CONNECTION_ID, KEY_A]) {
        expect(exposed).not.toContain(secret);
      }
    });

    it.each([
      ['empty string', ''],
      ['wrong version', ciphertext.replace(/^v1\./, 'v2.')],
      ['missing part', parts.slice(0, 4).join('.')],
      ['extra part', `${ciphertext}.x`],
      ['non-hex kid', ciphertext.replace(/^v1\.[0-9a-f]{8}/, 'v1.ZZZZZZZZ')],
      ['standard base64 characters', ciphertext.replace(/\.[^.]+$/, '.ab+/')],
      ['short IV', [parts[0], parts[1], 'AAAA', parts[3], parts[4]].join('.')],
      ['short tag', [parts[0], parts[1], parts[2], parts[3], 'AAAA'].join('.')],
    ])('fails with crypto_malformed for %s', (_name, value) => {
      expect(errorCode(() => cipher.decrypt(value, AAD))).toBe('crypto_malformed');
      expect(errorCode(() => cipher.needsReencrypt(value))).toBe('crypto_malformed');
    });
  });

  describe('rotation', () => {
    it('decrypts old ciphertexts with the previous key, picked by kid, and flags them for re-encryption', () => {
      const old = createTokenCipher({ current: KEY_A });
      const oldCiphertext = old.encrypt(REFRESH_TOKEN, AAD);

      const rotated = createTokenCipher({ current: KEY_B, previous: KEY_A });
      expect(rotated.decrypt(oldCiphertext, AAD)).toBe(REFRESH_TOKEN);
      expect(rotated.needsReencrypt(oldCiphertext)).toBe(true);

      const reencrypted = rotated.encrypt(rotated.decrypt(oldCiphertext, AAD), AAD);
      expect(ciphertextKid(reencrypted)).toBe(rotated.currentKid);
      expect(rotated.needsReencrypt(reencrypted)).toBe(false);
      expect(rotated.decrypt(reencrypted, AAD)).toBe(REFRESH_TOKEN);
    });

    it('never encrypts with the previous key', () => {
      const rotated = createTokenCipher({ current: KEY_B, previous: KEY_A });
      expect(ciphertextKid(rotated.encrypt(REFRESH_TOKEN, AAD))).toBe(keyId(keyBytes(1)));
    });

    it('refuses a ciphertext whose kid matches neither key', () => {
      const oldCiphertext = createTokenCipher({ current: KEY_A }).encrypt(REFRESH_TOKEN, AAD);
      const withoutPrevious = createTokenCipher({ current: KEY_B });
      expect(errorCode(() => withoutPrevious.decrypt(oldCiphertext, AAD))).toBe('crypto_unknown_kid');
      const otherPrevious = createTokenCipher({ current: KEY_B, previous: KEY_C });
      expect(errorCode(() => otherPrevious.decrypt(oldCiphertext, AAD))).toBe('crypto_unknown_kid');
    });

    it('refuses a ciphertext whose kid was forged to the current key', () => {
      const oldCiphertext = createTokenCipher({ current: KEY_A }).encrypt(REFRESH_TOKEN, AAD);
      const rotated = createTokenCipher({ current: KEY_B, previous: KEY_A });
      const forged = oldCiphertext.replace(/^v1\.[0-9a-f]{8}/, `v1.${rotated.currentKid}`);
      expect(errorCode(() => rotated.decrypt(forged, AAD))).toBe('crypto_auth_failed');
    });
  });

  describe('keys', () => {
    it.each([
      ['too short', Buffer.alloc(16, 7).toString('base64')],
      ['too long', Buffer.alloc(33, 7).toString('base64')],
      ['not base64', 'not a key at all, just some words here!!!!!'],
      ['empty', ''],
    ])('refuses a key that is %s', (_name, key) => {
      expect(tryDecodeKey(key)).toBeNull();
      expect(errorCode(() => decodeKey(key))).toBe('crypto_bad_key');
      expect(errorCode(() => createTokenCipher({ current: key }))).toBe('crypto_bad_key');
    });

    it('refuses raw key bytes of the wrong length', () => {
      expect(errorCode(() => createTokenCipher({ current: Buffer.alloc(31) }))).toBe('crypto_bad_key');
    });

    it('refuses a previous key equal to the current one', () => {
      expect(errorCode(() => createTokenCipher({ current: KEY_A, previous: keyBytes(0) }))).toBe('crypto_bad_key');
    });

    it('marks key problems as configuration errors', () => {
      expect(new CryptoError('crypto_bad_key').kind).toBe('config');
      expect(new CryptoError('crypto_unknown_kid').kind).toBe('config');
      expect(new CryptoError('crypto_malformed').kind).toBe('permanent');
    });
  });
});
