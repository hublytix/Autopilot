// Simulation stage 3, the pre-run (PLAN §13 pre-run table, D-39, D-50), Tue 2026-10-06 America/New_York.
// The owner's real onboarding, through the same route handlers, page read models (views) and
// Server Action bodies (the services they call, with the forms parsed by the actions' own FormData
// helpers) the app uses, on the fakes:
//   09:00     install → fake consent (Approve) → OAuth callback branch (a) → /onboarding/email →
//             magic link (outbox #1)
//   09:00:30  the link opened on a FRESH cookie jar → GET /auth/confirm → POST /auth/confirm → bound
//   09:01     website address submitted → brief_generate job (background)
//   09:01:30  forms selected (the newsletter form detected and unticked)
//   09:02     preferences saved: Gmail, the owner's notify email only, quiet 19–08, weekends allowed,
//             BCC on; no change alert (onboarding is not complete)
//   09:03     the generated brief reviewed and saved (source 'owner')
//   09:03:15  inbox test started: history counts, test lead, inbox_test email (outbox #2), inbox_check job
//   09:03:30  the owner taps "Send from my email" in the test email (a click on the test lead) and
//             sends; HubSpot logs the send at 09:04
//   09:04:30  /onboarding/baseline starts the baseline job; Finish → onboarding complete → active
// Background: the owner replies from the test address at 09:05 (logged at 09:05); the inbox_check
// job sees both legs (log_all); the baseline finishes (3 h 30 m, 20%). All done by 09:06.
import { CookieJar } from '@/server/security/cookies';
import { onboardingAccess, onboardingEmailPageState, handleConfirmGet, handleConfirmPost } from '@/server/http/auth';
import { buildConsentView, FAKE_HUBSPOT_DECISION_PATH, handleFakeHubSpotDecision } from '@/server/http/dev';
import { handleSendLink } from '@/server/http/action-links';
import { ONBOARDING_EMAIL_PATH, handleHubSpotCallback } from '@/server/http/hubspot-callback';
import { clientIp, handleHubSpotInstall } from '@/server/http/hubspot-install';
import { briefInputFromValues, parseBriefForm, parsePreferencesForm, preferencesInputFromValues } from '@/server/actions/onboarding/parse';
import { requireOwner, submitOnboardingEmail, type OwnerScope } from '@/server/services/auth';
import { confirmPostRequest, lastMagicLink } from '@/server/services/auth/testing';
import { baselineView } from '@/server/services/baseline';
import { requestBriefGeneration, saveOwnerBrief } from '@/server/services/brief';
import { latestInboxCheck, startInboxCheck } from '@/server/services/inbox-check';
import { completeOnboarding, saveFormSelection, savePreferences } from '@/server/services/onboarding';
import { PENDING_INSTALL_COOKIE_NAME, STATE_COOKIE_NAME } from '@/server/services/install/cookies';
import { baselinePageView, briefPageView, formsPageView, onboardingStatus, preferencesPageView } from '@/server/views/onboarding';
import type { Simulation } from './types';

export const PRE_RUN_START = '2026-10-06T09:00:00';
/** The Finish tap: onboarding complete, the account active, the intake floors (PLAN §13). */
export const PRE_RUN_FINISH = '2026-10-06T09:04:30';
/** Everything in the background is done by then (PLAN §13). */
export const PRE_RUN_END = '2026-10-06T09:06:00';
const FOREGROUND_LIMIT_MS = 5 * 60_000;

/** The installing browser's address (only its HMAC is stored, for rate limits). */
const OWNER_IP = '198.51.100.7';
/** A desktop browser: "Send from my email" with Gmail opens the web compose window (302). */
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
/** The fixture portal's HubSpot BCC address (Settings → Objects → Activities → Email logging). */
const BCC_LOCAL_PART_SUFFIX = '@bcc.hubspot.com';

/** What the pre-run's steps hand to each other. */
interface PreRunState {
  accountId: string | null;
  /** The installing browser: the OAuth state and pending_install cookies. */
  readonly installJar: CookieJar;
  /** The browser the magic link is opened in: empty until /auth/confirm sets the session. */
  readonly ownerJar: CookieJar;
  ownerEmail: string | null;
  briefJobId: string | null;
  /** End of every owner foreground step, for the 5-minute check. */
  readonly foregroundEnds: number[];
}

