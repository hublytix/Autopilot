import 'server-only';

// Where a confirmed magic link lands (PLAN §10.3, D-22): `next` is parsed with new URL(next, APP_URL)
// and kept only when it stays on our origin and its path is an app area (`/dashboard`,
// `/onboarding`, `/admin`, or below); the query is kept (e.g. `/dashboard?reconnect=1`), the
// fragment dropped. Anything else lands on /dashboard.

export const DEFAULT_NEXT_PATH = '/dashboard';
const ALLOWED_PATH = /^\/(?:dashboard|onboarding|admin)(?:\/|$)/;
const MAX_NEXT_LENGTH = 512;

/** The allow-listed path + query for `next`, or `/dashboard`. */
export function safeNextPath(next: string | null | undefined, appUrl: string): string {
  if (next === null || next === undefined || next.length === 0 || next.length > MAX_NEXT_LENGTH) return DEFAULT_NEXT_PATH;
  let base: URL;
  let url: URL;
  try {
    base = new URL(appUrl);
    url = new URL(next, base);
  } catch {
    return DEFAULT_NEXT_PATH;
  }
  if (url.origin !== base.origin || url.username !== '' || url.password !== '') return DEFAULT_NEXT_PATH;
  if (!ALLOWED_PATH.test(url.pathname)) return DEFAULT_NEXT_PATH;
  return `${url.pathname}${url.search}`;
}
