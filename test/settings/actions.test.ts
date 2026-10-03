import { describe, expect, it } from 'vitest';
import { runDisconnect, runSaveForms, runSavePreferences, runSettingsPause } from '@/server/actions/settings';
import { useTestDb as setUpTestDb } from '../db/harness';
import { accountState, connectionState, OWNER_EMAIL, seedSettingsAccount, setUpSettingsRig, subscribe } from './support';

// /dashboard/settings' Server Action bodies (PLAN §7.5, brief §5.11, D-33, D-46): each on the owner's
// scope, answering with a path and codes only (never an address).

const getDb = setUpTestDb();
const getRig = setUpSettingsRig(getDb);

const FORM_A = 'b1f0c6a2-3d4e-4f50-8a61-7b2c9d0e1f01';
const FORM_B = 'b1f0c6a2-3d4e-4f50-8a61-7b2c9d0e1f02';

function form(fields: Record<string, string | readonly string[]>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of typeof value === 'string' ? [value] : value) data.append(name, item);
  }
  return data;
}

function preferences(overrides: Record<string, string> = {}): FormData {
  return form({
    mail_client: 'gmail',
    gmail_account_email: '',
    notify_email_0: OWNER_EMAIL,
    notify_email_1: '',
    notify_email_2: '',
    quiet_start_hour: '20',
    quiet_end_hour: '8',
    skip_weekends: 'on',
    followups_enabled: 'on',
    bcc_address: '',
    timezone: '',
    ...overrides,
  });
}

async function settingsRow(accountId: string) {
  return getDb().one<{ notify_emails: string[]; notify_emails_verified: string[]; mail_client: string; bcc_address: string | null; followups_enabled: boolean; quiet_start_hour: number }>(
    `select notify_emails, notify_emails_verified, mail_client, bcc_address, followups_enabled, quiet_start_hour from settings where account_id = $1`,
    [accountId],
  );
}

