// Fake-mode end-to-end run against a real `next start` (PLAN §15 M3 integration, M8 "fake-mode
// end-to-end smoke test"): plain fetch, no browser, no JavaScript — every form is submitted the way
// a browser without JavaScript submits it (Server Actions' progressive-enhancement fields included),
// so this also proves the onboarding works without JavaScript.
//
//   install → fake consent (Approve) → OAuth callback (branch a) → /onboarding/email → magic link
//   (read from fake.dev_outbox) → GET + POST /auth/confirm in a FRESH cookie jar → onboarding pages
//   (brief, forms, preferences, inbox, baseline) → the inbox test email's edit and dismiss links (M4:
//   GET + POST each, no JavaScript) → Finish → /dashboard (M6: the status card, Pause all and Resume
//   as Server Actions without JavaScript) → /dashboard/brief → the inbox check's test lead's page
//   (viewable, marked as the test lead, never listed) and 404s for an unknown or malformed lead id.
//
// The app's PGlite is single-process, so the magic link is read with the server stopped and the
// server is started again on the same FAKE_DB_DIR: the link still works after the restart only
// because fake mode persists the fake auth users and tokens (D-29). Run `APP_MODE=fake npm run
// build` first. Exits non-zero when a check fails. Never calls a live service.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { load, type CheerioAPI } from 'cheerio';
import { createPgliteDb } from '@/server/db/pglite';
import { CookieJar } from '@/server/security/cookies';
import { freePort, get, HOST, startServer, stopServer, waitUntilReady, type NextServer } from './next-server';

interface Check {
  step: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

function check(step: string, ok: boolean, rawDetail: string): boolean {
  // Action tokens never reach the output (law 4), not even the fake run's.
  const detail = rawDetail.replaceAll(/apt_[A-Za-z0-9_-]{43}/g, '{t}');
  checks.push({ step, ok, detail });
  console.log(`e2e: ${ok ? 'PASS' : 'FAIL'} ${step} (${detail})`);
  return ok;
}

/** A browser: a cookie jar, the client IP header the proxy in front of the app would add. */
class Browser {
  readonly jar = new CookieJar();
  constructor(
    readonly baseUrl: string,
    private readonly ip: string,
  ) {}

  async request(pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(pathOrUrl, this.baseUrl).href;
    const headers = new Headers(init.headers);
    headers.set('x-real-ip', this.ip);
    headers.set('user-agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36');
    const cookie = this.jar.header();
    if (cookie !== null) headers.set('cookie', cookie);
    const response = await get(url, { ...init, headers });
    this.jar.storeFrom(response);
    return response;
  }

  async page(pathOrUrl: string): Promise<{ response: Response; html: string; $: CheerioAPI }> {
    const response = await this.request(pathOrUrl);
    const html = await response.text();
    return { response, html, $: load(html) };
  }

  /**
   * Submits the form that contains `selector` as a browser without JavaScript does: every
   * successful control (hidden Server Action fields included) as multipart/form-data, to the form's
   * action or the page itself, with the Origin a browser sends from a `Referrer-Policy: same-origin`
   * page (D-62): the page's own. `values` replace or add fields; `origin` overrides the Origin header.
   */
  async submit($: CheerioAPI, pagePath: string, selector: string, values: Record<string, string | string[] | null> = {}, origin: string = this.baseUrl): Promise<Response> {
    const form = $(selector).closest('form');
    if (form.length === 0) throw new Error(`no form around ${selector}`);
    const data = new FormData();
    const set = new Map<string, string[]>();
    form.find('input, textarea, select').each((_, element) => {
      const control = $(element);
      const name = control.attr('name');
      if (name === undefined || control.attr('disabled') !== undefined) return;
      const type = (control.attr('type') ?? '').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'file') return;
      if ((type === 'checkbox' || type === 'radio') && control.attr('checked') === undefined) return;
      let value: string;
      if (element.tagName === 'textarea') value = control.text();
      else if (element.tagName === 'select') value = control.find('option[selected]').attr('value') ?? control.find('option').first().attr('value') ?? '';
      else value = control.attr('value') ?? (type === 'checkbox' || type === 'radio' ? 'on' : '');
      set.set(name, [...(set.get(name) ?? []), value]);
    });
    for (const [name, value] of Object.entries(values)) {
      if (value === null) set.delete(name);
      else set.set(name, Array.isArray(value) ? value : [value]);
    }
    for (const [name, list] of set) for (const value of list) data.append(name, value);
    const action = form.attr('action');
    const target = action !== undefined && action !== '' && !action.startsWith('javascript:') ? action : pagePath;
    return this.request(target, { method: 'POST', body: data, headers: { origin, 'sec-fetch-site': 'same-origin' } });
  }
}

