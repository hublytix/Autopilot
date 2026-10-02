import { beforeEach, describe, expect, it } from 'vitest';
import { createNotificationRegistry, getNotification, reserveInTx, resumeReservation } from '@/server/services/notifications';
import { NotificationKeys, NotificationPredicates } from '@/server/services/notifications/predicates';
import { registerAccountNotifications } from '@/server/services/accounts/emails';
import {
  ACTION_LINK_LIMITS,
  confirmNotifyAddress,
  registerOnboardingNotifications,
  settingsChangeAlertKey,
  verifyNotifyKey,
  verifyNotifyLinkState,
  type VerifyNotifyState,
} from '@/server/services/onboarding';
import { useTestDb as setUpTestDb } from '../db/harness';
import { createOnboardingRig, DAY, MINUTE, OWNER_EMAIL, savePrefs, settingsOf, verifyLinkToken, type OnboardingRig } from './support';

// /a/[token]/verify-notify (PLAN §7.4, D-46): the GET page changes nothing; the POST uses the link
// once and confirms the address; the confirmation email and the settings alert can be resumed by
// the sweeper through the registered resumers.

const getDb = setUpTestDb();
const EXTRA = 'office@example.com';
const IP = '198.51.100.7';

let rig: OnboardingRig;

beforeEach(async () => {
  rig = await createOnboardingRig(getDb());
});

/** Saves an extra address and returns the token from its confirmation email. */
async function sendLink(): Promise<string> {
  await savePrefs(rig, { notify_emails: [OWNER_EMAIL, EXTRA] });
  const mail = rig.fakes.mailer.sent.filter((sent) => sent.kind === 'verify_notify').at(-1);
  if (mail === undefined) throw new Error('no verify_notify email');
  expect(mail.to).toEqual([EXTRA]);
  expect(mail.subject).toBe('Confirm lead alerts from Hublytix Autopilot');
  expect(mail.text).toContain('The link works for 7 days');
  return verifyLinkToken(mail.text);
}

async function view(token: string, ip = IP): Promise<VerifyNotifyState> {
  return verifyNotifyLinkState(rig.deps, { token, ip });
}

async function confirm(token: string, ip = IP): Promise<VerifyNotifyState> {
  return confirmNotifyAddress(rig.deps, { token, ip });
}

