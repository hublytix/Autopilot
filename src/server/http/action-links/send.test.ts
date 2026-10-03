import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { useTestDb } from '../../../../test/db/harness';
import { escapeHtml } from '@/server/http/auth/html';
import { createJobRegistry } from '@/server/jobs';
import { createJobTestRig, TEST_START, type JobTestRig } from '@/server/jobs/testing';
import { generateActionToken, revokeTokens } from '@/server/security/action-tokens';
import { NONCE_HEADER } from '@/server/security/csp';
import { clickStateOf, SAMPLE_REPLY, seedSendableLead, type SeedSendableLeadInput, type SendableLead } from '@/server/services/action-links/testing';
import { handleBeacon, handleSendLink } from '.';

// GET /a/{token}/send route tests (PLAN §7.4, §12 route tests with real Requests): every branch of
// D-13's target choice and D-26's click heuristic, the token checks and the /a/* rate limits.

const APP = 'http://localhost:3000';
const MINUTE = 60_000;
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const ANDROID_OUTLOOK_APP =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.7204.157 Mobile Safari/537.36';
const PROXY_NONCE = 'cHJveHktbm9uY2UtMTIzNA==';

const vectors = z
  .object({ vectors: z.array(z.object({ id: z.string(), input: z.object({ to: z.array(z.string()), bcc: z.array(z.string()), subject: z.string(), body: z.string() }), expected: z.record(z.string(), z.string()) })) })
  .parse(JSON.parse(readFileSync(path.join(process.cwd(), 'test/fixtures/compose-vectors.json'), 'utf8'))).vectors;
function vector(id: string): (typeof vectors)[number] {
  const found = vectors.find((v) => v.id === id);
  if (found === undefined) throw new Error(`${id} missing`);
  return found;
}
function expectedUrl(id: string, variant: string): string {
  const url = vector(id).expected[variant];
  if (url === undefined) throw new Error(`${id}.${variant} missing`);
  return url;
}

interface RequestOptions {
  ua?: string | null;
  method?: string;
  ip?: string;
  query?: string;
  headers?: Record<string, string>;
}

function sendRequest(token: string, options: RequestOptions = {}): Request {
  const headers: Record<string, string> = { 'x-real-ip': options.ip ?? '203.0.113.7', ...options.headers };
  const ua = options.ua === undefined ? DESKTOP : options.ua;
  if (ua !== null) headers['user-agent'] = ua;
  return new Request(`${APP}/a/${token}/send${options.query ?? ''}`, { method: options.method ?? 'GET', headers });
}

function beaconRequest(token: string, nonce: string, options: { ua?: string; origin?: string } = {}): Request {
  return new Request(`${APP}/a/${token}/beacon`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: options.origin ?? APP, 'user-agent': options.ua ?? IPHONE, 'x-real-ip': '203.0.113.7' },
    body: JSON.stringify({ n: nonce }),
  });
}