function locationPath(response: Response, baseUrl: string): string | null {
  const location = response.headers.get('location');
  if (location === null) return null;
  const url = new URL(location, baseUrl);
  return `${url.pathname}${url.search}`;
}

function isPrivate(response: Response): boolean {
  const cache = response.headers.get('cache-control') ?? '';
  return cache.includes('private') && cache.includes('no-store') && (response.headers.get('x-robots-tag') ?? '').includes('noindex');
}

/** Every <script> carries the CSP nonce the response header names. */
function scriptsNonced(response: Response, $: CheerioAPI): { ok: boolean; detail: string } {
  const csp = response.headers.get('content-security-policy') ?? '';
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
  const scripts = $('script').toArray();
  const missing = scripts.filter((script) => $(script).attr('nonce') !== nonce).length;
  return { ok: nonce !== undefined && scripts.length > 0 && missing === 0, detail: `${scripts.length} scripts, ${missing} without the nonce` };
}

/** The edit and dismiss tokens of the newest inbox_test email in fake.dev_outbox (server stopped). */
async function readInboxTestLinks(dataDir: string): Promise<{ edit: string; dismiss: string } | null> {
  const db = createPgliteDb({ dataDir });
  try {
    const row = await db.maybeOne<{ html: string }>(`select html from fake.dev_outbox where kind = 'inbox_test' order by created_at desc, id desc limit 1`);
    const edit = row === null ? null : /\/a\/(apt_[A-Za-z0-9_-]{43})\/edit"/.exec(row.html)?.[1];
    const dismiss = row === null ? null : /\/a\/(apt_[A-Za-z0-9_-]{43})\/dismiss"/.exec(row.html)?.[1];
    return edit === undefined || edit === null || dismiss === undefined || dismiss === null ? null : { edit, dismiss };
  } finally {
    await db.close();
  }
}

/** The inbox check's test lead (the only lead before Day 0) in fake.dev's PGlite (server stopped). */
async function readTestLeadId(dataDir: string): Promise<string | null> {
  const db = createPgliteDb({ dataDir });
  try {
    const row = await db.maybeOne<{ id: string }>(`select id from public.leads where is_test order by received_at desc limit 1`);
    return row?.id ?? null;
  } finally {
    await db.close();
  }
}

/** No cache may store it (a Server Action's answer carries Next's `no-store` without `private`). */
function isNoStore(response: Response): boolean {
  return (response.headers.get('cache-control') ?? '').includes('no-store');
}