async function useCount(token: string): Promise<number> {
  const row = await getDb().one<{ use_count: number }>(
    `select use_count from action_tokens where purpose = 'verify_notify' and token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
    [token],
  );
  return row.use_count;
}

describe('verify-notify link', () => {
  it('shows the address on GET and changes nothing', async () => {
    const token = await sendLink();
    expect(await view(token)).toEqual({ type: 'confirm', address: EXTRA });
    expect(await view(token)).toEqual({ type: 'confirm', address: EXTRA });
    expect((await settingsOf(getDb(), rig.accountId)).notify_emails_verified).toEqual([OWNER_EMAIL]);
    expect(await useCount(token)).toBe(0);
  });

  it('confirms the address on POST, once', async () => {
    const token = await sendLink();
    expect(await confirm(token)).toEqual({ type: 'confirmed', address: EXTRA });
    expect((await settingsOf(getDb(), rig.accountId)).notify_emails_verified).toEqual([OWNER_EMAIL, EXTRA]);
    expect(await useCount(token)).toBe(1);

    // A second submit (or a reload after it) shows the result and changes nothing.
    expect(await confirm(token)).toEqual({ type: 'confirmed', address: EXTRA });
    expect(await view(token)).toEqual({ type: 'confirmed', address: EXTRA });
    expect((await settingsOf(getDb(), rig.accountId)).notify_emails_verified).toEqual([OWNER_EMAIL, EXTRA]);
    expect(await useCount(token)).toBe(1);
  });

  it('cannot confirm the address again after the owner removed it and added it back', async () => {
    const token = await sendLink();
    await confirm(token);
    rig.clock.advance(MINUTE);
    await savePrefs(rig, { notify_emails: [OWNER_EMAIL] });
    rig.clock.advance(MINUTE);
    await savePrefs(rig, { notify_emails: [OWNER_EMAIL, EXTRA] });
    expect(await view(token)).toEqual({ type: 'used' });
    expect(await confirm(token)).toEqual({ type: 'used' });
    expect((await settingsOf(getDb(), rig.accountId)).notify_emails_verified).toEqual([OWNER_EMAIL]);
  });

  it('does nothing for an address the owner removed before it was confirmed', async () => {
    const token = await sendLink();
    rig.clock.advance(MINUTE);
    await savePrefs(rig, { notify_emails: [OWNER_EMAIL] });
    expect(await view(token)).toEqual({ type: 'removed' });
    expect(await confirm(token)).toEqual({ type: 'removed' });
    expect(await useCount(token)).toBe(0);
  });

  it('expires after 7 days', async () => {
    const token = await sendLink();
    rig.clock.advance(7 * DAY);
    expect(await view(token)).toEqual({ type: 'expired' });
    expect(await confirm(token)).toEqual({ type: 'expired' });
    expect((await settingsOf(getDb(), rig.accountId)).notify_emails_verified).toEqual([OWNER_EMAIL]);
  });

  it('refuses a malformed or unknown token', async () => {
    expect(await view('apt_not-a-token')).toEqual({ type: 'invalid' });
    expect(await confirm(`apt_${'A'.repeat(43)}`)).toEqual({ type: 'invalid' });
  });

  it('refuses a revoked token (the account was revoked or disconnected)', async () => {
    const token = await sendLink();
    await getDb().query(`update action_tokens set revoked_at = $2 where account_id = $1`, [rig.accountId, rig.clock.now()]);
    expect(await confirm(token)).toEqual({ type: 'invalid' });
  });

  it('rate-limits one token to 20 requests a minute', async () => {
    const token = await sendLink();
    for (let request = 0; request < ACTION_LINK_LIMITS.perToken; request += 1) {
      expect((await view(token, `198.51.100.${request + 10}`)).type).toBe('confirm');
    }
    expect(await view(token, '198.51.100.99')).toMatchObject({ type: 'rate_limited' });
    expect(await confirm(token, '198.51.100.99')).toMatchObject({ type: 'rate_limited' });
    expect((await settingsOf(getDb(), rig.accountId)).notify_emails_verified).toEqual([OWNER_EMAIL]);
    rig.clock.advance(MINUTE);
    expect(await confirm(token)).toEqual({ type: 'confirmed', address: EXTRA });
  });

  it('rate-limits one IP to 30 requests a minute', async () => {
    const token = await sendLink();
    for (let request = 0; request < ACTION_LINK_LIMITS.perIp; request += 1) {
      expect((await view(`apt_${String(request).padStart(43, 'x')}`)).type).toBe('invalid');
    }
    expect(await view(token)).toMatchObject({ type: 'rate_limited' });
  });
});

describe('resuming onboarding emails', () => {
  function registry() {
    const notifications = createNotificationRegistry();
    registerOnboardingNotifications({ notifications });
    registerOnboardingNotifications({ notifications });
    registerAccountNotifications({ notifications });
    return notifications;
  }

  it('resends a confirmation email whose first send failed, with a working link', async () => {
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error' });
    await savePrefs(rig, { notify_emails: [OWNER_EMAIL, EXTRA] });
    expect(rig.fakes.mailer.sent).toEqual([]);
    const key = verifyNotifyKey(rig.deps.env, rig.accountId, EXTRA, rig.clock.now());
    const row = await getNotification(getDb(), key);
    expect(row?.status).toBe('sending');
    if (row === null) throw new Error('missing reservation');

    rig.clock.advance(15 * MINUTE);
    expect(await resumeReservation(rig.deps, row, { bySweeper: true }, registry())).toMatchObject({ status: 'sent' });
    const mail = rig.fakes.mailer.sent.at(-1);
    expect(mail?.to).toEqual([EXTRA]);
    expect(await confirm(verifyLinkToken(mail?.text ?? ''))).toEqual({ type: 'confirmed', address: EXTRA });
  });

  it('marks a pending confirmation failed when the address was removed before the resume', async () => {
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error' });
    await savePrefs(rig, { notify_emails: [OWNER_EMAIL, EXTRA] });
    const key = verifyNotifyKey(rig.deps.env, rig.accountId, EXTRA, rig.clock.now());
    rig.clock.advance(MINUTE);
    await savePrefs(rig, { notify_emails: [OWNER_EMAIL] });
    const row = await getNotification(getDb(), key);
    if (row === null) throw new Error('missing reservation');
    expect(await resumeReservation(rig.deps, row, { bySweeper: true }, registry())).toMatchObject({ status: 'failed' });
    expect(rig.fakes.mailer.sent).toEqual([]);
  });

  it('resumes a settings-change alert and still resumes the other owner alerts', async () => {
    await savePrefs(rig);
    await getDb().query(`update accounts set onboarding_completed_at = $2 where id = $1`, [rig.accountId, rig.clock.now()]);
    rig.clock.advance(MINUTE);
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error' });
    const savedAt = rig.clock.now();
    await savePrefs(rig, { bcc_address: '1234567@bcc.hubspot.com' });
    const alertRow = await getNotification(getDb(), settingsChangeAlertKey(rig.accountId, savedAt));
    if (alertRow === null) throw new Error('missing alert reservation');
    expect(alertRow.status).toBe('sending');
    rig.clock.advance(15 * MINUTE);
    expect(await resumeReservation(rig.deps, alertRow, { bySweeper: true }, registry())).toMatchObject({ status: 'sent' });
    expect(rig.fakes.mailer.sent.at(-1)).toMatchObject({ kind: 'owner_alert', to: [OWNER_EMAIL] });

    // A reconnect-attempt alert (services/accounts) goes through the same owner_alert resumer.
    const key = NotificationKeys.ownerAlert(rig.accountId, 'reconnect_attempt', '2026-10-06');
    const reserved = await reserveInTx(getDb(), { kind: 'owner_alert', dedupeKey: key, accountId: rig.accountId, predicates: NotificationPredicates.ownerAlert(), now: rig.clock.now() });
    if (reserved === null) throw new Error('missing reconnect alert reservation');
    expect(await resumeReservation(rig.deps, reserved, { bySweeper: true }, registry())).toMatchObject({ status: 'sent' });
    expect(rig.fakes.mailer.sent.at(-1)?.subject).toBe('Someone tried to connect Hublytix Autopilot to your HubSpot account');
  });
});
