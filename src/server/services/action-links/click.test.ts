import { describe, expect, it } from 'vitest';
import { CLICK_MIN_DELAY_MS, isPrefetchRequest, isScannerUserAgent, judgeClick, type ClickSignals } from '.';

const SENT = new Date('2026-10-06T14:00:00.000Z');
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const after = (ms: number): Date => new Date(SENT.getTime() + ms);

function signals(overrides: Partial<ClickSignals> = {}): ClickSignals {
  return { method: 'GET', userAgent: BROWSER, prefetch: false, beacon: false, now: after(CLICK_MIN_DELAY_MS), sentAt: SENT, ...overrides };
}

describe('judgeClick (D-26)', () => {
  it('counts a browser GET at least 60 s after the email was sent', () => {
    expect(judgeClick(signals())).toEqual({ human: true });
    expect(judgeClick(signals({ now: after(3_600_000) }))).toEqual({ human: true });
  });

  it('does not count a GET sooner than 60 s after the email was sent', () => {
    expect(judgeClick(signals({ now: after(CLICK_MIN_DELAY_MS - 1) }))).toEqual({ human: false, reason: 'too_soon' });
    expect(judgeClick(signals({ now: after(2_000) }))).toEqual({ human: false, reason: 'too_soon' });
  });

  it("counts the page's beacon whenever it arrives", () => {
    expect(judgeClick(signals({ method: 'POST', beacon: true, now: after(1_000) }))).toEqual({ human: true });
    expect(judgeClick(signals({ method: 'POST', beacon: true, sentAt: null }))).toEqual({ human: true });
  });

  it('never counts a HEAD, a prefetch or a scanner, even with a beacon', () => {
    expect(judgeClick(signals({ method: 'HEAD' }))).toEqual({ human: false, reason: 'head' });
    expect(judgeClick(signals({ method: 'head' }))).toEqual({ human: false, reason: 'head' });
    expect(judgeClick(signals({ prefetch: true }))).toEqual({ human: false, reason: 'prefetch' });
    expect(judgeClick(signals({ userAgent: 'python-requests/2.32.3', beacon: true }))).toEqual({ human: false, reason: 'scanner' });
  });

  it('needs the beacon when the send time is unknown (never overstate)', () => {
    expect(judgeClick(signals({ sentAt: null, now: after(86_400_000) }))).toEqual({ human: false, reason: 'send_time_unknown' });
  });
});

describe('isScannerUserAgent', () => {
  it.each([
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/138.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5 skype-url-preview@microsoft.com',
    'Microsoft Office Existence Discovery',
    'Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.17928; Pro)',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; Trident/7.0; BingPreview/1.0b) like Gecko',
    'Mimecast-URL-Protect/1.0',
    'Proofpoint URL Defense',
    'Barracuda Sentinel (EE)',
    'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)',
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    'WhatsApp/2.23.20.0',
    'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
    'curl/8.7.1',
    'Wget/1.21.4',
    'python-requests/2.32.3',
    'Go-http-client/2.0',
    'okhttp/4.12.0',
    'node-fetch/1.0 (+https://github.com/bitinn/node-fetch)',
    'axios/1.7.2',
    '',
    '   ',
  ])('treats %j as a scanner', (ua) => {
    expect(isScannerUserAgent(ua)).toBe(true);
  });

  it('treats a missing user agent as a scanner', () => {
    expect(isScannerUserAgent(null)).toBe(true);
  });

  it.each([
    BROWSER,
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 GSA/379.0.785410560 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.7204.157 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 11; CUBOT X50) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0',
    'Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  ])('treats a browser (%s) as a person', (ua) => {
    expect(isScannerUserAgent(ua)).toBe(false);
  });
});

describe('isPrefetchRequest', () => {
  it('spots prefetch and prerender headers', () => {
    expect(isPrefetchRequest(new Headers({ 'sec-purpose': 'prefetch' }))).toBe(true);
    expect(isPrefetchRequest(new Headers({ 'sec-purpose': 'prefetch;prerender' }))).toBe(true);
    expect(isPrefetchRequest(new Headers({ purpose: 'prefetch' }))).toBe(true);
    expect(isPrefetchRequest(new Headers({ 'x-purpose': 'preview' }))).toBe(true);
    expect(isPrefetchRequest(new Headers({ 'x-moz': 'prefetch' }))).toBe(true);
    expect(isPrefetchRequest(new Headers({ 'user-agent': BROWSER }))).toBe(false);
  });
});