function locationOf(response: Response, base: string): URL | null {
  const location = response.headers.get('location');
  return location === null ? null : new URL(location, base);
}

function form(entries: Record<string, string | readonly string[]>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(entries)) {
    if (typeof value === 'string') data.append(name, value);
    else for (const item of value) data.append(name, item);
  }
  return data;
}

/** The owner's session as a page or Server Action reads it: requireOwner on the owner browser's cookies. */
async function owner(sim: Simulation, state: PreRunState, path: string): Promise<OwnerScope> {
  return requireOwner(sim.deps, state.ownerJar.request(`${sim.deps.env.APP_URL}${path}`, { headers: { 'x-real-ip': OWNER_IP } }));
}

function endForeground(sim: Simulation, state: PreRunState): void {
  state.foregroundEnds.push(sim.clock.nowMs());
}

/** A limiter sleep moves the simulated clock (PLAN §13: the run never waits on the wall clock). */
function sleepOn(sim: Simulation): (ms: number) => Promise<void> {
  return async (ms) => {
    sim.clock.advance(ms);
  };
}

// ---------------------------------------------------------------------------------------------
// 09:00 install → /onboarding/email → magic link
// ---------------------------------------------------------------------------------------------

async function install(sim: Simulation, state: PreRunState): Promise<void> {
  const { deps } = sim;
  const env = deps.env;
  const jar = state.installJar;

  const installResponse = await handleHubSpotInstall(jar.request(`${env.APP_URL}/api/hubspot/install`, { headers: { 'x-real-ip': OWNER_IP } }), deps);
  jar.storeFrom(installResponse);
  const consentUrl = locationOf(installResponse, env.APP_URL);
  sim.check(
    'prerun.install_redirects_to_fake_consent',
    installResponse.status === 302 && consentUrl?.pathname === '/dev/fake-hubspot/authorize' && jar.get(STATE_COOKIE_NAME) !== undefined,
    `status ${installResponse.status}, next ${consentUrl?.pathname ?? 'none'}`,
  );
  if (consentUrl === null) return;
  const devContext = { env, fakes: sim.fakes };
  const view = buildConsentView(Object.fromEntries(consentUrl.searchParams), devContext);
  sim.check('prerun.fake_consent_page_shows_required_scopes', view.kind === 'consent', `view ${view.kind}`);

  // The consent page's form, approved: the decision route mints a code and redirects to the callback.
  const body = new URLSearchParams(consentUrl.searchParams);
  body.set('decision', 'approve');
  const decision = await handleFakeHubSpotDecision(
    new Request(`${env.APP_URL}${FAKE_HUBSPOT_DECISION_PATH}`, {
      method: 'POST',
      headers: { origin: env.APP_URL, 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }),
    devContext,
  );
  const callbackUrl = locationOf(decision, env.APP_URL);
  sim.check('prerun.consent_redirects_to_callback', decision.status === 303 && callbackUrl?.href.startsWith(env.HUBSPOT_REDIRECT_URI) === true);
  if (callbackUrl === null) return;

  const callback = await handleHubSpotCallback(jar.request(callbackUrl.href, { headers: { 'x-real-ip': OWNER_IP } }), deps);
  jar.storeFrom(callback);
  const next = locationOf(callback, env.APP_URL);
  sim.check(
    'prerun.callback_branch_a_to_onboarding_email',
    callback.status === 303 && next?.pathname === ONBOARDING_EMAIL_PATH && jar.get(PENDING_INSTALL_COOKIE_NAME) !== undefined,
    `status ${callback.status}, next ${next?.pathname ?? 'none'}`,
  );
  const account = await sim.db.maybeOne<{ id: string }>(`select id from public.accounts where hubspot_portal_id = $1`, [sim.fakes.hubspot.portal.portalId]);
  state.accountId = account?.id ?? null;
  sim.scenario.accountId = state.accountId;
  sim.record('step', 'install.completed', { branch: 'new_portal', next: next?.pathname ?? null, installed: sim.fakes.hubspot.isInstalled() });

  // /onboarding/email: the layout lets the pending install through; the page pre-fills the installer's email.
  const headers = new Headers({ cookie: jar.header() ?? '', 'x-real-ip': OWNER_IP });
  const access = await onboardingAccess(deps, headers);
  const page = await onboardingEmailPageState(deps, headers);
  const email = page.type === 'ready' ? page.email : null;
  sim.check('prerun.onboarding_email_page_prefills_installer_email', access === 'pending' && email === sim.fakes.hubspot.ownerEmail, `access ${access}, page ${page.type}`);
  if (email === null) return;

  // The form posts to onboardingEmailAction, which runs submitOnboardingEmail with this browser's cookie.
  const outcome = await submitOnboardingEmail(deps, {
    pendingCookie: jar.get(PENDING_INSTALL_COOKIE_NAME),
    email: form({ email }).get('email'),
    ip: clientIp(new Request(env.APP_URL, { headers })),
  });
  state.ownerEmail = email;
  sim.scenario.ownerEmail = email;
  const sent = sim.fakes.mailer.sent;
  sim.check(
    'prerun.magic_link_is_outbox_1',
    outcome.type === 'sent' && sent.length === 1 && sent[0]?.kind === 'magic_link' && sent[0].to.join() === email,
    `outcome ${outcome.type}, outbox ${sent.map((mail) => mail.kind).join(', ')}`,
  );
  sim.record('step', 'onboarding_email.submitted', { outcome: outcome.type });
  endForeground(sim, state);
}

// ---------------------------------------------------------------------------------------------
// 09:00:30 the magic link, opened in a fresh browser
// ---------------------------------------------------------------------------------------------

async function confirm(sim: Simulation, state: PreRunState): Promise<void> {
  const { deps } = sim;
  const appUrl = deps.env.APP_URL;
  const jar = state.ownerJar;
  const freshJar = jar.header() === null;
  const link = lastMagicLink(sim.fakes);

  // The browser requests the page without the fragment; the page's script reads it and fills the form.
  const pageUrl = new URL(link.url);
  const page = handleConfirmGet(jar.request(`${pageUrl.origin}${pageUrl.pathname}`), deps);
  const pageHtml = await page.text();
  sim.check(
    'prerun.confirm_page_never_auto_submits',
    page.status === 200 && pageHtml.includes('id="submit" disabled') && link.url.includes('#th='),
    `status ${page.status}`,
  );

  const sentCookie = jar.header();
  const response = await handleConfirmPost(confirmPostRequest(appUrl, { tokenHash: link.tokenHash, type: link.type, ip: OWNER_IP, cookie: sentCookie }), deps);
  jar.storeFrom(response);
  const next = locationOf(response, appUrl);
  let scope: OwnerScope | null = null;
  try {
    scope = await owner(sim, state, next?.pathname ?? '/onboarding/brief');
  } catch {
    scope = null;
  }
  sim.check(
    'prerun.magic_link_on_fresh_cookie_jar_binds_owner',
    freshJar && response.status === 303 && next?.pathname === '/onboarding/brief' && scope !== null && scope.accountId === state.accountId,
    `fresh jar ${String(freshJar)}, status ${response.status}, next ${next?.pathname ?? 'none'}, owner ${scope === null ? 'none' : 'bound'}`,
  );
  // The install browser still holds its pending_install cookie; the confirm POST came from the other
  // browser, which never had it, and bound the owner anyway.
  sim.check(
    'prerun.install_browser_cookie_not_needed',
    state.installJar.get(PENDING_INSTALL_COOKIE_NAME) !== undefined && !(sentCookie ?? '').includes(PENDING_INSTALL_COOKIE_NAME) && scope !== null,
    `install browser has it ${String(state.installJar.get(PENDING_INSTALL_COOKIE_NAME) !== undefined)}, sent with confirm ${String((sentCookie ?? '').includes(PENDING_INSTALL_COOKIE_NAME))}`,
  );
  const user = state.accountId === null ? null : await sim.db.maybeOne<{ email: string }>(`select email from public.users where account_id = $1`, [state.accountId]);
  sim.check('prerun.owner_is_the_installer', user?.email === sim.fakes.hubspot.ownerEmail);
  sim.record('step', 'owner.bound', { via: 'magic_link', freshCookieJar: freshJar, next: next?.pathname ?? null });
  endForeground(sim, state);
}

// ---------------------------------------------------------------------------------------------
// 09:01 brief URL, 09:01:30 forms, 09:02 preferences, 09:03 brief saved
// ---------------------------------------------------------------------------------------------

async function requestBrief(sim: Simulation, state: PreRunState): Promise<void> {
  const scope = await owner(sim, state, '/onboarding/brief');
  const page = await briefPageView(scope, sim.deps);
  const data = form({ website_url: page.suggestedUrl });
  const result = await requestBriefGeneration(scope, sim.deps, { websiteUrl: String(data.get('website_url') ?? '') });
  state.briefJobId = result.ok ? result.briefJobId : null;
  sim.check('prerun.brief_generation_requested', result.ok, result.ok ? undefined : `refused: ${result.reason}`);
  sim.record('step', 'brief.generation_requested', { suggestedFromPortalDomain: page.suggestedUrl !== '', ok: result.ok });
  endForeground(sim, state);
}

async function selectForms(sim: Simulation, state: PreRunState): Promise<void> {
  const scope = await owner(sim, state, '/onboarding/forms');
  const page = await formsPageView(scope, sim.deps);
  const forms = page.ok ? page.forms : [];
  const newsletter = forms.find((choice) => choice.name === 'Newsletter signup');
  sim.check(
    'prerun.newsletter_form_detected_and_unticked',
    newsletter?.newsletterDetected === true && !newsletter.checked && forms.filter((choice) => choice.checked).length === 2,
    page.ok ? `ticked ${forms.filter((choice) => choice.checked).map((choice) => choice.name).join(', ')}` : `forms unavailable: ${page.reason}`,
  );
  // The owner leaves the ticks as they are and saves: the form posts the ticked ids (saveFormsAction).
  const data = form({ form_id: forms.filter((choice) => choice.checked).map((choice) => choice.id) });
  const formIds = data.getAll('form_id').filter((value): value is string => typeof value === 'string');
  const result = await saveFormSelection(scope, sim.deps, { formIds }, { sleep: sleepOn(sim) });
  sim.check('prerun.forms_saved', result.ok, result.ok ? undefined : result.reason);
  sim.record('step', 'forms.selected', {
    selected: forms.filter((choice) => choice.checked).map((choice) => choice.name),
    unticked: forms.filter((choice) => !choice.checked).map((choice) => choice.name),
  });
  endForeground(sim, state);
}

async function preferences(sim: Simulation, state: PreRunState): Promise<void> {
  const scope = await owner(sim, state, '/onboarding/preferences');
  const page = await preferencesPageView(scope, sim.deps);
  const before = sim.fakes.mailer.sent.length;
  const ownerEmail = state.ownerEmail ?? '';
  // PLAN §13 / D-39: Gmail, one notify email (the owner's), quiet hours 19–08, weekends allowed, BCC on.
  const data = form({
    mail_client: 'gmail',
    gmail_account_email: '',
    notify_email_0: ownerEmail,
    notify_email_1: '',
    notify_email_2: '',
    quiet_start_hour: '19',
    quiet_end_hour: '8',
    followups_enabled: 'on',
    bcc_address: `${sim.fakes.hubspot.portal.portalId}${BCC_LOCAL_PART_SUFFIX}`,
    timezone: page.preferences.timezoneEditable ? (page.preferences.timezone ?? '') : '',
  });
  const result = await savePreferences(scope, sim.deps, preferencesInputFromValues(parsePreferencesForm(data)));
  const emails = sim.fakes.mailer.sent.length - before;
  sim.check(
    'prerun.preferences_saved_without_any_email',
    result.ok && result.verificationsSent === 0 && emails === 0,
    result.ok ? `verifications ${result.verificationsSent}, emails ${emails}` : `issues ${result.issues.map((issue) => issue.code).join(', ')}`,
  );
  sim.record('step', 'preferences.saved', {
    mailClient: 'gmail',
    notifyEmails: 1,
    quietHours: '19-08',
    skipWeekends: false,
    bcc: true,
    timezoneEditable: page.preferences.timezoneEditable,
    emailsSent: emails,
  });
  endForeground(sim, state);
}

async function saveBrief(sim: Simulation, state: PreRunState): Promise<void> {
  const scope = await owner(sim, state, '/onboarding/brief');
  const status = await onboardingStatus(scope, sim.deps);
  const page = await briefPageView(scope, sim.deps);
  const values = page.initialValues;
  sim.check(
    'prerun.brief_generated_before_review',
    status.brief.status === 'done' && page.editor.form.origin === 'generated' && page.bookingLink !== null,
    `brief job ${status.brief.status}${status.brief.errorCode === null ? '' : ` (${status.brief.errorCode})`}, editor ${page.editor.form.origin}`,
  );
  // The owner reads the generated brief, keeps it, and confirms the booking link the site gave.
  const entries: Record<string, string> = {
    company_name: values.company_name,
    one_line: values.one_line,
    services: values.services,
    who_we_serve: values.who_we_serve,
    tone_style: values.tone_style,
    tone_note: values.tone_note,
    sign_off_name: values.sign_off_name,
    never_promise: values.never_promise,
    booking_choice: 'found',
    booking_link_found: values.booking_link_found,
    booking_link_other: '',
  };
  values.faqs.forEach((faq, index) => {
    entries[`faq_q_${index}`] = faq.q;
    entries[`faq_a_${index}`] = faq.a;
  });
  const result = await saveOwnerBrief(scope, sim.deps, briefInputFromValues(parseBriefForm(form(entries))));
  const saved = state.accountId === null ? null : await sim.db.maybeOne<{ source: string; booking_link_choice: string; booking_link_confirmed: boolean }>(
    `select source, booking_link_choice, booking_link_confirmed from public.brief_versions where account_id = $1 order by version desc limit 1`,
    [state.accountId],
  );
  sim.check(
    'prerun.brief_saved_as_owner_version',
    result.ok && saved?.source === 'owner' && saved.booking_link_choice === 'link' && saved.booking_link_confirmed,
    result.ok ? `version ${result.version}, source ${saved?.source ?? 'none'}` : `issues ${result.issues.map((issue) => `${issue.path}:${issue.code}`).join(', ')}`,
  );
  sim.record('step', 'brief.saved', { source: saved?.source ?? null, bookingLinkConfirmed: saved?.booking_link_confirmed ?? false, faqs: values.faqs.filter((faq) => faq.q !== '').length });
  endForeground(sim, state);
}

// ---------------------------------------------------------------------------------------------
// 09:03:15 inbox test, 09:03:30 the owner sends it
// ---------------------------------------------------------------------------------------------

async function startInboxTest(sim: Simulation, state: PreRunState): Promise<void> {
  const scope = await owner(sim, state, '/onboarding/inbox');
  const testAddress = sim.fakes.hubspot.testAddress ?? '';
  const data = form({ test_address: testAddress });
  const result = await startInboxCheck(scope, sim.deps, { testAddress: data.get('test_address') }, { sleep: sleepOn(sim) });
  const check = state.accountId === null ? null : await latestInboxCheck(sim.db, state.accountId);
  const sent = sim.fakes.mailer.sent;
  const jobs = check === null ? 0 : (await sim.db.one<{ n: number }>(`select count(*)::int as n from public.scheduled_jobs where kind = 'inbox_check' and account_id = $1`, [check.accountId])).n;
  sim.check(
    'prerun.inbox_test_is_outbox_2_with_an_inbox_check_job',
    result.type === 'started' && sent.length === 2 && sent[1]?.kind === 'inbox_test' && sent[1].to.join() === state.ownerEmail && check?.testLeadId !== null && jobs === 1,
    `start ${result.type}, outbox ${sent.map((mail) => mail.kind).join(', ')}, inbox_check jobs ${jobs}`,
  );
  // The fixture portal's last 30 days: 4 logged outbound emails and 1 inbound (as test/inbox asserts).
  sim.check(
    'prerun.inbox_check_history_counted',
    check !== null && check.historyOutbound30d === 4 && check.historyInbound30d === 1,
    `outbound ${check?.historyOutbound30d ?? 'null'}, inbound ${check?.historyInbound30d ?? 'null'}`,
  );
  sim.record('step', 'inbox_check.started', {
    result: result.type,
    historyOutbound30d: check?.historyOutbound30d ?? null,
    historyInbound30d: check?.historyInbound30d ?? null,
    testLead: check?.testLeadId !== null && check?.testLeadId !== undefined,
  });
  endForeground(sim, state);
}

/** The test email's "Send from my email" link (`/a/{token}/send`, not the `?via=mailto` one). */
function sendLinkToken(text: string): string | null {
  const match = /\/a\/(apt_[A-Za-z0-9_-]+)\/send(?![?\w])/.exec(text);
  return match?.[1] ?? null;
}

async function sendTestReply(sim: Simulation, state: PreRunState): Promise<void> {
  const { deps } = sim;
  const mail = sim.fakes.mailer.sent.find((sent) => sent.kind === 'inbox_test');
  const token = mail === undefined ? null : sendLinkToken(mail.text);
  const testAddress = sim.fakes.hubspot.testAddress ?? '';
  let status = 0;
  let host: string | null = null;
  if (token !== null) {
    const response = await handleSendLink(
      new Request(`${deps.env.APP_URL}/a/${token}/send`, { headers: { 'user-agent': DESKTOP_UA, 'x-real-ip': OWNER_IP } }),
      deps,
      token,
    );
    status = response.status;
    const location = response.headers.get('location');
    host = location === null ? null : new URL(location).host;
  }
  sim.check('prerun.test_send_link_opens_gmail_compose', status === 302 && host === 'mail.google.com', `status ${status}, host ${host ?? 'none'}`);
  // D-26: 15 s after the email and no beacon (a desktop redirect has no page) is not a counted click.
  const clicked = await sim.db.maybeOne<{ first_send_clicked_at: Date | null }>('select first_send_clicked_at from public.leads where is_test');
  // The owner sends from Gmail (BCC on): the mailbox logs everything, HubSpot shows it at 09:04.
  const logged = sim.fakes.hubspot.logOwnerSend({ to: testAddress, at: sim.clock.now(), loggedAt: sim.local('2026-10-06T09:04:00') });
  sim.check(
    'prerun.test_send_link_click_not_counted_before_60s',
    clicked !== null && clicked.first_send_clicked_at === null,
    clicked === null ? 'no test lead' : `first_send_clicked_at ${clicked.first_send_clicked_at?.toISOString() ?? 'null'}`,
  );
  sim.check('prerun.owner_send_logged_in_hubspot', logged !== null, logged === null ? 'not logged' : 'logged');
  sim.record('step', 'inbox_test.sent_by_owner', {
    httpStatus: status,
    composeHost: host,
    clickCounted: clicked?.first_send_clicked_at !== null && clicked?.first_send_clicked_at !== undefined,
    loggedInHubSpot: logged !== null,
  });
  endForeground(sim, state);
}

// ---------------------------------------------------------------------------------------------
// 09:04:30 baseline + Finish; 09:05 the owner's reply from the test address
// ---------------------------------------------------------------------------------------------

async function finish(sim: Simulation, state: PreRunState): Promise<void> {
  const scope = await owner(sim, state, '/onboarding/baseline');
  const page = await baselinePageView(scope, sim.deps);
  sim.check('prerun.baseline_started_by_its_page', page.start === 'started' && page.gate.ready, `start ${page.start}, gate missing ${page.gate.missing.join(', ') || 'none'}`);
  // Finish (finishOnboardingAction).
  const result = await completeOnboarding(scope, sim.deps);
  sim.check('prerun.finish_activates_the_account', result.ok && result.processingState === 'active', result.ok ? `state ${result.processingState}` : `missing ${result.missing.join(', ')}`);
  sim.scenario.onboardingCompletedAt = sim.clock.now();
  sim.record('step', 'onboarding.completed', { baseline: page.start, state: result.ok ? result.processingState : null });
  endForeground(sim, state);
}

async function ownerRepliesFromTestAddress(sim: Simulation): Promise<void> {
  const testAddress = sim.fakes.hubspot.testAddress ?? '';
  const logged = sim.fakes.hubspot.logLeadReply({ from: testAddress, at: sim.clock.now() });
  sim.record('step', 'inbox_test.reply_from_test_address', { loggedInHubSpot: logged !== null });
}

// ---------------------------------------------------------------------------------------------
// The checks at 09:06
// ---------------------------------------------------------------------------------------------

async function checkPreRun(sim: Simulation, state: PreRunState): Promise<void> {
  const start = sim.local(PRE_RUN_START).getTime();
  const finishAt = sim.local(PRE_RUN_FINISH);
  const lastForeground = Math.max(...state.foregroundEnds);
  sim.check(
    'prerun.owner_foreground_steps_within_5_minutes',
    state.foregroundEnds.length === 9 && lastForeground - start <= FOREGROUND_LIMIT_MS,
    `${state.foregroundEnds.length} steps, last ended ${Math.round((lastForeground - start) / 1000)} s after 09:00`,
  );

  const kinds = sim.fakes.mailer.sent.map((mail) => mail.kind);
  sim.check('prerun.outbox_is_exactly_magic_link_and_inbox_test', kinds.join(',') === 'magic_link,inbox_test', kinds.join(', '));

  const accountId = state.accountId;
  if (accountId === null) {
    sim.check('prerun.account_created', false, 'no account');
    return;
  }
  const account = await sim.db.one<{
    processing_state: string;
    owner_user_id: string | null;
    onboarding_completed_at: Date | null;
    timezone: string | null;
    logging_mode: string;
  }>('select processing_state, owner_user_id, onboarding_completed_at, timezone, logging_mode from public.accounts where id = $1', [accountId]);
  sim.check('prerun.account_active', account.processing_state === 'active', `processing_state ${account.processing_state}`);
  sim.check('prerun.timezone_from_hubspot', account.timezone === 'America/New_York', `timezone ${account.timezone ?? 'null'}`);
  sim.check(
    'prerun.onboarding_completed_at_0904_30',
    account.onboarding_completed_at?.getTime() === finishAt.getTime(),
    `onboarding_completed_at ${account.onboarding_completed_at?.toISOString() ?? 'null'}`,
  );

  const forms = await sim.db.query<{ form_name: string; selected: boolean; intake_floor_at: Date }>(
    'select form_name, selected, intake_floor_at from public.selected_forms where account_id = $1 order by form_name',
    [accountId],
  );
  const selected = forms.filter((row) => row.selected);
  sim.check('prerun.both_enquiry_forms_selected', selected.map((row) => row.form_name).join(',') === 'Contact us,Request a quote', `selected ${selected.map((row) => row.form_name).join(', ')}`);
  sim.check(
    'prerun.floors_at_onboarding_complete_0904_30',
    selected.length === 2 && selected.every((row) => row.intake_floor_at.getTime() === finishAt.getTime()),
    `floors ${[...new Set(selected.map((row) => row.intake_floor_at.toISOString()))].join(', ')}`,
  );

  const check = await latestInboxCheck(sim.db, accountId);
  sim.check(
    'prerun.inbox_check_both_legs_log_all',
    account.logging_mode === 'log_all' && check?.status === 'closed' && check.sendLeg === 'passed' && check.replyLeg === 'passed',
    `logging_mode ${account.logging_mode}, check ${check?.status ?? 'none'} send ${check?.sendLeg ?? '-'} reply ${check?.replyLeg ?? '-'}`,
  );

  const baseline = await baselineView(sim.db, accountId);
  const median = baseline.state === 'done' ? baseline.baseline.medianSecondsToFirstOutbound : null;
  const percent = baseline.state === 'done' ? baseline.percentWithout : null;
  sim.check(
    'prerun.baseline_3h30m_and_20_percent',
    baseline.state === 'done' && baseline.baseline.status === 'ok' && median === 3.5 * 3600 && percent === 20 && baseline.baseline.leadsCounted === 5,
    `state ${baseline.state}, median ${median ?? 'null'} s, without ${percent ?? 'null'}%`,
  );

  const briefJob = state.briefJobId === null ? null : await sim.db.maybeOne<{ status: string }>('select status from public.brief_jobs where id = $1', [state.briefJobId]);
  const unfinished = await sim.db.query<{ kind: string; status: string }>(
    `select kind, status from public.scheduled_jobs where status not in ('done', 'cancelled', 'skipped') order by kind, status`,
  );
  sim.check(
    'prerun.background_work_done_by_0906',
    briefJob?.status === 'done' && unfinished.length === 0 && sim.fakes.scheduler.pending().length === 0,
    `brief ${briefJob?.status ?? 'none'}, unfinished ${unfinished.map((row) => `${row.kind}:${row.status}`).join(', ') || 'none'}`,
  );

  const aiCalls = await sim.db.query<{ purpose: string; model: string; outcome: string; n: number }>(
    `select purpose, model, outcome, count(*)::int as n from public.ai_calls group by purpose, model, outcome order by purpose`,
  );
  const { ANTHROPIC_MODEL_DRAFT: draft, ANTHROPIC_MODEL_FAST: fast } = sim.deps.env;
  sim.check(
    'prerun.ai_calls_brief_on_the_draft_model_and_baseline_on_the_fast_model',
    aiCalls.map((row) => `${row.purpose}:${row.model}:${row.outcome}:${row.n}`).join(',') === `baseline_classify:${fast}:ok:5,brief:${draft}:ok:1`,
    aiCalls.map((row) => `${row.purpose}:${row.model}:${row.outcome}:${row.n}`).join(', '),
  );

  const leads = await sim.db.query<{ id: string; is_test: boolean; intake_trigger: string; processing_state: string }>(
    'select id, is_test, intake_trigger, processing_state from public.leads where account_id = $1',
    [accountId],
  );
  const real = leads.filter((row) => !row.is_test);
  const test = leads.filter((row) => row.is_test);
  sim.check('prerun.no_historical_lead', real.length === 0, `${real.length} leads before Day 0`);
  sim.check(
    'prerun.one_test_lead_linked_to_the_check',
    test.length === 1 && test[0]?.intake_trigger === 'inbox_check' && test[0].id === check?.testLeadId,
    `${test.length} test leads`,
  );
}

/** Schedules the pre-run's steps, runs them (time travel to 09:06) and checks the result. */
export async function runPreRun(sim: Simulation): Promise<void> {
  const state: PreRunState = {
    accountId: null,
    installJar: new CookieJar(),
    ownerJar: new CookieJar(),
    ownerEmail: null,
    briefJobId: null,
    foregroundEnds: [],
  };
  const { travel } = sim;
  const step = (local: string, name: string, run: () => Promise<void>): void => {
    travel.at(sim.local(`2026-10-06T${local}`), name, async () => {
      if (state.accountId === null && name !== 'install') return;
      await run();
    });
  };
  step('09:00:00', 'install', () => install(sim, state));
  step('09:00:30', 'confirm', () => confirm(sim, state));
  step('09:01:00', 'brief_url', () => requestBrief(sim, state));
  step('09:01:30', 'forms', () => selectForms(sim, state));
  step('09:02:00', 'preferences', () => preferences(sim, state));
  step('09:03:00', 'brief_save', () => saveBrief(sim, state));
  step('09:03:15', 'inbox_test', () => startInboxTest(sim, state));
  step('09:03:30', 'inbox_send', () => sendTestReply(sim, state));
  step('09:04:30', 'finish', () => finish(sim, state));
  step('09:05:00', 'inbox_reply', () => ownerRepliesFromTestAddress(sim));
  await travel.advanceTo(sim.local(PRE_RUN_END));
  await checkPreRun(sim, state);
}
