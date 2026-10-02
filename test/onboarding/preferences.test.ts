import { beforeEach, describe, expect, it } from 'vitest';
import {
  allowedHoursPerWeek,
  getPreferences,
  isQuietHour,
  looksLikeHubSpotBcc,
  validatePreferences,
  type PreferencesInput,
  type ValidationContext,
} from '@/server/services/onboarding';
import { useTestDb as setUpTestDb } from '../db/harness';
import { createOnboardingRig, MINUTE, OWNER_EMAIL, preferencesInput, savePrefs, settingsOf, type OnboardingRig } from './support';

// /onboarding/preferences (PLAN §7.5, D-33, D-46): validation (quiet hours, 1–3 addresses, the
// verified subset), confirmation emails to extra addresses only, and change alerts only after
// onboarding is complete.

const FIXED_ZONE: ValidationContext = { timezoneEditable: false, currentTimezone: 'America/New_York' };

function validate(overrides: Partial<PreferencesInput>, context: ValidationContext = FIXED_ZONE) {
  return validatePreferences(preferencesInput(overrides), context);
}

function issuesOf(overrides: Partial<PreferencesInput>, context: ValidationContext = FIXED_ZONE): { path: string; code: string }[] {
  const result = validate(overrides, context);
  return result.ok ? [] : result.issues;
}

describe('quiet hours', () => {
  it('treats a window that wraps past midnight as quiet on both sides of it', () => {
    expect([18, 19, 23, 0, 7, 8].map((hour) => isQuietHour(hour, 19, 8))).toEqual([false, true, true, true, true, false]);
  });

  it('treats equal start and end as no quiet hours', () => {
    expect(allowedHoursPerWeek(9, 9, false)).toBe(168);
    expect(Array.from({ length: 24 }, (_, hour) => isQuietHour(hour, 9, 9)).some(Boolean)).toBe(false);
  });

  it('counts the allowed hours in a week, weekends included or not', () => {
    expect(allowedHoursPerWeek(19, 8, true)).toBe(55);
    expect(allowedHoursPerWeek(19, 8, false)).toBe(77);
    expect(allowedHoursPerWeek(0, 23, true)).toBe(5);
  });
});