describe('saving preferences from settings', () => {
  it('saves every field; an extra address gets a confirmation email and the owner a change alert', async () => {
    const rig = getRig();
    const account = await seedSettingsAccount(rig);

    const outcome = await runSavePreferences(rig.deps, account.scope, preferences({ notify_email_1: 'Office@Brightside-Plumbing.example', bcc_address: '24681357@bcc.hubspot.com', quiet_start_hour: '21' }));

    expect(outcome).toEqual({ redirect: '/dashboard/settings?result=preferences_saved&sent=1&alert=1' });
    expect(await settingsRow(account.accountId)).toEqual({
      notify_emails: [OWNER_EMAIL, 'office@brightside-plumbing.example'],
      notify_emails_verified: [OWNER_EMAIL],
      mail_client: 'gmail',
      bcc_address: '24681357@bcc.hubspot.com',
      followups_enabled: true,
      quiet_start_hour: 21,
    });
    const kinds = rig.fakes.mailer.sent.map((mail) => [mail.kind, mail.to]);
    expect(kinds).toEqual(expect.arrayContaining([['verify_notify', ['office@brightside-plumbing.example']], ['owner_alert', [OWNER_EMAIL]]]));
    // Codes only in the path: never an address.
    expect(JSON.stringify(outcome)).not.toContain('@');
  });

  it('a BCC address that is not HubSpot\'s is saved with a warning flag; a change of BCC alone alerts the owner', async () => {
    const rig = getRig();
    const account = await seedSettingsAccount(rig);
    const outcome = await runSavePreferences(rig.deps, account.scope, preferences({ bcc_address: 'me@example.net' }));
    expect(outcome).toEqual({ redirect: '/dashboard/settings?result=preferences_saved&sent=0&bcc=1&alert=1' });
    expect(rig.fakes.mailer.sent.map((mail) => mail.kind)).toEqual(['owner_alert']);
  });

  it('nothing about addresses changed: no alert', async () => {
    const rig = getRig();
    const account = await seedSettingsAccount(rig);
    await runSavePreferences(rig.deps, account.scope, preferences());
    const sentBefore = rig.fakes.mailer.sent.length;
    expect(await runSavePreferences(rig.deps, account.scope, preferences({ mail_client: 'other', quiet_start_hour: '22' }))).toEqual({
      redirect: '/dashboard/settings?result=preferences_saved&sent=0',
    });
    expect(rig.fakes.mailer.sent).toHaveLength(sentBefore);
  });

  it('an invalid form comes back with its issues and the owner\'s input, and saves nothing', async () => {
    const rig = getRig();
    const account = await seedSettingsAccount(rig);
    const before = await settingsRow(account.accountId);
    const outcome = await runSavePreferences(rig.deps, account.scope, preferences({ notify_email_0: 'not-an-address', quiet_start_hour: '99' }));
    expect(outcome).toMatchObject({
      issues: expect.arrayContaining([
        { path: 'notify_emails.0', code: 'invalid_email' },
        { path: 'quiet_start_hour', code: 'invalid_hour' },
      ]),
      values: { notify_emails: ['not-an-address', '', ''], quiet_start_hour: '99' },
    });
    expect(await settingsRow(account.accountId)).toEqual(before);
  });

  it('a mail client outside the four choices is refused', async () => {
    const rig = getRig();
    const account = await seedSettingsAccount(rig);
    const outcome = await runSavePreferences(rig.deps, account.scope, preferences({ mail_client: 'thunderbird' }));
    expect(outcome).toMatchObject({ issues: [{ path: 'mail_client', code: 'invalid_choice' }] });
  });

  it('turning follow-ups off cancels no job (they are skipped when due), and the switch is saved', async () => {
    const rig = getRig();
    const account = await seedSettingsAccount(rig);
    const outcome = await runSavePreferences(rig.deps, account.scope, preferences({ followups_enabled: '' }));
    expect(outcome).toMatchObject({ redirect: expect.stringContaining('result=preferences_saved') });
    expect((await settingsRow(account.accountId)).followups_enabled).toBe(false);
    expect(await getDb().query(`select 1 from scheduled_jobs where account_id = $1 and status = 'cancelled'`, [account.accountId])).toEqual([]);
  });
});

describe('forms from settings', () => {
  it('saves the ticked forms; a newly ticked form only takes submissions from now on', async () => {
    const rig = getRig();
    const account = await seedSettingsAccount(rig);
    rig.clock.advance({ hours: 3 });
    const now = rig.clock.now();
    expect(await runSaveForms(rig.deps, account.scope, form({ form_id: [FORM_A, FORM_B] }))).toBe('/dashboard/settings?result=forms_saved');
    const rows = await getDb().query<{ form_id: string; selected: boolean; intake_floor_at: Date }>(
      `select form_id, selected, intake_floor_at from selected_forms where account_id = $1 and form_id <> 'form-1' order by form_id`,
      [account.accountId],
    );
    expect(rows).toEqual([
      { form_id: FORM_A, selected: true, intake_floor_at: now },
      { form_id: FORM_B, selected: true, intake_floor_at: now },
    ]);
  });

  it('no form ticked, or a form HubSpot does not list: back to the forms page with the code', async () => {
    const rig = getRig();
    const account = await seedSettingsAccount(rig);
    expect(await runSaveForms(rig.deps, account.scope, form({}))).toBe('/dashboard/settings/forms?error=none_selected');
    expect(await runSaveForms(rig.deps, account.scope, form({ form_id: 'not-a-form-of-this-portal' }))).toBe('/dashboard/settings/forms?error=unknown_form');
  });
});

