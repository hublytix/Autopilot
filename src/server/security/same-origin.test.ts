import { describe, expect, it } from 'vitest';
import { isSameOriginRequest } from './same-origin';

describe('isSameOriginRequest', () => {
  const appUrl = 'http://localhost:3000';
  const req = (headers: Record<string, string>): Request => new Request(`${appUrl}/x`, { method: 'POST', headers });

  it('compares Origin with the APP_URL origin, else requires Sec-Fetch-Site same-origin', () => {
    expect(isSameOriginRequest(req({ Origin: 'http://localhost:3000' }), appUrl)).toBe(true);
    expect(isSameOriginRequest(req({ Origin: 'https://localhost:3000' }), appUrl)).toBe(false);
    // An Origin that disagrees wins over a same-origin Sec-Fetch-Site.
    expect(isSameOriginRequest(req({ Origin: 'https://evil.example', 'Sec-Fetch-Site': 'same-origin' }), appUrl)).toBe(false);
    expect(isSameOriginRequest(req({ 'Sec-Fetch-Site': 'same-origin' }), appUrl)).toBe(true);
    expect(isSameOriginRequest(req({ 'Sec-Fetch-Site': 'same-site' }), appUrl)).toBe(false);
    expect(isSameOriginRequest(req({}), appUrl)).toBe(false);
  });

  it('accepts Origin null only when the browser says the request is same-origin', () => {
    // A plain form post from a no-referrer page: the browser sends Origin null and Sec-Fetch-Site same-origin.
    expect(isSameOriginRequest(req({ Origin: 'null', 'Sec-Fetch-Site': 'same-origin' }), appUrl)).toBe(true);
    // A sandboxed frame or data: URL elsewhere also sends Origin null, but Sec-Fetch-Site cross-site.
    expect(isSameOriginRequest(req({ Origin: 'null', 'Sec-Fetch-Site': 'cross-site' }), appUrl)).toBe(false);
    expect(isSameOriginRequest(req({ Origin: 'null', 'Sec-Fetch-Site': 'same-site' }), appUrl)).toBe(false);
    expect(isSameOriginRequest(req({ Origin: 'null' }), appUrl)).toBe(false);
  });
});
