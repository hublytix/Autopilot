// M2 simulation seed helper (PLAN §15 M2, D-50): an active account for the scenario portal, created
// through the real install path where M2 has one, and by direct inserts where the onboarding pages
// (M3) do not exist yet. M3 replaces the direct steps with the real onboarding (magic link, forms,
// preferences, brief, inbox check, baseline, Finish).
//
// Times follow PLAN §13's pre-run table (Tue 2026-10-06, America/New_York):
//   09:00     install → fake consent (Approve) → OAuth callback branch (a) → /onboarding/email
//   09:00:30  owner bound (direct: M3 binds through the magic link at /auth/confirm)
//   09:01:30  forms selected: "Contact us" and "Request a quote"; the newsletter form unticked
//   09:02     preferences saved: Gmail, the owner's address, quiet hours 19-08, weekends allowed, BCC on
//   09:04:30  onboarding complete → applyProcessingState → active; the floors move to 09:04:30
import { buildConsentView, FAKE_HUBSPOT_DECISION_PATH, handleFakeHubSpotDecision } from '@/server/http/dev';
import { ONBOARDING_EMAIL_PATH, handleHubSpotCallback } from '@/server/http/hubspot-callback';
import { handleHubSpotInstall } from '@/server/http/hubspot-install';
import { applyProcessingState } from '@/server/services/accounts';
import { PENDING_INSTALL_COOKIE_NAME, readPendingInstall, STATE_COOKIE_NAME } from '@/server/services/install/cookies';
import type { Simulation } from './types';

/** `name=value` of the Set-Cookie named `name` in `response`, or null. */
function setCookiePair(response: Response, name: string): string | null {
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';')[0]?.trim() ?? '';
    if (pair.startsWith(`${name}=`) && pair.length > name.length + 1) return pair;
  }
  return null;
}

function locationOf(response: Response): URL | null {
  const location = response.headers.get('location');
  return location === null ? null : new URL(location);
}

/** 09:00: install → fake consent → callback branch (a). Returns the new account id. */
async function installThroughFakeConsent(sim: Simulation): Promise<string | null> {
  const { deps } = sim;
  const env = deps.env;

  const install = await handleHubSpotInstall(new Request(`${env.APP_URL}/api/hubspot/install`, { headers: { 'x-real-ip': '198.51.100.7' } }), deps);
  const consentUrl = locationOf(install);
  const stateCookie = setCookiePair(install, STATE_COOKIE_NAME);
  sim.check('install.redirects_to_fake_consent', install.status === 302 && consentUrl?.pathname === '/dev/fake-hubspot/authorize' && stateCookie !== null);
  if (consentUrl === null || stateCookie === null) return null;
  const devContext = { env, fakes: sim.fakes };
  const view = buildConsentView(Object.fromEntries(consentUrl.searchParams), devContext);
  sim.check('install.fake_consent_page_shows_required_scopes', view.kind === 'consent', `view ${view.kind}`);

  // The consent page's form, approved: the decision route mints a code and redirects to the callback.
  const form = new URLSearchParams(consentUrl.searchParams);
  form.set('decision', 'approve');
  const body = form.toString();
  const decision = await handleFakeHubSpotDecision(
    new Request(`${env.APP_URL}${FAKE_HUBSPOT_DECISION_PATH}`, {
      method: 'POST',
      headers: { origin: env.APP_URL, 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(body)) },
      body,
    }),
    devContext,
  );
  const callbackUrl = locationOf(decision);
  sim.check('install.consent_redirects_to_callback', decision.status === 303 && callbackUrl?.href.startsWith(env.HUBSPOT_REDIRECT_URI) === true);
  if (callbackUrl === null) return null;

  const callback = await handleHubSpotCallback(new Request(callbackUrl, { headers: { cookie: stateCookie } }), deps);
  const next = locationOf(callback);
  const pendingCookie = setCookiePair(callback, PENDING_INSTALL_COOKIE_NAME);
  const pending = pendingCookie === null ? null : readPendingInstall(env, pendingCookie.slice(PENDING_INSTALL_COOKIE_NAME.length + 1), deps.clock.now());
  sim.check(
    'install.callback_branch_a_to_onboarding_email',
    callback.status === 303 && next?.pathname === ONBOARDING_EMAIL_PATH && pending !== null,
    `status ${callback.status}, next ${next?.pathname ?? 'none'}, pending_install ${pending === null ? 'missing' : 'set'}`,
  );
  sim.record('step', 'install.completed', {
    branch: 'new_portal',
    next: next?.pathname ?? null,
    pendingInstallCookie: pending !== null,
    installed: sim.fakes.hubspot.isInstalled(),
  });
  return pending?.accountId ?? null;
}

/** 09:00:30 (M3: the magic link opened on a fresh cookie jar → /auth/confirm → bound). */
async function bindOwner(sim: Simulation, accountId: string): Promise<void> {
  const email = sim.fakes.hubspot.portal.installerEmail;
  const { userId } = await sim.deps.auth.createUser(email);
  await sim.db.tx(async (tx) => {
    await tx.query('insert into public.users (auth_user_id, account_id, email) values ($1, $2, $3)', [userId, accountId, email]);
    await tx.query(
      `update public.accounts
          set owner_user_id = $2, pending_owner_email = null, pending_owner_expires_at = null, pending_owner_auth_user_id = null
        where id = $1`,
      [accountId, userId],
    );
  });
  sim.scenario.ownerEmail = email;
  sim.record('step', 'owner.bound', { via: 'seed_direct_insert' });
}

