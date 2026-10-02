import 'server-only';
import { urlRefusal } from '@/server/security/ssrf';

// Booking-link rules (brief §5.3, PLAN §9.7, D-47):
// - a booking link is an https URL with a real public-looking host (no credentials, no IP literal,
//   no local or single-label host, default port);
// - a generated one is kept only when it appears in the visible text or visible links of the
//   fetched pages (hidden DOM was stripped before, so a decoy hidden in the page never qualifies);
// - the editor shows its host (ASCII, so a look-alike Unicode domain shows as xn--…) and asks the
//   owner to confirm it; an owner save with a link requires that confirmation.

export const MAX_BOOKING_LINK_LENGTH = 2048;

/** The link as a URL when it is an acceptable https booking link, else null. */
export function parseBookingLink(value: string | null | undefined): URL | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_BOOKING_LINK_LENGTH || /\s/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port !== '' || urlRefusal(url) !== null) return null;
  return url;
}

/** The host the owner is asked to confirm, e.g. `cal.example.com`; null for an unacceptable link. */
export function bookingLinkHost(value: string | null | undefined): string | null {
  return parseBookingLink(value)?.hostname ?? null;
}

/** Comparable form: no fragment, no trailing slash on a non-root path. */
function comparable(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = '';
  if (copy.pathname.length > 1) copy.pathname = copy.pathname.replace(/\/+$/, '');
  return copy.href;
}

/**
 * The generated booking link to keep: the model's link when it is https and one of the pages'
 * visible URLs is the same address (fragment and trailing slash aside); otherwise null.
 */
export function acceptGeneratedBookingLink(link: string | null, visibleUrls: readonly string[]): string | null {
  const parsed = parseBookingLink(link);
  if (parsed === null) return null;
  const wanted = comparable(parsed);
  const seen = visibleUrls.some((raw) => {
    try {
      return comparable(new URL(raw)) === wanted;
    } catch {
      return false;
    }
  });
  return seen ? parsed.href : null;
}
