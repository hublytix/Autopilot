import { describe, expect, it } from 'vitest';
import { ownValue } from './own-key';

describe('ownValue', () => {
  const table: Readonly<Record<string, string>> = { invalid: 'Check the list.', rate_limited: 'Wait a minute.' };

  it('returns the message for a listed code', () => {
    expect(ownValue(table, 'invalid')).toBe('Check the list.');
  });

  it('never returns what Object.prototype supplies for an attacker-chosen code', () => {
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'unknown']) {
      expect(ownValue(table, key), key).toBeUndefined();
    }
    expect(ownValue(table, undefined)).toBeUndefined();
  });
});
