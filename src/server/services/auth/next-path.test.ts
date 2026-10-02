import { describe, expect, it } from 'vitest';
import { DEFAULT_NEXT_PATH, safeNextPath } from './next-path';

const APP = 'https://autopilot.example.com';

describe('safeNextPath', () => {
  it.each([
    ['/dashboard', '/dashboard'],
    ['/dashboard?reconnect=1', '/dashboard?reconnect=1'],
    ['/dashboard/leads/abc?tab=draft#top', '/dashboard/leads/abc?tab=draft'],
    ['/onboarding/brief', '/onboarding/brief'],
    ['/admin', '/admin'],
    ['/admin/', '/admin/'],
    [`${APP}/onboarding/forms`, '/onboarding/forms'],
  ])('keeps an app path on our origin with its query: %s', (next, expected) => {
    expect(safeNextPath(next, APP)).toBe(expected);
  });

  it.each([
    [null],
    [undefined],
    [''],
    ['https://evil.example/dashboard'],
    ['//evil.example/dashboard'],
    ['/\\evil.example/dashboard'],
    ['https://user:pass@autopilot.example.com/dashboard'],
    ['http://autopilot.example.com/dashboard'],
    ['/login'],
    ['/dashboardx'],
    ['/a/token/send'],
    ['/api/billing/checkout'],
    ['javascript:alert(1)'],
    ['data:text/html,hi'],
    [`/dashboard?${'x'.repeat(600)}`],
  ])('falls back to /dashboard for %s', (next) => {
    expect(safeNextPath(next, APP)).toBe(DEFAULT_NEXT_PATH);
  });

  it('resolves dot segments before checking the path', () => {
    expect(safeNextPath('/dashboard/../login', APP)).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath('/x/../admin', APP)).toBe('/admin');
  });
});