/** 09:01:30: both enquiry forms selected, the newsletter form detected and unticked (M3: /onboarding/forms). */
async function selectForms(sim: Simulation, accountId: string): Promise<void> {
  const hubspot = sim.fakes.hubspot;
  const now = sim.clock.now();
  const forms = [
    { name: 'Contact us', selected: true, newsletter: false },
    { name: 'Request a quote', selected: true, newsletter: false },
    { name: 'Newsletter signup', selected: false, newsletter: true },
  ];
  for (const form of forms) {
    await sim.db.query(
      `insert into public.selected_forms
         (account_id, form_id, form_name, form_type, selected, newsletter_detected, intake_floor_at, cursor_submitted_at)
       values ($1, $2, $3, 'hubspot', $4, $5, $6, $6)`,
      [accountId, hubspot.formIdByName(form.name), form.name, form.selected, form.newsletter, now],
    );
  }
  sim.record('step', 'forms.selected', { selected: ['Contact us', 'Request a quote'], unticked: ['Newsletter signup'] });
}

/** 09:02 (M3: /onboarding/preferences). PLAN §13 / D-39 owner settings. */
async function savePreferences(sim: Simulation, accountId: string): Promise<void> {
  const owner = sim.scenario.ownerEmail ?? sim.fakes.hubspot.portal.installerEmail;
  await sim.db.query(
    `update public.settings
        set mail_client = 'gmail', gmail_account_email = $2, notify_emails = $3, notify_emails_verified = $3,
            quiet_start_hour = 19, quiet_end_hour = 8, skip_weekends = false, followups_enabled = true,
            bcc_address = $4, preferences_saved_at = $5
      where account_id = $1`,
    [accountId, owner, [owner], `${sim.fakes.hubspot.portal.portalId}@bcc.hubspot.com`, sim.clock.now()],
  );
  sim.record('step', 'preferences.saved', { mailClient: 'gmail', notifyEmails: 1, quietHours: '19-08', skipWeekends: false, bcc: true });
}

/** 09:04:30: Finish (M3: /onboarding/baseline) → onboarding_completed_at → applyProcessingState → active. */
async function finishOnboarding(sim: Simulation, accountId: string): Promise<void> {
  const now = sim.clock.now();
  await sim.db.query('update public.accounts set onboarding_completed_at = $2 where id = $1', [accountId, now]);
  const applied = await applyProcessingState(sim.deps, accountId);
  sim.scenario.onboardingCompletedAt = now;
  sim.record('step', 'onboarding.completed', { previous: applied?.previous ?? null, state: applied?.next ?? null });
}

/**
 * Schedules the pre-run steps and runs them (time travel to 09:04:30), then checks the account the
 * scenario starts from.
 */
export async function seedActiveAccount(sim: Simulation): Promise<void> {
  const { travel } = sim;
  let accountId: string | null = null;
  const withAccount = (step: (id: string) => Promise<void>) => async () => {
    if (accountId !== null) await step(accountId);
  };
  travel.at(sim.local('2026-10-06T09:00:00'), 'install', async () => {
    accountId = await installThroughFakeConsent(sim);
    sim.scenario.accountId = accountId;
  });
  travel.at(sim.local('2026-10-06T09:00:30'), 'bind', withAccount((id) => bindOwner(sim, id)));
  travel.at(sim.local('2026-10-06T09:01:30'), 'forms', withAccount((id) => selectForms(sim, id)));
  travel.at(sim.local('2026-10-06T09:02:00'), 'preferences', withAccount((id) => savePreferences(sim, id)));
  travel.at(sim.local('2026-10-06T09:04:30'), 'finish', withAccount((id) => finishOnboarding(sim, id)));
  await travel.advanceTo(sim.local('2026-10-06T09:04:30'));

  const floor = sim.local('2026-10-06T09:04:30');
  const account = accountId === null ? null : await sim.db.maybeOne<{
    processing_state: string;
    owner_user_id: string | null;
    onboarding_completed_at: Date | null;
    timezone: string | null;
  }>('select processing_state, owner_user_id, onboarding_completed_at, timezone from public.accounts where id = $1', [accountId]);
  sim.check('seed.account_active', account?.processing_state === 'active', `processing_state ${account?.processing_state ?? 'missing'}`);
  sim.check('seed.owner_bound', account !== null && account.owner_user_id !== null);
  sim.check('seed.timezone_from_hubspot', account?.timezone === 'America/New_York', `timezone ${account?.timezone ?? 'null'}`);
  sim.check(
    'seed.onboarding_completed_at_0904_30',
    account?.onboarding_completed_at?.getTime() === floor.getTime(),
    `onboarding_completed_at ${account?.onboarding_completed_at?.toISOString() ?? 'null'}`,
  );

  const forms = accountId === null ? [] : await sim.db.query<{ form_name: string; selected: boolean; intake_floor_at: Date }>(
    'select form_name, selected, intake_floor_at from public.selected_forms where account_id = $1 order by form_name',
    [accountId],
  );
  const selected = forms.filter((form) => form.selected).map((form) => form.form_name);
  sim.check('seed.both_enquiry_forms_selected', selected.join(',') === 'Contact us,Request a quote', `selected ${selected.join(', ')}`);
  sim.check(
    'seed.floors_at_onboarding_complete',
    forms.length === 3 && forms.every((form) => form.intake_floor_at.getTime() === floor.getTime()),
    `floors ${[...new Set(forms.map((form) => form.intake_floor_at.toISOString()))].join(', ')}`,
  );
  sim.check('seed.owner_steps_within_5_minutes', sim.clock.nowMs() - sim.local('2026-10-06T09:00:00').getTime() <= 5 * 60_000);
}
