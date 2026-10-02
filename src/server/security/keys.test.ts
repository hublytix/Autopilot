import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CryptoError } from './crypto';
import {
  KEY_INFO_PREFIX,
  KEY_PURPOSES,
  deriveKey,
  deriveKeys,
  hmacBase64Url,
  hmacHex,
  sha256Hex,
  timingSafeEqualBytes,
  timingSafeEqualHex,
  timingSafeEqualString,
} from './keys';

const APP_SECRET_BYTES = Buffer.from(Array.from({ length: 32 }, (_, i) => 0x40 + i));
const APP_SECRET = APP_SECRET_BYTES.toString('base64');

/** RFC 5869 HKDF-SHA256 written out with plain HMAC, independent of node:crypto's hkdf. */
function referenceHkdf(ikm: Buffer, salt: Buffer, info: string, length: number): Buffer {
  const prk = createHmac('sha256', salt.length > 0 ? salt : Buffer.alloc(32)).update(ikm).digest();
  const blocks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(blocks).length < length; i += 1) {
    previous = createHmac('sha256', prk).update(Buffer.concat([previous, Buffer.from(info, 'utf8'), Buffer.from([i])])).digest();
    blocks.push(previous);
  }
  return Buffer.concat(blocks).subarray(0, length);
}

describe('per-purpose keys (HKDF-SHA256 from APP_SECRET, D-51)', () => {
  it('derives 32-byte keys equal to the RFC 5869 construction with an empty salt and a versioned, app-scoped info', () => {
    expect(KEY_INFO_PREFIX).toBe('hublytix-autopilot/v1/');
    for (const purpose of KEY_PURPOSES) {
      const key = deriveKey(APP_SECRET, purpose);
      expect(key).toHaveLength(32);
      expect(key.equals(referenceHkdf(APP_SECRET_BYTES, Buffer.alloc(0), `hublytix-autopilot/v1/${purpose}`, 32))).toBe(true);
      // The bare purpose label alone (no app or version context) gives a different key.
      expect(key.equals(referenceHkdf(APP_SECRET_BYTES, Buffer.alloc(0), purpose, 32))).toBe(false);
    }
  });

  it('derives a different key for every purpose and the same key every time', () => {
    const keys = deriveKeys(APP_SECRET);
    expect(Object.keys(keys).sort()).toEqual([...KEY_PURPOSES].sort());
    const hexes = KEY_PURPOSES.map((purpose) => keys[purpose].toString('hex'));
    expect(new Set(hexes).size).toBe(KEY_PURPOSES.length);
    expect(deriveKeys(APP_SECRET_BYTES).state.equals(keys.state)).toBe(true);
    expect(Object.isFrozen(keys)).toBe(true);
  });

  it('covers exactly the D-51 purposes (action tokens are plain sha256 hashes, no key)', () => {
    expect(KEY_PURPOSES).toEqual(['state', 'pending', 'ratelimit', 'dedupe', 'fake-session']);
  });

  it('derives different keys from a different APP_SECRET', () => {
    const other = Buffer.from(Array.from({ length: 32 }, (_, i) => 0x80 + i));
    expect(deriveKey(other, 'state').equals(deriveKey(APP_SECRET, 'state'))).toBe(false);
  });

  it('refuses an APP_SECRET that is not 32 bytes', () => {
    expect(() => deriveKeys(Buffer.alloc(16).toString('base64'))).toThrow(CryptoError);
    expect(() => deriveKey('short', 'state')).toThrow(CryptoError);
  });
});

describe('hash helpers', () => {
  it('computes HMAC-SHA256 as lower-case hex (RFC 4231 test case 2)', () => {
    expect(hmacHex(Buffer.from('Jefe'), 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('computes HMAC-SHA256 as unpadded base64url', () => {
    const value = hmacBase64Url(Buffer.from('Jefe'), 'what do ya want for nothing?');
    expect(value).toBe(Buffer.from('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843', 'hex').toString('base64url'));
    expect(value).not.toMatch(/[=+/]/);
  });

  it('computes SHA-256 as lower-case hex (FIPS 180-2 "abc")', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('constant-time comparisons', () => {
  it('compares strings, including different lengths and unicode', () => {
    expect(timingSafeEqualString('apt_abc', 'apt_abc')).toBe(true);
    expect(timingSafeEqualString('apt_abc', 'apt_abd')).toBe(false);
    expect(timingSafeEqualString('apt_abc', 'apt_abcd')).toBe(false);
    expect(timingSafeEqualString('', '')).toBe(true);
    expect(timingSafeEqualString('é', 'é')).toBe(true);
    expect(timingSafeEqualString('é', 'e')).toBe(false);
  });

  it('compares hex digests ignoring case', () => {
    expect(timingSafeEqualHex('ABCDEF01', 'abcdef01')).toBe(true);
    expect(timingSafeEqualHex('abcdef01', 'abcdef02')).toBe(false);
  });

  it('compares bytes and returns false for different lengths', () => {
    expect(timingSafeEqualBytes(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 3]))).toBe(true);
    expect(timingSafeEqualBytes(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 4]))).toBe(false);
    expect(timingSafeEqualBytes(Buffer.from([1, 2, 3]), Buffer.from([1, 2]))).toBe(false);
  });
});