describe('pause all and resume from settings', () => {
  it('pauses, resumes, and says when nothing changed', async () => {
    const rig = getRig();
    const account = await seedSettingsAccount(rig);
    expect(await runSettingsPause(rig.deps, account.scope, true)).toBe('/dashboard/settings?result=paused');
    expect(await accountState(getDb(), account.accountId)).toMatchObject({ processing_state: 'paused' });
    expect(await runSettingsPause(rig.deps, account.scope, true)).toBe('/dashboard/settings?result=already_paused');
    expect(await runSettingsPause(rig.deps, account.scope, false)).toBe('/dashboard/settings?result=resumed');
    expect(await accountState(getDb(), account.accountId)).toMatchObject({ processing_state: 'active', paused_at: null });
    expect(await runSettingsPause(rig.deps, account.scope, false)).toBe('/dashboard/settings?result=not_paused');
  });

  it('resuming while HubSpot is disconnected ends the pause but says it is still not running', async () => {
    const rig = getRig();
    const account = await seedSettingsAccount(rig);
    await runSettingsPause(rig.deps, account.scope, true);
    await runDisconnect(rig.deps, account.scope, form({}), { sleep: rig.sleep });
    expect(await runSettingsPause(rig.deps, account.scope, false)).toBe('/dashboard/settings?result=resumed_not_active');
  });
});

describe('disconnect from settings', () => {
  it('disconnects and reports the billing outcome as a code', async () => {
    const rig = getRig();
    const account = await seedSettingsAccount(rig);
    await subscribe(rig, account.scope);
    expect(await runDisconnect(rig.deps, account.scope, form({ cancel_billing: 'on' }), { sleep: rig.sleep })).toBe('/dashboard/settings?result=disconnected&billing=cancelled');
    expect(await connectionState(getDb(), account.accountId)).toMatchObject({ status: 'disconnected' });
    expect(await runDisconnect(rig.deps, account.scope, form({}), { sleep: rig.sleep })).toBe('/dashboard/settings?result=already_disconnected&billing=not_requested');
  });

  it('a cancel after the first payment came due reports it as such, never as "nothing was charged"', async () => {
    const rig = getRig();
    const account = await seedSettingsAccount(rig);
    await subscribe(rig, account.scope);
    // The start_at (the trial's end) has passed; Razorpay's activation hasn't reached us yet.
    rig.clock.advance({ days: 14, minutes: 5 });
    expect(await runDisconnect(rig.deps, account.scope, form({ cancel_billing: 'on' }), { sleep: rig.sleep })).toBe(
      '/dashboard/settings?result=disconnected&billing=cancelled_after_payment',
    );
  });

  it('reports a failed HubSpot uninstall as a code, so the page can say to remove the app by hand', async () => {
    const rig = getRig();
    const account = await seedSettingsAccount(rig);
    rig.fakes.hubspot.injectFailure('uninstallApp', { kind: 'server_error' });
    expect(await runDisconnect(rig.deps, account.scope, form({}), { sleep: rig.sleep })).toBe(
      '/dashboard/settings?result=disconnected&billing=not_requested&uninstall=failed',
    );
    expect(await connectionState(getDb(), account.accountId)).toMatchObject({ status: 'disconnected' });
  });

  it('reports an uninstall that could not run (HubSpot had already revoked the connection) as skipped', async () => {
    const rig = getRig();
    const account = await seedSettingsAccount(rig);
    await getDb().query(`update hubspot_connections set status = 'revoked' where account_id = $1`, [account.accountId]);
    expect(await runDisconnect(rig.deps, account.scope, form({}), { sleep: rig.sleep })).toBe(
      '/dashboard/settings?result=disconnected&billing=not_requested&uninstall=skipped',
    );
  });

  it('without the box ticked the subscription is kept', async () => {
    const rig = getRig();
    const account = await seedSettingsAccount(rig);
    const id = await subscribe(rig, account.scope);
    expect(await runDisconnect(rig.deps, account.scope, form({ cancel_billing: 'off' }), { sleep: rig.sleep })).toBe('/dashboard/settings?result=disconnected&billing=not_requested');
    expect((await rig.fakes.billing.fetchSubscription(id)).status).toBe('authenticated');
  });
});
