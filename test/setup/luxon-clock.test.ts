import { DateTime } from 'luxon';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_LUXON_NOW_MS } from './luxon-clock';

afterEach(() => {
  vi.useRealTimers();
});

describe('Luxon in tests (D-28)', () => {
  it('fills an implicit "now" from a fixed instant, whatever the system time', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-06-15T12:00:00.000Z'));
    expect(DateTime.fromFormat('00:00', 'HH:mm', { zone: 'UTC' }).toMillis()).toBe(TEST_LUXON_NOW_MS);
    expect(DateTime.fromFormat('09:00', 'HH:mm', { zone: 'UTC' }).toISO()).toBe('2000-01-01T09:00:00.000Z');
    expect(DateTime.fromISO('09:30', { zone: 'UTC' }).toISO()).toBe('2000-01-01T09:30:00.000Z');
  });
});
