import { describe, expect, it } from 'vitest';
import { daysUntil, displayZone, formatDateInZone, formatInZone } from './format';
import { parseLeadId } from './leads';

// Dashboard times (PLAN §7.5, D-12): in the portal's zone, UTC when the stored zone is unusable; the
// year only outside the current one; whole days rounded up. And the lead id check behind every 404.

const NOW = new Date('2026-10-06T14:00:00.000Z');

describe('dashboard formatting', () => {
  it('uses the portal zone, or UTC when it is missing or unusable', () => {
    expect(displayZone('America/New_York')).toBe('America/New_York');
    expect(displayZone(null)).toBe('UTC');
    expect(displayZone('')).toBe('UTC');
    expect(displayZone('Mars/Olympus_Mons')).toBe('UTC');
  });

  it('formats times in the zone, with the year only when it differs', () => {
    expect(formatInZone(NOW, 'America/New_York', NOW)).toBe('Tue 6 Oct, 10:00');
    expect(formatInZone(NOW, 'Asia/Kolkata', NOW)).toBe('Tue 6 Oct, 19:30');
    expect(formatInZone(new Date('2025-12-31T23:30:00.000Z'), 'UTC', NOW)).toBe('Wed 31 Dec 2025, 23:30');
    // New Year in Kathmandu while it is still the old year in UTC: the zone's year decides.
    expect(formatInZone(new Date('2026-12-31T20:00:00.000Z'), 'Asia/Kathmandu', new Date('2026-12-31T20:00:00.000Z'))).toBe('Fri 1 Jan, 01:45');
    expect(formatDateInZone(new Date('2026-11-05T14:00:00.000Z'), 'America/New_York')).toBe('5 Nov 2026');
  });

  it('counts whole days left, rounded up, and 0 once passed', () => {
    expect(daysUntil(new Date(NOW.getTime() + 14 * 86_400_000), NOW)).toBe(14);
    expect(daysUntil(new Date(NOW.getTime() + 1), NOW)).toBe(1);
    expect(daysUntil(NOW, NOW)).toBe(0);
    expect(daysUntil(new Date(NOW.getTime() - 1), NOW)).toBe(0);
  });

  it('accepts only uuids as lead ids (anything else is a 404 without a query)', () => {
    expect(parseLeadId('7FB4BD35-BE1C-49EB-A15C-D4661A00C7EA')).toBe('7fb4bd35-be1c-49eb-a15c-d4661a00c7ea');
    for (const bad of ['', 'nope', '7fb4bd35-be1c-49eb-a15c-d4661a00c7e', "7fb4bd35-be1c-49eb-a15c-d4661a00c7ea' or '1'='1", null, 42, undefined]) {
      expect(parseLeadId(bad)).toBeNull();
    }
  });
});
