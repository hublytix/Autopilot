import 'server-only';

// The PLAN §7.1 "origin" check for a POST route handler (PLAN §3 security/): the browser's `Origin`
// must be the app's own origin. Without a usable `Origin`, `Sec-Fetch-Site: same-origin` is required
// (browsers set it and a page cannot forge it). A request carrying neither is refused. Server Actions
// get Next's own Origin check instead.
//
// `Origin: null` counts as "no usable Origin", not as a foreign one: the Fetch spec sends `null` on a
// non-CORS POST (a plain HTML form) whenever the page's referrer policy is `no-referrer`, and also
// from opaque origins (sandboxed frames, data: URLs). The pages set `same-origin` (D-62), so a real
// form post normally carries the real Origin; `null` is still accepted when the browser vouches for
// the request with `Sec-Fetch-Site: same-origin`. Opaque-origin senders get `cross-site` there.
export function isSameOriginRequest(req: Request, appUrl: string): boolean {
  const expected = new URL(appUrl).origin;
  const origin = req.headers.get('origin');
  if (origin !== null && origin !== 'null') return origin === expected;
  return req.headers.get('sec-fetch-site') === 'same-origin';
}
