import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTestDb } from '../../../../test/db/harness';
import { buildCompose, buildMailto } from '@/server/domain/compose';
import { createJobRegistry } from '@/server/jobs';
import { createJobTestRig, TEST_START, type JobTestRig } from '@/server/jobs/testing';
import { generateActionToken, revokeTokens } from '@/server/security/action-tokens';
import { SAMPLE_REPLY, seedSendableLead, type SeedSendableLeadInput, type SendableLead } from '@/server/services/action-links/testing';
import { SAMPLE_BOOKING_LINK, seedBrief } from '@/server/services/drafting/testing';
import { handleBeacon } from './beacon';
import { EDIT_CROSS_ORIGIN_MESSAGE, EDIT_HINTS, EDIT_INPUT_ERRORS, editPageState, submitEditForm, type EditFormState, type EditReadyView } from './edit';
import { ACTION_LINK_MESSAGES } from './messages';

// /a/{token}/edit route tests (PLAN §7.4, §12 route tests with real Requests; D-13, D-26, D-47): the
// GET page state and the POST the page's Server Action hands over, built from real Requests (their
// headers and their parsed form data).

const APP = 'http://localhost:3000';
const MINUTE = 60_000;
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const SCANNER = 'Mozilla/5.0 (compatible; Barracuda Sentinel (EE))';
/** A string that must never reach the database or the logs. */
const MARKER = 'Zebra-crossing-7731';

interface PostOptions {
  ip?: string;
  ua?: string;
  origin?: string | null;
  secFetchSite?: string;
  chUaMobile?: string;
}

function headersFor(options: PostOptions = {}): Record<string, string> {
  const headers: Record<string, string> = { 'x-real-ip': options.ip ?? '203.0.113.7', 'user-agent': options.ua ?? DESKTOP };
  if (options.origin !== null) headers.origin = options.origin ?? APP;
  if (options.secFetchSite !== undefined) headers['sec-fetch-site'] = options.secFetchSite;
  if (options.chUaMobile !== undefined) headers['sec-ch-ua-mobile'] = options.chUaMobile;
  return headers;
}

function getRequest(token: string, ip = '203.0.113.7'): Request {
  return new Request(`${APP}/a/${token}/edit`, { headers: { 'x-real-ip': ip, 'user-agent': DESKTOP } });
}

function postRequest(token: string, fields: { subject?: string; body?: string }, options: PostOptions = {}): Request {
  const form = new FormData();
  form.set('token', token);
  if (fields.subject !== undefined) form.set('subject', fields.subject);
  if (fields.body !== undefined) form.set('body', fields.body);
  return new Request(`${APP}/a/${token}/edit`, { method: 'POST', headers: headersFor(options), body: form });
}

function ready(state: EditFormState): EditReadyView {
  if (state.type !== 'ready') throw new Error(`expected ready, got ${JSON.stringify(state)}`);
  return state.reply;
}