describe('validatePreferences', () => {
  it('accepts the D-39 preferences and lower-cases the addresses', () => {
    const result = validate({ notify_emails: ['Owner@Brightside-Plumbing.example'] });
    expect(result).toMatchObject({ ok: true, value: { notifyEmails: [OWNER_EMAIL], quietStartHour: 19, quietEndHour: 8 } });
  });

  it('accepts quiet hours that start and end at the same hour', () => {
    expect(validate({ quiet_start_hour: 22, quiet_end_hour: 22 }).ok).toBe(true);
  });

  it('refuses hours outside 0–23 and hours that are not whole numbers', () => {
    expect(issuesOf({ quiet_start_hour: 24 })).toEqual([{ path: 'quiet_start_hour', code: 'invalid_hour' }]);
    expect(issuesOf({ quiet_end_hour: Number.NaN })).toEqual([{ path: 'quiet_end_hour', code: 'invalid_hour' }]);
    expect(issuesOf({ quiet_end_hour: 7.5 })).toEqual([{ path: 'quiet_end_hour', code: 'invalid_hour' }]);
    expect(issuesOf({ quiet_start_hour: -1 })).toEqual([{ path: 'quiet_start_hour', code: 'invalid_hour' }]);
  });

  it('needs at least one notify address and allows at most three', () => {
    expect(issuesOf({ notify_emails: ['', '  '] })).toEqual([{ path: 'notify_emails', code: 'required' }]);
    expect(issuesOf({ notify_emails: ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com'] })).toEqual([
      { path: 'notify_emails', code: 'too_many' },
    ]);
    expect(validate({ notify_emails: ['a@example.com', 'b@example.com', 'c@example.com'] }).ok).toBe(true);
  });

  it('names the notify address that is not an email address', () => {
    expect(issuesOf({ notify_emails: [OWNER_EMAIL, 'not an address'] })).toEqual([{ path: 'notify_emails.1', code: 'invalid_email' }]);
  });

  it('drops a repeated notify address, whatever its case', () => {
    expect(validate({ notify_emails: ['a@example.com', 'A@Example.com'] })).toMatchObject({ ok: true, value: { notifyEmails: ['a@example.com'] } });
  });

  it('refuses an unknown mail client and malformed optional addresses', () => {
    expect(issuesOf({ mail_client: 'thunderbird' })).toEqual([{ path: 'mail_client', code: 'invalid_choice' }]);
    expect(issuesOf({ bcc_address: 'bcc at hubspot' })).toEqual([{ path: 'bcc_address', code: 'invalid_email' }]);
    expect(issuesOf({ gmail_account_email: 'nope' })).toEqual([{ path: 'gmail_account_email', code: 'invalid_email' }]);
  });

  it('ignores the Gmail account address for another mail client', () => {
    expect(validate({ mail_client: 'outlook_work', gmail_account_email: 'nope' })).toMatchObject({ ok: true, value: { gmailAccountEmail: null } });
  });

  it('asks for a timezone only when detection failed', () => {
    const failed: ValidationContext = { timezoneEditable: true, currentTimezone: null };
    expect(issuesOf({ timezone: null }, failed)).toEqual([{ path: 'timezone', code: 'timezone_required' }]);
    expect(issuesOf({ timezone: 'Mars/Olympus_Mons' }, failed)).toEqual([{ path: 'timezone', code: 'invalid_timezone' }]);
    expect(validate({ timezone: 'Asia/Kolkata' }, failed)).toMatchObject({ ok: true, value: { timezone: 'Asia/Kolkata' } });
    // A zone that came from HubSpot is not editable: whatever is posted is ignored.
    expect(validate({ timezone: 'Asia/Kolkata' })).toMatchObject({ ok: true, value: { timezone: null } });
  });

  it('soft-checks the BCC address against HubSpot BCC and forwarding domains', () => {
    expect(looksLikeHubSpotBcc('1234567@bcc.hubspot.com')).toBe(true);
    expect(looksLikeHubSpotBcc('1234567@bcc.eu1.hubspot.com')).toBe(true);
    expect(looksLikeHubSpotBcc('abc@forward.hubspot.com')).toBe(true);
    expect(looksLikeHubSpotBcc('me@hubspot.com')).toBe(false);
    expect(looksLikeHubSpotBcc('me@bcc.hubspot.com.evil.example')).toBe(false);
  });
});

describe('savePreferences', () => {
  const getDb = setUpTestDb();
  let rig: OnboardingRig;

  beforeEach(async () => {
    rig = await createOnboardingRig(getDb());
  });

  const sentKinds = (): string[] => rig.fakes.mailer.sent.map((mail) => mail.kind);

  it('starts the form with the owner address and the documented defaults', async () => {
    const view = await getPreferences(rig.scope, rig.deps);
    expect(view).toMatchObject({
      ownerEmail: OWNER_EMAIL,
      notifyEmails: [{ address: OWNER_EMAIL, verified: true, isOwner: true }],
      quietStartHour: 19,
      quietEndHour: 8,
      skipWeekends: true,
      followupsEnabled: true,
      savedAt: null,
      timezone: 'America/New_York',
      timezoneEditable: false,
    });
  });

  it("saves the preferences with the owner's address confirmed at once and no email sent", async () => {
    const result = await savePrefs(rig);
    expect(result).toEqual({ ok: true, verificationsSent: 0, verificationLimited: false, bccWarning: false, alertReserved: false });
    expect(await settingsOf(getDb(), rig.accountId)).toMatchObject({
      notify_emails: [OWNER_EMAIL],
      notify_emails_verified: [OWNER_EMAIL],
      mail_client: 'gmail',
      quiet_start_hour: 19,
      quiet_end_hour: 8,
      skip_weekends: false,
      preferences_saved_at: rig.clock.now(),
    });
    expect(rig.fakes.mailer.sent).toEqual([]);
  });

  it('sends a confirmation email to an extra address only, which stays unverified', async () => {
    const result = await savePrefs(rig, { notify_emails: [OWNER_EMAIL, 'Office@Example.com'] });
    expect(result).toMatchObject({ ok: true, verificationsSent: 1 });
    const settings = await settingsOf(getDb(), rig.accountId);
    expect(settings.notify_emails).toEqual([OWNER_EMAIL, 'office@example.com']);
    expect(settings.notify_emails_verified).toEqual([OWNER_EMAIL]);
    expect(rig.fakes.mailer.sent.map((mail) => [mail.kind, mail.to])).toEqual([['verify_notify', ['office@example.com']]]);
  });

  it('keeps a confirmed address confirmed and forgets one that is removed', async () => {
    await savePrefs(rig, { notify_emails: [OWNER_EMAIL, 'office@example.com'] });
    await getDb().query(`update settings set notify_emails_verified = array_append(notify_emails_verified, 'office@example.com') where account_id = $1`, [
      rig.accountId,
    ]);
    rig.clock.advance(MINUTE);
    await savePrefs(rig, { notify_emails: ['office@example.com', OWNER_EMAIL] });
    expect((await settingsOf(getDb(), rig.accountId)).notify_emails_verified.sort()).toEqual(['office@example.com', OWNER_EMAIL].sort());

    rig.clock.advance(MINUTE);
    await savePrefs(rig, { notify_emails: [OWNER_EMAIL] });
    expect((await settingsOf(getDb(), rig.accountId)).notify_emails_verified).toEqual([OWNER_EMAIL]);
  });

  it('lets the owner list only an extra address, which waits for its confirmation', async () => {
    await savePrefs(rig, { notify_emails: ['office@example.com'] });
    const settings = await settingsOf(getDb(), rig.accountId);
    expect(settings.notify_emails).toEqual(['office@example.com']);
    expect(settings.notify_emails_verified).toEqual([]);
  });

  it('sends one confirmation per unconfirmed address per day, however often the owner saves', async () => {
    await savePrefs(rig, { notify_emails: [OWNER_EMAIL, 'office@example.com'] });
    rig.clock.advance(MINUTE);
    expect(await savePrefs(rig, { notify_emails: [OWNER_EMAIL, 'office@example.com'], quiet_start_hour: 20 })).toMatchObject({ verificationsSent: 0 });
    expect(sentKinds()).toEqual(['verify_notify']);
    rig.clock.advance(24 * 60 * MINUTE);
    expect(await savePrefs(rig, { notify_emails: [OWNER_EMAIL, 'office@example.com'] })).toMatchObject({ verificationsSent: 1 });
    expect(sentKinds()).toEqual(['verify_notify', 'verify_notify']);
  });

  it('flags a BCC address that does not look like a HubSpot one, and saves it anyway', async () => {
    expect(await savePrefs(rig, { bcc_address: 'me@example.com' })).toMatchObject({ ok: true, bccWarning: true });
    expect((await settingsOf(getDb(), rig.accountId)).bcc_address).toBe('me@example.com');
    expect(await savePrefs(rig, { bcc_address: '1234567@bcc.hubspot.com' })).toMatchObject({ ok: true, bccWarning: false });
  });

  it("stores the owner's timezone when HubSpot's could not be read", async () => {
    await getDb().query(`update accounts set timezone = null, timezone_source = null where id = $1`, [rig.accountId]);
    expect(await savePrefs(rig)).toEqual({ ok: false, issues: [{ path: 'timezone', code: 'timezone_required' }] });
    expect(await savePrefs(rig, { timezone: 'Europe/London' })).toMatchObject({ ok: true });
    expect(await getDb().one(`select timezone, timezone_source from accounts where id = $1`, [rig.accountId])).toEqual({
      timezone: 'Europe/London',
      timezone_source: 'owner',
    });
  });

  it('saves nothing when the form has an error', async () => {
    expect(await savePrefs(rig, { notify_emails: [] })).toEqual({ ok: false, issues: [{ path: 'notify_emails', code: 'required' }] });
    expect((await settingsOf(getDb(), rig.accountId)).preferences_saved_at).toBeNull();
  });

  describe('change alerts', () => {
    it('sends no alert during onboarding, however the addresses change', async () => {
      await savePrefs(rig);
      rig.clock.advance(MINUTE);
      const result = await savePrefs(rig, { notify_emails: [OWNER_EMAIL, 'office@example.com'], bcc_address: '1@bcc.hubspot.com' });
      expect(result).toMatchObject({ ok: true, alertReserved: false });
      expect(sentKinds()).toEqual(['verify_notify']);
    });

    it("alerts the owner's own address when the addresses change after onboarding", async () => {
      await savePrefs(rig);
      await getDb().query(`update accounts set onboarding_completed_at = $2 where id = $1`, [rig.accountId, rig.clock.now()]);
      rig.clock.advance(MINUTE);
      const result = await savePrefs(rig, { notify_emails: [OWNER_EMAIL, 'office@example.com'] });
      expect(result).toMatchObject({ ok: true, alertReserved: true, verificationsSent: 1 });
      const alert = rig.fakes.mailer.sent.find((mail) => mail.kind === 'owner_alert');
      expect(alert?.to).toEqual([OWNER_EMAIL]);
      expect(alert?.subject).toBe('Your Hublytix Autopilot alert settings changed');
      expect(alert?.text).toContain('office@example.com');
      expect(alert?.text).toContain('waiting for confirmation');
    });

    it('alerts when only the BCC address changes after onboarding', async () => {
      await savePrefs(rig);
      await getDb().query(`update accounts set onboarding_completed_at = $2 where id = $1`, [rig.accountId, rig.clock.now()]);
      rig.clock.advance(MINUTE);
      expect(await savePrefs(rig, { bcc_address: '1234567@bcc.hubspot.com' })).toMatchObject({ alertReserved: true });
      expect(sentKinds()).toEqual(['owner_alert']);
    });

    it('sends no alert when only other preferences change after onboarding', async () => {
      await savePrefs(rig);
      await getDb().query(`update accounts set onboarding_completed_at = $2 where id = $1`, [rig.accountId, rig.clock.now()]);
      rig.clock.advance(MINUTE);
      expect(await savePrefs(rig, { quiet_start_hour: 21, skip_weekends: true, notify_emails: [OWNER_EMAIL.toUpperCase()] })).toMatchObject({
        alertReserved: false,
      });
      expect(rig.fakes.mailer.sent).toEqual([]);
    });
  });
});
