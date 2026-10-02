import 'server-only';

// The PLAN §7.1 "origin" check for a POST route handler: the browser's `Origin` must be the app's
// own origin; without an `Origin`, `Sec-Fetch-Site: same-origin` is required. A request carrying
// neither is refused. Used by the /dev forms; M3's shared `assertSameOrigin` (security/) can replace it.
export function isSameOriginRequest(req: Request, appUrl: string): boolean {
  const expected = new URL(appUrl).origin;
  const origin = req.headers.get('origin');
  if (origin !== null) return origin === expected;
  return req.headers.get('sec-fetch-site') === 'same-origin';
}