describe('/a/{token}/edit', () => {
  const getDb = useTestDb();
  let rig: JobTestRig;

  beforeEach(() => {
    rig = createJobTestRig(getDb(), createJobRegistry(), { start: TEST_START });
  });

  /** A lead whose new-lead email went out 5 minutes ago. */
  async function seed(input: Partial<SeedSendableLeadInput> = {}): Promise<SendableLead> {
    return seedSendableLead(getDb(), { now: rig.clock.now(), sentAt: new Date(TEST_START.getTime() - 5 * MINUTE), ...input });
  }

  async function open(token: string, ip?: string) {
    const req = getRequest(token, ip);
    return editPageState(rig.deps, token, req.headers);
  }

  async function submit(token: string, fields: { subject?: string; body?: string }, options: PostOptions = {}): Promise<EditFormState> {
    const req = postRequest(token, fields, options);
    return submitEditForm(rig.deps, token, { headers: req.headers, formData: await req.formData() });
  }

  async function clicksOf(lead: SendableLead): Promise<{ firstSendClickedAt: Date | null; editUses: number; editFirstUsedAt: Date | null }> {
    const row = await getDb().one<{ first_send_clicked_at: Date | null; use_count: number; first_used_at: Date | null }>(
      `select l.first_send_clicked_at, t.use_count, t.first_used_at
         from leads l join action_tokens t on t.lead_id = l.id and t.purpose = 'edit'
        where l.id = $1`,
      [lead.leadId],
    );
    return { firstSendClickedAt: row.first_send_clicked_at, editUses: row.use_count, editFirstUsedAt: row.first_used_at };
  }

  function gmailUrl(to: string, subject: string, body: string, bcc: string[] = []): string {
    const { env } = rig.deps;
    return buildCompose({
      client: 'gmail',
      to: [to],
      bcc,
      subject,
      body,
      gmailAccount: null,
      gmailForm: env.COMPOSE_GMAIL_FORM,
      outlookMode: env.COMPOSE_OUTLOOK_MODE,
      outlookWorkBase: env.COMPOSE_OUTLOOK_WORK_BASE,
      outlookPersonalBase: env.COMPOSE_OUTLOOK_PERSONAL_BASE,
    }).url;
  }

  describe('GET: the edit form', () => {
    it("pre-fills the draft, shows the lead's message defanged and the BCC address, and records nothing", async () => {
      const lead = await seed({ bcc: '1234567@bcc.hubspot.com' });
      await getDb().query(`update lead_messages set message = $2 where lead_id = $1`, [
        lead.leadId,
        'Please call me.\nSee https://evil.example/pay or write to bob@evil.example‮ today',
      ]);
      const state = await open(lead.editToken);
      if (state.type !== 'edit') throw new Error(`unexpected ${state.type}`);
      expect(state.view).toMatchObject({
        recipient: SAMPLE_REPLY.recipient,
        recipientValid: true,
        subject: SAMPLE_REPLY.subject,
        body: SAMPLE_REPLY.body,
        bcc: '1234567@bcc.hubspot.com',
        leadMessage: 'Please call me.\nSee hxxps://evil[.]example/pay or write to bob[@]evil[.]example today',
      });
      expect(state.view.beaconNonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(state.beaconPath).toBe(`/a/${lead.editToken}/beacon`);
      expect(state.neverSends).toContain('never sends email for you');
      expect(state.limits).toEqual({ subjectMaxChars: 300, bodyMaxChars: 10_000 });
      // A scanner opening the link counts for nothing.
      expect(await clicksOf(lead)).toEqual({ firstSendClickedAt: null, editUses: 0, editFirstUsedAt: null });
    });

    it("says when the lead wrote no message", async () => {
      const lead = await seed();
      await getDb().query(`update lead_messages set message = null where lead_id = $1`, [lead.leadId]);
      const state = await open(lead.editToken);
      expect(state.type === 'edit' && state.view.leadMessage).toBeNull();
    });

    it("counts the click when the page's beacon arrives (a person's first gesture)", async () => {
      const lead = await seed({ sentAt: TEST_START });
      const state = await open(lead.editToken);
      if (state.type !== 'edit') throw new Error(`unexpected ${state.type}`);
      const beacon = new Request(`${APP}${state.beaconPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: APP, 'user-agent': IPHONE, 'x-real-ip': '203.0.113.7' },
        body: JSON.stringify({ n: state.view.beaconNonce }),
      });
      expect((await handleBeacon(beacon, rig.deps, lead.editToken)).status).toBe(204);
      expect(await clicksOf(lead)).toEqual({ firstSendClickedAt: TEST_START, editUses: 1, editFirstUsedAt: TEST_START });
    });

    it('shows "This draft has expired" once the draft or the lead content is purged', async () => {
      const purgedDraft = await seed();
      await getDb().query(`update drafts set subject = null, body = null, purged_at = $2 where lead_id = $1`, [purgedDraft.leadId, TEST_START]);
      expect(await open(purgedDraft.editToken)).toEqual({ type: 'message', message: ACTION_LINK_MESSAGES.expired });

      const purgedContent = await seed();
      await getDb().query(`delete from lead_messages where lead_id = $1`, [purgedContent.leadId]);
      expect(await open(purgedContent.editToken)).toEqual({ type: 'message', message: ACTION_LINK_MESSAGES.expired });
    });

    it('shows the neutral page for a token of another purpose, an unknown or malformed token, and a revoked or expired one', async () => {
      const lead = await seed();
      const invalid = { type: 'message', message: ACTION_LINK_MESSAGES.invalid };
      expect(await open(lead.sendToken)).toEqual(invalid);
      expect(await open(lead.dismissToken)).toEqual(invalid);
      expect(await open(generateActionToken())).toEqual(invalid);
      expect(await open('apt_short')).toEqual(invalid);

      const revoked = await seed();
      await revokeTokens(getDb(), { tokens: [revoked.editToken], now: TEST_START });
      expect(await open(revoked.editToken)).toEqual(invalid);

      rig.clock.advance({ days: 8 });
      expect(await open(lead.editToken)).toEqual(invalid);
    });

    it('allows 20 requests a minute per token and 30 per IP across /a/*', async () => {
      const lead = await seed();
      for (let i = 0; i < 20; i += 1) expect((await open(lead.editToken)).type).toBe('edit');
      expect(await open(lead.editToken)).toEqual({ type: 'message', message: ACTION_LINK_MESSAGES.rateLimited });
      // Another IP is limited by the token's count too; a minute later the token works again.
      expect(await open(lead.editToken, '198.51.100.9')).toEqual({ type: 'message', message: ACTION_LINK_MESSAGES.rateLimited });
      rig.clock.advance({ minutes: 1 });
      expect((await open(lead.editToken, '198.51.100.9')).type).toBe('edit');

      const a = await seed();
      const b = await seed();
      for (let i = 0; i < 15; i += 1) expect((await open(a.editToken, '192.0.2.1')).type).toBe('edit');
      for (let i = 0; i < 15; i += 1) expect((await open(b.editToken, '192.0.2.1')).type).toBe('edit');
      expect(await open(b.editToken, '192.0.2.1')).toEqual({ type: 'message', message: ACTION_LINK_MESSAGES.rateLimited });
      // The POST shares the same counts.
      expect(await submit(b.editToken, { subject: 'Hi', body: 'Hello' }, { ip: '192.0.2.1' })).toEqual({
        type: 'message',
        message: ACTION_LINK_MESSAGES.rateLimited,
      });
    });
  });

  describe('POST: the result page', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('builds "Send from my email" and "Open in default mail app" from the EDITED text and records the click', async () => {
      const lead = await seed({ mailClient: 'gmail', bcc: '1234567@bcc.hubspot.com' });
      const subject = 'Re: Your kitchen quote';
      const body = 'Hi Jane,\r\n\r\nThanks! I can come on Tuesday at 10.\r\n\r\nSam';
      const reply = ready(await submit(lead.editToken, { subject, body }));
      const lf = body.replace(/\r\n/g, '\n');
      expect(reply).toMatchObject({
        recipient: SAMPLE_REPLY.recipient,
        recipientValid: true,
        subject,
        body: lf,
        bcc: '1234567@bcc.hubspot.com',
        sendTarget: 'Gmail',
        copyReason: null,
      });
      expect(reply.sendUrl).toBe(gmailUrl(SAMPLE_REPLY.recipient, subject, lf, ['1234567@bcc.hubspot.com']));
      expect(reply.mailtoUrl).toBe(buildMailto({ to: [SAMPLE_REPLY.recipient], bcc: ['1234567@bcc.hubspot.com'], subject, body: lf }).url);
      expect(reply.sendUrl).toContain(encodeURIComponent('I can come on Tuesday at 10.'));
      expect(reply.sendUrl).not.toContain(encodeURIComponent('Thanks for reaching out'));
      // The POST is a person's action: the click counts at once, on the edit token.
      expect(await clicksOf(lead)).toEqual({ firstSendClickedAt: TEST_START, editUses: 1, editFirstUsedAt: TEST_START });
    });

    it('stores and logs nothing of the edited text', async () => {
      const lines: string[] = [];
      for (const method of ['log', 'info', 'warn', 'error'] as const) {
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          lines.push(args.map(String).join(' '));
        });
      }
      const lead = await seed({ mailClient: 'outlook_work' });
      const before = await getDb().one<{ subject: string; body: string }>(`select subject, body from drafts where id = $1`, [lead.draftId]);
      const reply = ready(await submit(lead.editToken, { subject: `Subject ${MARKER}`, body: `Hi Jane,\n\n${MARKER} works for us.\n\nSam` }));
      expect(reply.sendUrl).toContain(MARKER);

      expect(await getDb().one(`select subject, body from drafts where id = $1`, [lead.draftId])).toEqual(before);
      const tables = await getDb().query<{ table_name: string }>(
        `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
      );
      expect(tables.length).toBeGreaterThan(10);
      for (const { table_name } of tables) {
        const hits = await getDb().query(`select 1 from public."${table_name}" t where t::text like $1 limit 1`, [`%${MARKER}%`]);
        expect(hits, table_name).toEqual([]);
      }
      expect(lines.some((line) => line.includes('action_link.edit'))).toBe(true);
      expect(lines.join('\n')).not.toContain(MARKER);
      expect(lines.join('\n')).not.toContain(lead.editToken);
      expect(lines.join('\n')).not.toContain(SAMPLE_REPLY.recipient);
    });

    it('gives a phone the mailto: link as "Send from my email", once', async () => {
      const lead = await seed({ mailClient: 'gmail' });
      const reply = ready(await submit(lead.editToken, { subject: 'Hello', body: 'Hi Jane,\n\nSee you soon.' }, { ua: IPHONE }));
      expect(reply.sendUrl).toBe(buildMailto({ to: [SAMPLE_REPLY.recipient], bcc: [], subject: 'Hello', body: 'Hi Jane,\n\nSee you soon.' }).url);
      expect(reply.sendTarget).toBe('your mail app');
      expect(reply.mailtoUrl).toBeNull();

      const other = await seed({ mailClient: 'other' });
      expect(ready(await submit(other.editToken, { subject: 'Hello', body: 'Hi Jane' })).sendUrl).toMatch(/^mailto:/);
    });

    it('shows the copy view when the edited reply is too long for a compose link', async () => {
      const lead = await seed({ mailClient: 'gmail' });
      const body = `Hi Jane,\n\n${'This is a long reply. '.repeat(120)}\n\nSam`;
      const reply = ready(await submit(lead.editToken, { subject: 'Long one', body }));
      expect(reply).toMatchObject({ sendUrl: null, sendTarget: null, copyReason: 'too_long', mailtoUrl: null, recipientValid: true, body: body.trim() });
      // Still the owner's action.
      expect((await clicksOf(lead)).firstSendClickedAt).toEqual(TEST_START);
    });

    it('shows the copy view and asks to check an unusual address', async () => {
      const lead = await seed({ recipient: 'jane@example.com, evil@example.net' });
      const reply = ready(await submit(lead.editToken, { subject: 'Hello', body: 'Hi Jane' }));
      expect(reply).toMatchObject({ recipient: 'jane@example.com, evil@example.net', recipientValid: false, sendUrl: null, copyReason: 'invalid_recipient', mailtoUrl: null });
    });

    it("shows the draft validator's codes as hints and never blocks the send", async () => {
      const lead = await seed();
      await seedBrief(getDb(), lead.accountId);
      const reply = ready(
        await submit(lead.editToken, {
          subject: 'Your enquiry',
          body: 'Hi [Name],\n\nDetails are at https://other-site.example/offer — call 0161 555 0199.\n\nSam',
        }),
      );
      expect(reply.hints.map((hint) => hint.code)).toEqual(['placeholder', 'missing_first_name', 'missing_booking_link', 'url_not_allowed', 'contact_not_allowed']);
      expect(reply.hints[0]).toEqual({ code: 'placeholder', text: EDIT_HINTS.placeholder });
      expect(reply.sendUrl).not.toBeNull();
      expect((await clicksOf(lead)).firstSendClickedAt).toEqual(TEST_START);
    });

    it('has no hints for a clean edit', async () => {
      const lead = await seed();
      await seedBrief(getDb(), lead.accountId);
      const reply = ready(await submit(lead.editToken, { subject: 'Your enquiry', body: `Hi Jane,\n\nPick a time here: ${SAMPLE_BOOKING_LINK}\n\nDana` }));
      expect(reply.hints).toEqual([]);
    });

    it('refuses only an empty or oversized subject or reply, keeps what was typed and records nothing', async () => {
      const lead = await seed();
      expect(await submit(lead.editToken, { subject: '   ', body: 'Hi Jane' })).toEqual({
        type: 'input_error',
        errors: { subject: EDIT_INPUT_ERRORS.subject_required },
        subject: '',
        body: 'Hi Jane',
      });
      expect(await submit(lead.editToken, {})).toEqual({
        type: 'input_error',
        errors: { subject: EDIT_INPUT_ERRORS.subject_required, body: EDIT_INPUT_ERRORS.body_required },
        subject: '',
        body: '',
      });
      const long = 'x'.repeat(10_001);
      const state = await submit(lead.editToken, { subject: 's'.repeat(301), body: long });
      expect(state).toEqual({
        type: 'input_error',
        errors: { subject: EDIT_INPUT_ERRORS.subject_too_long, body: EDIT_INPUT_ERRORS.body_too_long },
        subject: 's'.repeat(301),
        body: long,
      });
      // At the limits (counted in characters, so an emoji is one) it is accepted.
      expect((await submit(lead.editToken, { subject: '🙂'.repeat(300), body: 'é'.repeat(10_000) })).type).toBe('ready');
      expect(await clicksOf(lead)).toMatchObject({ editUses: 1 });
    });

    it('refuses a POST from another site, and one with neither Origin nor Sec-Fetch-Site', async () => {
      const lead = await seed();
      expect(await submit(lead.editToken, { subject: 'Hi', body: 'Hi Jane' }, { origin: 'https://evil.example' })).toEqual({
        type: 'message',
        message: EDIT_CROSS_ORIGIN_MESSAGE,
      });
      expect(await submit(lead.editToken, { subject: 'Hi', body: 'Hi Jane' }, { origin: 'https://evil.example', secFetchSite: 'same-origin' })).toEqual({
        type: 'message',
        message: EDIT_CROSS_ORIGIN_MESSAGE,
      });
      expect(await submit(lead.editToken, { subject: 'Hi', body: 'Hi Jane' }, { origin: null })).toEqual({
        type: 'message',
        message: EDIT_CROSS_ORIGIN_MESSAGE,
      });
      expect(await clicksOf(lead)).toEqual({ firstSendClickedAt: null, editUses: 0, editFirstUsedAt: null });
      // Origin: null is vouched for by the browser's Sec-Fetch-Site (D-62).
      expect((await submit(lead.editToken, { subject: 'Hi', body: 'Hi Jane' }, { origin: 'null', secFetchSite: 'same-origin' })).type).toBe('ready');
    });

    it('does not count a scanner user agent, or a prefetch, as a click', async () => {
      const lead = await seed();
      expect((await submit(lead.editToken, { subject: 'Hi', body: 'Hi Jane' }, { ua: SCANNER })).type).toBe('ready');
      expect(await clicksOf(lead)).toEqual({ firstSendClickedAt: null, editUses: 0, editFirstUsedAt: null });
    });

    it('shows the expired page for purged content and the neutral page for a wrong-purpose or revoked token', async () => {
      const lead = await seed();
      await getDb().query(`update drafts set subject = null, body = null, purged_at = $2 where lead_id = $1`, [lead.leadId, TEST_START]);
      expect(await submit(lead.editToken, { subject: 'Hi', body: 'Hi Jane' })).toEqual({ type: 'message', message: ACTION_LINK_MESSAGES.expired });

      const other = await seed();
      const invalid = { type: 'message', message: ACTION_LINK_MESSAGES.invalid };
      expect(await submit(other.sendToken, { subject: 'Hi', body: 'Hi Jane' })).toEqual(invalid);
      await revokeTokens(getDb(), { tokens: [other.editToken], now: TEST_START });
      expect(await submit(other.editToken, { subject: 'Hi', body: 'Hi Jane' })).toEqual(invalid);
      expect((await clicksOf(other)).firstSendClickedAt).toBeNull();
    });

    it('works for the inbox check test lead like any lead', async () => {
      const lead = await seed({ isTest: true });
      expect(ready(await submit(lead.editToken, { subject: 'Test', body: 'Hi there' })).sendUrl).toMatch(/^https:\/\/mail\.google\.com\//);
    });
  });

  describe('headers', () => {
    beforeEach(() => {
      vi.stubEnv('APP_MODE', 'fake');
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', '');
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it.each([
      ['GET', '/a/apt_x/edit'],
      ['POST', '/a/apt_x/edit'],
      ['GET', '/a/apt_x/dismiss'],
      ['POST', '/a/apt_x/dismiss'],
    ])('the proxy sends %s %s private, no-store, noindex, same-origin referrers and a nonce CSP without third parties', async (method, path) => {
      const { proxy } = await import('@/proxy');
      const res = await proxy(new NextRequest(`${APP}${path}`, { method }));
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(res.headers.get('x-robots-tag')).toBe('noindex');
      expect(res.headers.get('referrer-policy')).toBe('same-origin');
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
      expect(csp).toContain("form-action 'self'");
      expect(csp).not.toMatch(/https?:\/\//);
      // Never sent to /login: the token is the authorisation.
      expect(res.headers.get('location')).toBeNull();
    });
  });
});