describe('GET /a/{token}/send', () => {
  const getDb = useTestDb();
  let rig: JobTestRig;

  beforeEach(() => {
    rig = createJobTestRig(getDb(), createJobRegistry(), { start: TEST_START });
  });

  /** A lead whose new-lead email went out 5 minutes ago (clicks count without a beacon). */
  async function seed(input: Partial<SeedSendableLeadInput> = {}): Promise<SendableLead> {
    return seedSendableLead(getDb(), { now: rig.clock.now(), sentAt: new Date(TEST_START.getTime() - 5 * MINUTE), ...input });
  }

  async function send(token: string, options: RequestOptions = {}): Promise<Response> {
    return handleSendLink(sendRequest(token, options), rig.deps, token);
  }

  function expectPrivate(res: Response): void {
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
  }

  function dataNonce(html: string): string {
    const match = /data-nonce="([A-Za-z0-9_-]{22})"/.exec(html);
    if (match?.[1] === undefined) throw new Error('no beacon nonce in the page');
    return match[1];
  }

  describe('desktop Gmail and Outlook: 302 to the web compose URL', () => {
    it('redirects a desktop Gmail owner with 302 to the TV1 Gmail URL, byte for byte, and records the click', async () => {
      const lead = await seed({ mailClient: 'gmail' });
      const res = await send(lead.sendToken);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(expectedUrl('TV1', 'gmail_u'));
      expectPrivate(res);
      expect(await clickStateOf(getDb(), lead)).toEqual({ firstSendClickedAt: TEST_START, useCount: 1, firstUsedAt: TEST_START });
    });

    it("selects the owner's Gmail account and carries a plus-addressed lead and the BCC address (TV2)", async () => {
      const tv2 = vector('TV2').input;
      const lead = await seed({
        mailClient: 'gmail',
        gmailAccount: 'sam@acme.com',
        recipient: tv2.to[0],
        bcc: tv2.bcc[0],
        subject: tv2.subject,
        body: tv2.body,
      });
      const res = await send(lead.sendToken);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(expectedUrl('TV2', 'gmail_u_account'));
    });

    it('uses the view=cm form when COMPOSE_GMAIL_FORM=view', async () => {
      rig = createJobTestRig(getDb(), createJobRegistry(), { start: TEST_START, env: { COMPOSE_GMAIL_FORM: 'view' } });
      const lead = await seed({ mailClient: 'gmail' });
      const res = await send(lead.sendToken);
      expect(res.headers.get('location')).toBe(expectedUrl('TV1', 'gmail_view'));
    });

    it('redirects Outlook (work or school) and Outlook (personal) owners to their mailtouri deeplinks', async () => {
      const work = await seed({ mailClient: 'outlook_work' });
      const workRes = await send(work.sendToken);
      expect(workRes.status).toBe(302);
      expect(workRes.headers.get('location')).toBe(expectedUrl('TV1', 'outlook_work'));

      const personal = await seed({ mailClient: 'outlook_personal' });
      const personalRes = await send(personal.sendToken);
      expect(personalRes.status).toBe(302);
      expect(personalRes.headers.get('location')).toBe(expectedUrl('TV1', 'outlook_personal'));
    });

    it('redirects the inbox check test lead like any lead', async () => {
      const lead = await seed({ mailClient: 'gmail', isTest: true });
      const res = await send(lead.sendToken);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(expectedUrl('TV1', 'gmail_u'));
    });
  });

  describe('phone, "Other" and ?via=mailto: the 200 mailto interstitial', () => {
    it('gives a phone a page that opens the mailto: URL from a nonce\'d script and posts the beacon', async () => {
      const lead = await seed({ mailClient: 'gmail', bcc: '1234567@bcc.hubspot.com' });
      const res = await send(lead.sendToken, { ua: IPHONE, headers: { [NONCE_HEADER]: PROXY_NONCE } });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expectPrivate(res);
      // The proxy's policy applies; the page does not send one of its own.
      expect(res.headers.get('content-security-policy')).toBeNull();
      const html = await res.text();
      const mailto = `mailto:jane@example.com?bcc=1234567@bcc.hubspot.com&subject=Re%3A%20Your%20enquiry&body=Hi%20Jane%2C%0D%0A%0D%0AThanks%20for%20reaching%20out.%0D%0A%0D%0ABest%2C%0D%0ASam`;
      expect(html).toContain(`id="ap-open" href="${escapeHtml(mailto)}"`);
      expect(html).toContain(`<script nonce="${PROXY_NONCE}">`);
      expect(html).toContain('window.location.href=href');
      expect(html).toContain(`data-beacon="/a/${lead.sendToken}/beacon"`);
      expect(html).toContain(`href="/a/${lead.sendToken}/copy">Copy your reply</a>`);
      // D-46: the BCC address is shown as a manual fallback.
      expect(html).toContain('<strong>BCC:</strong> 1234567@bcc.hubspot.com');
      // The only script is the page's own: no lead or draft text inside it.
      const scripts = html.match(/<script[\s\S]*?<\/script>/g) ?? [];
      expect(scripts).toHaveLength(1);
      expect(scripts[0]).not.toContain('jane@example.com');
      // A nonce for the beacon was issued.
      expect(dataNonce(html)).toHaveLength(22);
    });

    it('brings its own CSP when no proxy nonce is present', async () => {
      const lead = await seed({ mailClient: 'other' });
      const res = await send(lead.sendToken);
      expect(res.status).toBe(200);
      const html = await res.text();
      const scriptNonce = /<script nonce="([^"]+)">/.exec(html)?.[1];
      expect(scriptNonce).toBeDefined();
      expect(res.headers.get('content-security-policy')).toContain(`script-src 'nonce-${scriptNonce ?? ''}'`);
    });

    it('gives the "Other" mail client the interstitial on a desktop too', async () => {
      const lead = await seed({ mailClient: 'other' });
      const res = await send(lead.sendToken);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(`href="${escapeHtml(expectedUrl('TV1', 'mailto'))}"`);
    });

    it('gives ?via=mailto (the email\'s "Open in default mail app") the interstitial', async () => {
      const lead = await seed({ mailClient: 'outlook_work' });
      const res = await send(lead.sendToken, { query: '?via=mailto' });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(`href="${escapeHtml(expectedUrl('TV1', 'mailto'))}"`);
    });

    it("gives an Outlook app's in-app browser on Android the interstitial", async () => {
      const lead = await seed({ mailClient: 'outlook_personal' });
      const res = await send(lead.sendToken, { ua: ANDROID_OUTLOOK_APP });
      expect(res.status).toBe(200);
    });

    it('escapes lead-controlled text on the page', async () => {
      const lead = await seed({ mailClient: 'other', subject: 'Re: <script>alert(1)</script> & "quotes"' });
      const html = await (await send(lead.sendToken)).text();
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('Re: &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;');
    });
  });

  describe('the copy page instead of a compose link', () => {
    const longBody = `Hi Jane,\n\n${Array.from({ length: 200 }, (_, i) => 'Thanks for reaching out about the kitchen remodel quote and timing for next month'.split(' ')[i % 15]).join(' ')}\n\nBest,\nSam`;

    it('sends a draft whose Outlook URL is over 1,800 characters to the copy page, per client', async () => {
      const outlook = await seed({ mailClient: 'outlook_work', recipient: 'jane.doe@acme-industries.com', bcc: '12345678@bcc.example-crm.com', body: longBody });
      const res = await send(outlook.sendToken);
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`/a/${outlook.sendToken}/copy`);
      expectPrivate(res);
      // The click still counts: the owner opened the send link.
      expect((await clickStateOf(getDb(), outlook)).firstSendClickedAt).toEqual(TEST_START);

      // The same draft fits Gmail's shorter URL (1,755 characters).
      const gmail = await seed({ mailClient: 'gmail', recipient: 'jane.doe@acme-industries.com', bcc: '12345678@bcc.example-crm.com', body: longBody });
      const gmailRes = await send(gmail.sendToken);
      expect(gmailRes.status).toBe(302);
      expect(gmailRes.headers.get('location')?.length).toBeLessThanOrEqual(1800);
    });

    it('sends a phone to the copy page when even the mailto: URL is too long', async () => {
      const lead = await seed({ mailClient: 'gmail', body: `${longBody}\n${longBody}` });
      const res = await send(lead.sendToken, { ua: IPHONE });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`/a/${lead.sendToken}/copy`);
    });

    it('never builds a compose link for a recipient that is not one bare address', async () => {
      for (const recipient of ['jane@example.com;evil@example.net', 'Jane <jane@example.com>', 'jane@example.com\r\nbcc: evil@example.net']) {
        const lead = await seed({ mailClient: 'gmail', recipient });
        const res = await send(lead.sendToken);
        expect(res.status).toBe(303);
        expect(res.headers.get('location')).toBe(`/a/${lead.sendToken}/copy`);
      }
    });
  });

  describe('expired content and unusable tokens', () => {
    it('shows "This draft has expired" once the draft is purged', async () => {
      const lead = await seed();
      await getDb().query(`update drafts set subject = null, body = null, flags = '{}', purged_at = $2 where id = $1`, [lead.draftId, TEST_START]);
      const res = await send(lead.sendToken);
      expect(res.status).toBe(410);
      expectPrivate(res);
      const page = await res.text();
      expect(page).toContain('This draft has expired');
      // Retention runs from submittedAt (purge_at, D-49), not from when the lead reached us.
      expect(page).toContain('deleted 30 days after the form was submitted (24 hours for test leads)');
      expect(page).not.toContain('after the lead arrives');
      expect((await clickStateOf(getDb(), lead)).useCount).toBe(0);
    });

    it("shows \"This draft has expired\" once the lead's content is purged", async () => {
      const lead = await seed();
      await getDb().query(`delete from lead_messages where lead_id = $1`, [lead.leadId]);
      const res = await send(lead.sendToken);
      expect(res.status).toBe(410);
      expect(await res.text()).toContain('This draft has expired');
    });

    it('answers a revoked, expired, unknown, malformed or wrong-purpose token with the same neutral 404 page', async () => {
      const lead = await seed();
      const other = await seed();
      await revokeTokens(getDb(), { tokens: [other.sendToken], now: TEST_START });

      const pages: string[] = [];
      for (const token of [other.sendToken, generateActionToken(), 'apt_short', lead.editToken, lead.dismissToken]) {
        const res = await send(token);
        expect(res.status).toBe(404);
        expectPrivate(res);
        pages.push(await res.text());
      }
      rig.clock.advance({ days: 7 });
      const expired = await send(lead.sendToken, { ip: '203.0.113.8' });
      expect(expired.status).toBe(404);
      pages.push(await expired.text());
      expect(new Set(pages).size).toBe(1);
      expect(pages[0]).toContain('This link isn&#39;t available');
      expect(pages[0]).not.toContain('jane@example.com');
    });

    it('refuses tokens of a disconnected account or one pending purge', async () => {
      const lead = await seed();
      await getDb().query(`update accounts set purge_after = $2 where id = $1`, [lead.accountId, new Date(TEST_START.getTime() + 30 * 86_400_000)]);
      expect((await send(lead.sendToken)).status).toBe(404);
    });
  });

  describe("D-26: what counts as the owner's click", () => {
    it('does not record a HEAD', async () => {
      const lead = await seed({ mailClient: 'gmail' });
      const res = await send(lead.sendToken, { method: 'HEAD' });
      expect(res.status).toBe(302);
      expect(await clickStateOf(getDb(), lead)).toEqual({ firstSendClickedAt: null, useCount: 0, firstUsedAt: null });
    });

    it('issues no beacon nonce for a HEAD of the interstitial', async () => {
      const lead = await seed({ mailClient: 'other' });
      const before = await getDb().one<{ n: number }>(`select count(*)::int as n from rate_limits`);
      const res = await send(lead.sendToken, { method: 'HEAD' });
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain('data-nonce="');
      const after = await getDb().one<{ n: number }>(`select count(*)::int as n from rate_limits`);
      // Only the two /a/* rate-limit counters were written.
      expect(after.n - before.n).toBe(2);
    });

    it.each([
      ['a link scanner', 'Mimecast-URL-Protect/1.0'],
      ['a preview bot', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'],
      ['an HTTP library', 'python-requests/2.32.3'],
      ['a headless browser', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/138.0.0.0 Safari/537.36'],
      ['no user agent', null],
    ])('does not record %s, but still answers', async (_name, ua) => {
      const lead = await seed({ mailClient: 'gmail' });
      const res = await send(lead.sendToken, { ua });
      expect(res.status).toBe(302);
      expect((await clickStateOf(getDb(), lead)).firstSendClickedAt).toBeNull();
    });

    it('does not record a prefetch', async () => {
      const lead = await seed({ mailClient: 'gmail' });
      await send(lead.sendToken, { headers: { 'sec-purpose': 'prefetch' } });
      expect((await clickStateOf(getDb(), lead)).firstSendClickedAt).toBeNull();
    });

    it('does not record a hit within 60 s of the email being sent, and records one at 60 s', async () => {
      const lead = await seed({ mailClient: 'gmail', sentAt: TEST_START });
      rig.clock.advance(59_999);
      await send(lead.sendToken);
      expect((await clickStateOf(getDb(), lead)).firstSendClickedAt).toBeNull();
      rig.clock.advance(1);
      await send(lead.sendToken);
      expect(await clickStateOf(getDb(), lead)).toEqual({ firstSendClickedAt: rig.clock.now(), useCount: 1, firstUsedAt: rig.clock.now() });
    });

    it('records a hit within 60 s when the interstitial posts its beacon', async () => {
      const lead = await seed({ mailClient: 'gmail', sentAt: TEST_START });
      rig.clock.advance(5_000);
      const page = await send(lead.sendToken, { ua: IPHONE });
      expect(page.status).toBe(200);
      expect((await clickStateOf(getDb(), lead)).firstSendClickedAt).toBeNull();

      const nonce = dataNonce(await page.text());
      rig.clock.advance(1_000);
      const beacon = await handleBeacon(beaconRequest(lead.sendToken, nonce), rig.deps, lead.sendToken);
      expect(beacon.status).toBe(204);
      expect(await clickStateOf(getDb(), lead)).toEqual({ firstSendClickedAt: rig.clock.now(), useCount: 1, firstUsedAt: rig.clock.now() });
    });

    it('needs the beacon when the email has no recorded send time', async () => {
      const lead = await seed({ mailClient: 'gmail', sentAt: null });
      rig.clock.advance({ hours: 2 });
      await send(lead.sendToken);
      expect((await clickStateOf(getDb(), lead)).firstSendClickedAt).toBeNull();
    });

    it('keeps the first click time and counts every later click', async () => {
      const lead = await seed({ mailClient: 'gmail' });
      await send(lead.sendToken);
      rig.clock.advance({ minutes: 3 });
      await send(lead.sendToken);
      expect(await clickStateOf(getDb(), lead)).toEqual({ firstSendClickedAt: TEST_START, useCount: 2, firstUsedAt: TEST_START });
    });
  });

  describe('/a/* rate limits (D-36)', () => {
    it('allows 20 requests a minute per token, then answers 429 with Retry-After', async () => {
      const lead = await seed({ mailClient: 'gmail' });
      for (let i = 0; i < 20; i++) {
        expect((await send(lead.sendToken, { ip: `198.51.100.${i}` })).status).toBe(302);
      }
      const limited = await send(lead.sendToken, { ip: '198.51.100.99' });
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBe('60');
      expectPrivate(limited);
      expect(await limited.text()).toContain('Too many attempts');
      // The next minute's window starts afresh.
      rig.clock.advance({ minutes: 1 });
      expect((await send(lead.sendToken, { ip: '198.51.100.99' })).status).toBe(302);
    });

    it('allows 30 requests a minute per IP across tokens, then answers 429', async () => {
      for (let i = 0; i < 30; i++) {
        expect((await send(generateActionToken(), { ip: '192.0.2.10' })).status).toBe(404);
      }
      const lead = await seed({ mailClient: 'gmail' });
      expect((await send(lead.sendToken, { ip: '192.0.2.10' })).status).toBe(429);
      expect((await send(lead.sendToken, { ip: '192.0.2.11' })).status).toBe(302);
    });
  });

  describe('privacy (law 4)', () => {
    const spies: ReturnType<typeof vi.spyOn>[] = [];
    afterEach(() => {
      for (const spy of spies.splice(0)) spy.mockRestore();
    });

    it('never logs the token, the compose URL, the address or the draft', async () => {
      const lines: string[] = [];
      const capture = (...args: unknown[]): void => {
        lines.push(args.map(String).join(' '));
      };
      spies.push(vi.spyOn(console, 'log').mockImplementation(capture), vi.spyOn(console, 'error').mockImplementation(capture));
      const lead = await seed({ mailClient: 'gmail' });
      await send(lead.sendToken);
      await send(lead.sendToken, { ua: IPHONE });
      await send(lead.sendToken, { query: '?via=mailto', ua: 'curl/8.7.1' });
      expect(lines.length).toBeGreaterThan(0);
      const all = lines.join('\n');
      for (const secret of [lead.sendToken, SAMPLE_REPLY.recipient, 'mail.google.com', 'mailto:', 'Your enquiry', 'Thanks for reaching out']) {
        expect(all).not.toContain(secret);
      }
    });
  });
});
