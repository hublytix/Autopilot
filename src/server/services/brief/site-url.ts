import 'server-only';
import { urlRefusal } from '@/server/security/ssrf';

// The website address the owner types (PLAN §9.7): "brightside-plumbing.example", "www.x.com/home"
// or a full URL. A missing scheme means https. The SSRF guard's URL rules apply at once, so an
// address the crawl would refuse anyway (an IP, localhost, a port) is rejected in the form.

export const MAX_SITE_URL_LENGTH = 2048;

export type SiteUrlResult = { ok: true; url: string } | { ok: false; reason: 'site_url_invalid' | 'site_url_not_allowed' };

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export function normaliseSiteUrl(input: string): SiteUrlResult {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SITE_URL_LENGTH || /\s/.test(trimmed)) return { ok: false, reason: 'site_url_invalid' };
  let url: URL;
  try {
    url = new URL(HAS_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, reason: 'site_url_invalid' };
  }
  if (urlRefusal(url) !== null) return { ok: false, reason: 'site_url_not_allowed' };
  url.hash = '';
  return { ok: true, url: url.href };
}

/** The host a site is known by: lower case, without a leading `www.` or a trailing dot. */
export function siteKey(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}

/** Same site: the same host, give or take `www.`, over http or https. */
export function isSameSite(a: URL, b: URL): boolean {
  return siteKey(a) === siteKey(b);
}
