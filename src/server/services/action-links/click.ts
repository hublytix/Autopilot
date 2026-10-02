import 'server-only';
import type { Db } from '@/server/db';

// What counts as an owner opening a send link (D-26, PLAN §1.1 #12, §6.2). Mail security gateways
// and link-preview bots open links in emails within seconds of delivery, so a hit counts only when
// it is NOT a HEAD request, NOT a prefetch, NOT from a known scanner or preview user agent, AND
// either at least 60 s after the email was sent OR it is the page's beacon (a script on the
// interstitial or the edit page that a scanner does not run). Without a known send time only the
// beacon counts (never overstate, law 3). A counted click sets `leads.first_send_clicked_at` (the
// first one only) and the token's `first_used_at`/`use_count`. It is shown as "Send link opened
// (not confirmed)": it is never a confirmed send.

/** D-26: hits sooner than this after the email was sent count only with the page's beacon. */
export const CLICK_MIN_DELAY_MS = 60_000;

/**
 * Link scanners, security gateways, preview bots and HTTP libraries (matched case-insensitively
 * anywhere in the User-Agent). A real owner's browser or mail app never sends these.
 */
export const SCANNER_USER_AGENT_PATTERNS: readonly RegExp[] = [
  // Generic crawler, preview and automation markers ("…bot", but not the Cubot phone brand).
  /(?<!cu)bot\b/i,
  /crawler|spider|slurp|scanner|\bscan\b|preview|prefetch|validator|inspection/i,
  /headless|phantomjs|puppeteer|playwright|selenium|webdriver|lighthouse/i,
  // Mail security gateways and link protection (Office's pre-open "existence discovery" included).
  /safelinks|safe-links|microsoft office|ms-office|msoffice|office existence|skypeuripreview|bingpreview/i,
  /mimecast|proofpoint|barracuda|ironport|\bcisco\b|symantec|messagelabs|broadcom|trend ?micro|fireeye|trellix|forcepoint/i,
  /sophos|avanan|check ?point|zscaler|mcafee|fortinet|fortiguard|paloalto|kaspersky|\beset\b|bitdefender|cloudmark|\bvade\b/i,
  // Google and other link fetchers (Gmail's image proxy, Safe Browsing, read-aloud).
  /googleimageproxy|google-safety|google-read-aloud|feedfetcher|google favicon|googleother/i,
  // Chat and social link previews.
  /facebookexternalhit|facebot|slack-imgproxy|whatsapp|embedly|iframely|outbrain/i,
  // HTTP libraries and command-line clients.
  /^(?:curl|wget|httpie|python-requests|python-urllib|python-httpx|aiohttp|go-http-client|okhttp|java\/|apache-httpclient|libwww-perl|node-fetch|undici|axios|got\b|ruby|php|guzzlehttp|dart|postmanruntime|insomnia)/i,
  /\b(?:python|java|perl|httrack|nutch|scrapy|zgrab|masscan|nmap|nikto|sqlmap)\b/i,
];

/** True for a missing or empty User-Agent, or one on the scanner list. */
export function isScannerUserAgent(userAgent: string | null): boolean {
  const ua = userAgent?.trim() ?? '';
  if (ua.length === 0) return true;
  return SCANNER_USER_AGENT_PATTERNS.some((pattern) => pattern.test(ua));
}

export type ClickRejection = 'head' | 'prefetch' | 'scanner' | 'too_soon' | 'send_time_unknown';

export type ClickVerdict = { readonly human: true } | { readonly human: false; readonly reason: ClickRejection };

export interface ClickSignals {
  /** The request method (a HEAD never counts). */
  readonly method: string;
  readonly userAgent: string | null;
  /** The browser said this is a prefetch or prerender (Sec-Purpose / Purpose / X-Purpose / X-Moz). */
  readonly prefetch: boolean;
  /** This is the page's beacon (its nonce was checked). */
  readonly beacon: boolean;
  /** `$now`. */
  readonly now: Date;
  /** When the email carrying the link was sent (notifications_sent.sent_at); null when unknown. */
  readonly sentAt: Date | null;
}

/** D-26's heuristic: does this hit look like the owner? */
export function judgeClick(signals: ClickSignals): ClickVerdict {
  if (signals.method.toUpperCase() === 'HEAD') return { human: false, reason: 'head' };
  if (signals.prefetch) return { human: false, reason: 'prefetch' };
  if (isScannerUserAgent(signals.userAgent)) return { human: false, reason: 'scanner' };
  if (signals.beacon) return { human: true };
  if (signals.sentAt === null) return { human: false, reason: 'send_time_unknown' };
  if (signals.now.getTime() - signals.sentAt.getTime() < CLICK_MIN_DELAY_MS) return { human: false, reason: 'too_soon' };
  return { human: true };
}

/** True when request headers mark a speculative prefetch or prerender. */
export function isPrefetchRequest(headers: { get(name: string): string | null }): boolean {
  const values = ['sec-purpose', 'purpose', 'x-purpose', 'x-moz'].map((name) => headers.get(name)?.toLowerCase() ?? '');
  return values.some((value) => value.includes('prefetch') || value.includes('prerender') || value.includes('preview'));
}

export interface RecordClickInput {
  readonly tokenId: string;
  readonly accountId: string;
  /** `$now`. */
  readonly now: Date;
}

/**
 * Records one counted use of the token and, the first time, the lead's first_send_clicked_at, in one
 * statement. Returns true when this was the lead's first counted click.
 */
export async function recordClick(db: Db, input: RecordClickInput): Promise<boolean> {
  const rows = await db.query(
    `with used as (
       update action_tokens set first_used_at = coalesce(first_used_at, $2), use_count = use_count + 1
        where id = $1 and account_id = $3
        returning lead_id
     )
     update leads set first_send_clicked_at = $2
      where id = (select lead_id from used) and account_id = $3 and first_send_clicked_at is null
      returning id`,
    [input.tokenId, input.now, input.accountId],
  );
  return rows.length === 1;
}