async function readMagicLink(dataDir: string): Promise<{ url: string; tokenHash: string; type: string } | null> {
  const db = createPgliteDb({ dataDir });
  try {
    const row = await db.maybeOne<{ text: string }>(`select text from fake.dev_outbox where kind = 'magic_link' order by created_at desc, id desc limit 1`);
    const match = row === null ? null : /(https?:\/\/[^\s"<>]+\/auth\/confirm#th=([A-Za-z0-9_%-]+)&type=([a-z]+))/.exec(row.text);
    if (match === null) return null;
    return { url: match[1] ?? '', tokenHash: decodeURIComponent(match[2] ?? ''), type: match[3] ?? '' };
  } finally {
    await db.close();
  }
}

/** Polls GET /api/onboarding/status once a second (the dev ticker delivers due jobs every 10 s). */
async function waitFor(browser: Browser, what: string, done: (status: Record<string, unknown>) => boolean, seconds = 45): Promise<Record<string, unknown> | null> {
  let status: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt <= seconds; attempt += 1) {
    const response = await browser.request('/api/onboarding/status');
    status = response.status === 200 ? ((await response.json()) as Record<string, unknown>) : null;
    if (status !== null && done(status)) return status;
    await sleep(1_000);
  }
  console.log(`e2e: gave up waiting for ${what}: ${JSON.stringify(status)}`);
  return status;
}

async function run(dataDir: string): Promise<void> {
  const port = await freePort();
  const baseUrl = `http://${HOST}:${port}`;
  const env: NodeJS.ProcessEnv = { ...process.env, APP_MODE: 'fake', APP_URL: baseUrl, FAKE_DB_DIR: dataDir };
  let server: NextServer = startServer(port, env);
  try {
    await waitUntilReady(baseUrl, server);
    const installer = new Browser(baseUrl, '198.51.100.7');

    // 1. Install → fake consent → callback (branch a).
    const install = await installer.request('/api/hubspot/install');
    const consentPath = locationPath(install, baseUrl);
    check('install → fake consent', install.status === 302 && consentPath?.startsWith('/dev/fake-hubspot/authorize?') === true, `${install.status} → ${consentPath?.split('?')[0] ?? 'none'}`);
    const consent = await installer.page(consentPath ?? '/');
    check('consent page', consent.response.status === 200 && consent.html.includes('Approve'), `${consent.response.status}`);
    const decisionBody = new URLSearchParams(new URL(consentPath ?? '/', baseUrl).searchParams);
    decisionBody.set('decision', 'approve');
    const decision = await installer.request('/dev/fake-hubspot/authorize/decision', {
      method: 'POST',
      headers: { origin: baseUrl, 'content-type': 'application/x-www-form-urlencoded' },
      body: decisionBody.toString(),
    });
    const callbackPath = locationPath(decision, baseUrl);
    check('approve → OAuth callback', decision.status === 303 && callbackPath?.startsWith('/api/hubspot/oauth/callback?') === true, `${decision.status}`);
    const callback = await installer.request(callbackPath ?? '/');
    check('callback → /onboarding/email', callback.status === 303 && locationPath(callback, baseUrl) === '/onboarding/email', `${callback.status} → ${locationPath(callback, baseUrl) ?? 'none'}`);

    // 2. /onboarding/email → magic link.
    const emailPage = await installer.page('/onboarding/email');
    const prefilled = emailPage.$('input[name="email"]').attr('value') ?? '';
    check('/onboarding/email', emailPage.response.status === 200 && isPrivate(emailPage.response) && prefilled.includes('@'), `${emailPage.response.status}, prefilled ${prefilled !== ''}`);
    const nonce = scriptsNonced(emailPage.response, emailPage.$);
    check('/onboarding/email scripts carry the CSP nonce', nonce.ok, nonce.detail);
    const sent = await installer.submit(emailPage.$, '/onboarding/email', 'input[name="email"]');
    check('email submitted (Server Action, no JavaScript)', sent.status === 303 && locationPath(sent, baseUrl) === '/onboarding/email?sent=1', `${sent.status} → ${locationPath(sent, baseUrl) ?? 'none'}`);
    const sentPage = await installer.page('/onboarding/email?sent=1');
    check('"Check your email" shown', sentPage.html.includes('Check your email'), `${sentPage.response.status}`);

    // 3. The magic link from fake.dev_outbox (server stopped: PGlite is single-process), then restart.
    await sleep(500); // the fake-state persistence debounce (200 ms)
    await stopServer(server);
    const link = await readMagicLink(dataDir);
    check('magic link in fake.dev_outbox', link !== null && link.url.startsWith(`${baseUrl}/auth/confirm#th=`), link === null ? 'none' : 'found');
    server = startServer(port, env);
    await waitUntilReady(baseUrl, server);

    // 4. Opened in a fresh browser: GET the page (no fragment reaches the server), then POST.
    const owner = new Browser(baseUrl, '198.51.100.20');
    const confirmPage = await owner.page('/auth/confirm');
    const confirmNonce = scriptsNonced(confirmPage.response, confirmPage.$);
    check('GET /auth/confirm (fresh cookie jar)', confirmPage.response.status === 200 && owner.jar.header() === null && confirmPage.html.includes('disabled'), `${confirmPage.response.status}`);
    check('/auth/confirm script carries the CSP nonce', confirmNonce.ok, confirmNonce.detail);
    // D-62: the page's referrer policy is same-origin (header and meta), so a browser's form post
    // carries the real Origin. Under no-referrer it would send `Origin: null`; the POST below sends
    // exactly that (with the Sec-Fetch-Site a browser adds) to prove the fallback accepts it too.
    const referrerPolicy = confirmPage.response.headers.get('referrer-policy');
    const referrerMeta = confirmPage.$('meta[name="referrer"]').attr('content');
    check('/auth/confirm referrer policy is same-origin', referrerPolicy === 'same-origin' && referrerMeta === 'same-origin', `header ${referrerPolicy ?? 'none'}, meta ${referrerMeta ?? 'none'}`);
    const confirmed = await owner.request('/auth/confirm', {
      method: 'POST',
      headers: { origin: 'null', 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ th: link?.tokenHash ?? '', type: link?.type ?? '' }).toString(),
    });
    check(
      'POST /auth/confirm → bound, session cookie',
      confirmed.status === 303 && locationPath(confirmed, baseUrl) === '/onboarding/brief' && owner.jar.get('ap_session') !== undefined,
      `${confirmed.status} → ${locationPath(confirmed, baseUrl) ?? 'none'}`,
    );
    const anonymous = new Browser(baseUrl, '198.51.100.30');
    const refused = await anonymous.request('/onboarding/brief');
    check('no session → /login', refused.status === 303 && locationPath(refused, baseUrl) === '/login', `${refused.status} → ${locationPath(refused, baseUrl) ?? 'none'}`);

    // D-62: Next refuses a Server Action whose Origin is "null" (its CSRF check; 'null' is never added
    // to serverActions.allowedOrigins). This is why the pages use Referrer-Policy: same-origin.
    const loginPage = await anonymous.page('/login');
    const nullOrigin = await anonymous.submit(loginPage.$, '/login', 'input[name="email"]', { email: 'nobody@example.org' }, 'null');
    await nullOrigin.body?.cancel();
    check(
      'Server Action with Origin null refused (Next CSRF check)',
      nullOrigin.status >= 400 && locationPath(nullOrigin, baseUrl) !== '/login?sent=1',
      `${nullOrigin.status} → ${locationPath(nullOrigin, baseUrl) ?? 'none'}`,
    );
    const loginReferrer = loginPage.response.headers.get('referrer-policy');
    check('/login referrer policy is same-origin', loginReferrer === 'same-origin', loginReferrer ?? 'none');

    // 5. Onboarding pages.
    for (const step of ['brief', 'forms', 'preferences', 'inbox', 'baseline']) {
      const page = await owner.page(`/onboarding/${step}`);
      const nonced = scriptsNonced(page.response, page.$);
      check(`/onboarding/${step}`, page.response.status === 200 && isPrivate(page.response) && nonced.ok, `${page.response.status}, private ${isPrivate(page.response)}, ${nonced.detail}`);
    }

    // Brief: generate from the suggested address, wait for the job (dev ticker), save as the owner.
    const briefPage = await owner.page('/onboarding/brief');
    const generated = await owner.submit(briefPage.$, '/onboarding/brief', 'input[name="website_url"]');
    check('brief generation requested', generated.status === 303 || generated.status === 200, `${generated.status} → ${locationPath(generated, baseUrl) ?? 'page'}`);
    const briefDone = await waitFor(owner, 'the brief job', (status) => (status.brief as { status?: string } | undefined)?.status === 'done');
    check('brief_generate job done (dev ticker)', (briefDone?.brief as { status?: string } | undefined)?.status === 'done', JSON.stringify(briefDone?.brief ?? null));
    const editor = await owner.page('/onboarding/brief');
    const savedBrief = await owner.submit(editor.$, '/onboarding/brief', 'input[name="company_name"]', { booking_choice: 'found' });
    check('brief saved', savedBrief.status === 303 && locationPath(savedBrief, baseUrl) === '/onboarding/forms', `${savedBrief.status} → ${locationPath(savedBrief, baseUrl) ?? 'page'}`);

    // Forms: keep the starting ticks (the newsletter form unticked).
    const formsPage = await owner.page('/onboarding/forms');
    const ticked = formsPage.$('input[name="form_id"][checked]').length;
    const total = formsPage.$('input[name="form_id"]').length;
    const formsSaved = await owner.submit(formsPage.$, '/onboarding/forms', 'input[name="form_id"]');
    check('forms saved (newsletter unticked)', ticked === 2 && total === 3 && formsSaved.status === 303 && locationPath(formsSaved, baseUrl) === '/onboarding/preferences', `${ticked}/${total} ticked, ${formsSaved.status} → ${locationPath(formsSaved, baseUrl) ?? 'page'}`);

    // Preferences: the defaults (the owner's email) with Gmail and the portal's BCC address (the inbox
    // test then works without a test contact in HubSpot).
    const preferencesPage = await owner.page('/onboarding/preferences');
    const preferencesSaved = await owner.submit(preferencesPage.$, '/onboarding/preferences', 'input[name="notify_email_0"]', { mail_client: 'gmail', bcc_address: '1234567@bcc.hubspot.com' });
    check('preferences saved', preferencesSaved.status === 303 && (locationPath(preferencesSaved, baseUrl) ?? '').startsWith('/onboarding/preferences?saved=1'), `${preferencesSaved.status} → ${locationPath(preferencesSaved, baseUrl) ?? 'page'}`);

    // Inbox check: start the test with the owner's other address.
    const inboxPage = await owner.page('/onboarding/inbox');
    const inboxStarted = await owner.submit(inboxPage.$, '/onboarding/inbox', 'input[name="test_address"]', { test_address: 'owner.personal@example.net' });
    check('inbox test started', inboxStarted.status === 303 && locationPath(inboxStarted, baseUrl) === '/onboarding/inbox?result=started', `${inboxStarted.status} → ${locationPath(inboxStarted, baseUrl) ?? 'page'}`);

    // M4: the inbox_test email's "Edit first" and "Not a real lead" links (read from fake.dev_outbox
    // with the server stopped, as the magic link was). They work like a lead email's: the edit POST
    // answers 200 with a compose link built from the edited text; dismissing only marks the test lead.
    await sleep(500);
    await stopServer(server);
    const links = await readInboxTestLinks(dataDir);
    check('inbox_test email has edit and dismiss links', links !== null, links === null ? 'none' : 'found');
    const testLeadId = await readTestLeadId(dataDir);
    check('the inbox check created its test lead', testLeadId !== null, testLeadId === null ? 'none' : 'found');
    server = startServer(port, env);
    await waitUntilReady(baseUrl, server);
    if (links !== null) {
      const editPath = `/a/${links.edit}/edit`;
      const editPage = await owner.page(editPath);
      const editNonce = scriptsNonced(editPage.response, editPage.$);
      check(
        'GET /a/{t}/edit',
        editPage.response.status === 200 && isPrivate(editPage.response) && editNonce.ok && editPage.$('textarea[name="body"]').length === 1,
        `${editPage.response.status}, private ${isPrivate(editPage.response)}, ${editNonce.detail}`,
      );
      const editedBody = 'Hi,\n\nThis is my edited test reply, sent from my own mailbox.\n\nThanks';
      const edited = await owner.submit(editPage.$, editPath, 'textarea[name="body"]', { subject: 'Edited inbox test', body: editedBody });
      const editedHtml = await edited.text();
      const result = load(editedHtml);
      const sendHref = result('a:contains("Send from my email")').attr('href') ?? '';
      check(
        'POST /a/{t}/edit (no JavaScript) → 200 result with a Gmail link from the edited text',
        edited.status === 200 &&
          isNoStore(edited) &&
          editedHtml.includes('Your edited reply is ready') &&
          sendHref.startsWith('https://mail.google.com/') &&
          sendHref.includes(encodeURIComponent('This is my edited test reply')),
        `${edited.status}, no-store ${isNoStore(edited)}, link ${sendHref === '' ? 'none' : new URL(sendHref).host}`,
      );
      const dismissPath = `/a/${links.dismiss}/dismiss`;
      await owner.page(dismissPath);
      const dismissPage = await owner.page(dismissPath);
      check(
        'GET /a/{t}/dismiss (twice) asks and changes nothing',
        dismissPage.response.status === 200 && isPrivate(dismissPage.response) && dismissPage.html.includes('Mark this as not a real lead?'),
        `${dismissPage.response.status}`,
      );
      const dismissed = await owner.submit(dismissPage.$, dismissPath, 'input[name="token"]');
      await dismissed.body?.cancel();
      const donePage = await owner.page(dismissPath);
      check(
        'POST /a/{t}/dismiss → 303 back → done',
        dismissed.status === 303 && locationPath(dismissed, baseUrl) === dismissPath && donePage.html.includes('Done — this lead won'),
        `${dismissed.status} → ${locationPath(dismissed, baseUrl) ?? 'none'}`,
      );
      const again = await owner.submit(dismissPage.$, dismissPath, 'input[name="token"]');
      await again.body?.cancel();
      check('second dismiss POST changes nothing', again.status === 303 && locationPath(again, baseUrl) === dismissPath, `${again.status} → ${locationPath(again, baseUrl) ?? 'none'}`);
    }

    // Baseline (started by the page) and Finish.
    const baselinePage = await owner.page('/onboarding/baseline');
    const finishSelector = 'button:contains("Finish setup")';
    const finished = baselinePage.$(finishSelector).length === 0 ? null : await owner.submit(baselinePage.$, '/onboarding/baseline', finishSelector);
    check('Finish → /dashboard', finished?.status === 303 && locationPath(finished, baseUrl) === '/dashboard', `${finished?.status ?? 'no form'} → ${finished === null ? 'none' : (locationPath(finished, baseUrl) ?? 'page')}`);
    const status = await waitFor(owner, 'onboarding complete', (s) => (s.gate as { completed?: boolean } | undefined)?.completed === true, 5);
    check('onboarding complete', (status?.gate as { completed?: boolean } | undefined)?.completed === true, JSON.stringify(status?.gate ?? null));
    // M6: the dashboard. Active, no leads yet (the test lead is never listed), every script nonce'd.
    const dashboard = await owner.page('/dashboard');
    const dashboardNonce = scriptsNonced(dashboard.response, dashboard.$);
    const state = (page: { $: CheerioAPI }): string => page.$('[data-testid="status-card"]').attr('data-state') ?? 'none';
    check(
      '/dashboard: status active, setup complete, no leads listed',
      dashboard.response.status === 200 &&
        isPrivate(dashboard.response) &&
        dashboardNonce.ok &&
        state(dashboard) === 'active' &&
        dashboard.html.includes('Setup is complete') &&
        dashboard.$('ul[aria-label="Recent leads"] li').length === 0,
      `${dashboard.response.status}, private ${isPrivate(dashboard.response)}, state ${state(dashboard)}, ${dashboardNonce.detail}`,
    );

    // The reconnect sign-in link's landing (M3's promise): the Reconnect HubSpot link whatever the state.
    const reconnect = await owner.page('/dashboard?reconnect=1');
    check(
      '/dashboard?reconnect=1 offers Reconnect HubSpot',
      reconnect.response.status === 200 && reconnect.$('a[href="/api/hubspot/install"]:contains("Reconnect HubSpot")').length === 1,
      `${reconnect.response.status}`,
    );

    // Pause all and Resume: Server Actions posted without JavaScript, post/redirect/get.
    const paused = await owner.submit(dashboard.$, '/dashboard', 'button:contains("Pause all")');
    await paused.body?.cancel();
    const pausedPage = await owner.page(locationPath(paused, baseUrl) ?? '/dashboard');
    check(
      'Pause all (Server Action, no JavaScript) → paused',
      paused.status === 303 && locationPath(paused, baseUrl) === '/dashboard?result=paused' && state(pausedPage) === 'paused' && pausedPage.$('button:contains("Resume")').length === 1,
      `${paused.status} → ${locationPath(paused, baseUrl) ?? 'none'}, state ${state(pausedPage)}`,
    );
    const resumed = await owner.submit(pausedPage.$, '/dashboard', 'button:contains("Resume")');
    await resumed.body?.cancel();
    const resumedPage = await owner.page(locationPath(resumed, baseUrl) ?? '/dashboard');
    check(
      'Resume (Server Action) → active, with the paused-window banner',
      resumed.status === 303 && locationPath(resumed, baseUrl) === '/dashboard?result=resumed' && state(resumedPage) === 'active' && resumedPage.html.includes('were not drafted'),
      `${resumed.status} → ${locationPath(resumed, baseUrl) ?? 'none'}, state ${state(resumedPage)}`,
    );

    const briefEditor = await owner.page('/dashboard/brief');
    const briefNonce = scriptsNonced(briefEditor.response, briefEditor.$);
    check(
      '/dashboard/brief: the brief editor',
      briefEditor.response.status === 200 && isPrivate(briefEditor.response) && briefNonce.ok && briefEditor.$('input[name="company_name"]').length === 1,
      `${briefEditor.response.status}, private ${isPrivate(briefEditor.response)}, ${briefNonce.detail}`,
    );

    // A lead page: the inbox check's test lead (viewable with a note; no HubSpot refresh for it).
    if (testLeadId !== null) {
      const leadPage = await owner.page(`/dashboard/leads/${testLeadId}`);
      const leadNonce = scriptsNonced(leadPage.response, leadPage.$);
      check(
        '/dashboard/leads/{test lead}: viewable, marked as the test lead',
        leadPage.response.status === 200 &&
          isPrivate(leadPage.response) &&
          leadNonce.ok &&
          leadPage.html.includes('This is the test lead from your inbox check') &&
          leadPage.$('[data-testid="timeline"]').length === 1 &&
          !leadPage.html.includes('Resume follow-ups'),
        `${leadPage.response.status}, private ${isPrivate(leadPage.response)}, ${leadNonce.detail}`,
      );
    }
    const unknownLead = await owner.page('/dashboard/leads/00000000-0000-4000-8000-000000000000');
    const malformedLead = await owner.page('/dashboard/leads/not-a-lead');
    check(
      '/dashboard/leads/{unknown or malformed id} → 404',
      unknownLead.response.status === 404 && malformedLead.response.status === 404 && isPrivate(unknownLead.response),
      `${unknownLead.response.status}, ${malformedLead.response.status}`,
    );
    const anonymousLead = await anonymous.request(`/dashboard/leads/${testLeadId ?? '00000000-0000-4000-8000-000000000000'}`);
    await anonymousLead.body?.cancel();
    check(
      'no session → /dashboard pages redirect to /login',
      anonymousLead.status === 303 && locationPath(anonymousLead, baseUrl) === '/login',
      `${anonymousLead.status} → ${locationPath(anonymousLead, baseUrl) ?? 'none'}`,
    );
    const baselineDone = await waitFor(owner, 'the baseline job', (s) => (s.baseline as { state?: string } | undefined)?.state === 'done');
    check('baseline job done (dev ticker)', (baselineDone?.baseline as { state?: string } | undefined)?.state === 'done', JSON.stringify(baselineDone?.baseline ?? null));
  } catch (error) {
    check('run', false, error instanceof Error ? `${error.name}: ${error.message}` : 'failed');
    console.error(server.output.join('').slice(-4000));
  } finally {
    await stopServer(server);
  }
  // The second server's warnings and errors (codes only, the logger redacts), for the report.
  const flagged = server.output
    .join('')
    .split('\n')
    .filter((line) => line.includes('"level":"error"') || line.includes('"level":"warn"'));
  for (const line of flagged) console.log(`e2e: server ${line}`);
  check('server logged no error', !flagged.some((line) => line.includes('"level":"error"')), `${flagged.length} warn/error lines`);
}

async function main(): Promise<number> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'autopilot-e2e-'));
  try {
    await run(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`e2e: ${checks.length - failed.length}/${checks.length} checks passed`);
  return failed.length === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error('e2e: failed', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  },
);
