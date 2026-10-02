import 'server-only';
import { IANAZone } from 'luxon';
import { z } from 'zod';
import { errorCode } from '@/server/domain/errors';
import { MAIL_CLIENTS, TIMEZONE_SOURCES, type MailClient, type TimezoneSource } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { hitFixedWindow, rateLimitKeyHash } from '@/server/security/rate-limit';
import { normaliseEmail, type OwnerScope } from '@/server/services/auth';
import { getNotification, reserveAndSend, reserveInTx, type ReserveAndSendInput } from '@/server/services/notifications';
import { NotificationPredicates } from '@/server/services/notifications/predicates';
import { settingsChangeAlertKey, settingsChangeAlertPlan } from './change-alerts';
import { verifyNotifyKey, verifyNotifyPlan } from './notify-verification';
import { allowedHoursPerWeek, DEFAULT_QUIET_END_HOUR, DEFAULT_QUIET_START_HOUR, isValidHour } from './quiet-hours';

// The owner's preferences (brief §4 step 2.4, PLAN §5 `settings`, §7.5 /onboarding/preferences,
// D-12, D-13, D-33, D-46):
// - mail client (4), with an optional Gmail account address for the compose link;
// - 1–3 lead-alert addresses, stored lower-cased; the owner's verified sign-in email is confirmed
//   at once, any other address gets a confirmation email and receives nothing until confirmed;
// - quiet hours (whole hours, start = end means none, a week with no allowed hour is refused), skip
//   weekends (default on), follow-ups (default on);
// - the timezone HubSpot reported; the owner chooses one only when detection failed (or chose before);
// - an optional BCC address, soft-checked against HubSpot's BCC/forwarding domains (a warning only).
// Saving sets `preferences_saved_at`. After onboarding is complete, a change to the alert addresses
// or the BCC address emails the owner an alert; the first save during onboarding never does.

export const MAX_NOTIFY_EMAILS = 3;
/** Confirmation emails per account per UTC day (D-36 abuse limit on notify-address verification). */
export const VERIFY_EMAILS_PER_DAY = 10;
const DAY_MS = 86_400_000;

/** `name@bcc.<…>hubspot.com` / `name@forward.<…>hubspot.com` (D-46): anything else gets a warning. */
const HUBSPOT_BCC_DOMAIN = /@(?:bcc|forward)(?:\.[a-z0-9-]+)*\.hubspot\.com$/i;

export function looksLikeHubSpotBcc(address: string): boolean {
  return HUBSPOT_BCC_DOMAIN.test(address);
}

export function isValidTimezone(zone: string): boolean {
  return zone.length > 0 && zone.length <= 64 && IANAZone.isValidZone(zone);
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

export interface NotifyAddressView {
  address: string;
  verified: boolean;
  /** The owner's own sign-in email (confirmed by signing in). */
  isOwner: boolean;
}

export interface PreferencesView {
  ownerEmail: string;
  mailClient: MailClient;
  gmailAccountEmail: string | null;
  notifyEmails: NotifyAddressView[];
  quietStartHour: number;
  quietEndHour: number;
  skipWeekends: boolean;
  followupsEnabled: boolean;
  bccAddress: string | null;
  savedAt: Date | null;
  timezone: string | null;
  timezoneSource: TimezoneSource | null;
  /** The owner may pick the zone: detection failed, or they picked it before (D-12). */
  timezoneEditable: boolean;
  onboardingCompleted: boolean;
}

const viewRow = z.object({
  owner_email: z.string(),
  timezone: z.string().nullable(),
  timezone_source: z.enum(TIMEZONE_SOURCES).nullable(),
  onboarding_completed_at: z.date().nullable(),
  notify_emails: z.array(z.string()).nullable(),
  notify_emails_verified: z.array(z.string()).nullable(),
  mail_client: z.enum(MAIL_CLIENTS).nullable(),
  gmail_account_email: z.string().nullable(),
  quiet_start_hour: z.number().nullable(),
  quiet_end_hour: z.number().nullable(),
  skip_weekends: z.boolean().nullable(),
  followups_enabled: z.boolean().nullable(),
  bcc_address: z.string().nullable(),
  preferences_saved_at: z.date().nullable(),
});

function timezoneEditable(timezone: string | null, source: TimezoneSource | null): boolean {
  return timezone === null || source !== 'hubspot';
}

/** The preferences form's starting values (defaults before the first save). */
export async function getPreferences(scope: OwnerScope, deps: Pick<Deps, 'db'>): Promise<PreferencesView> {
  const raw = await deps.db.one(
    `select u.email as owner_email, a.timezone, a.timezone_source, a.onboarding_completed_at,
            s.notify_emails, s.notify_emails_verified, s.mail_client, s.gmail_account_email, s.quiet_start_hour,
            s.quiet_end_hour, s.skip_weekends, s.followups_enabled, s.bcc_address, s.preferences_saved_at
       from accounts a
       join users u on u.account_id = a.id and u.auth_user_id = $2
       left join settings s on s.account_id = a.id
      where a.id = $1`,
    [scope.accountId, scope.userId],
  );
  const row = viewRow.parse(raw);
  const ownerEmail = row.owner_email.toLowerCase();
  const saved = row.preferences_saved_at !== null;
  const listed = saved ? (row.notify_emails ?? []) : [ownerEmail];
  const verified = new Set([...(row.notify_emails_verified ?? []), ownerEmail]);
  return {
    ownerEmail,
    mailClient: row.mail_client ?? 'other',
    gmailAccountEmail: row.gmail_account_email,
    notifyEmails: listed.map((address) => ({ address, verified: verified.has(address), isOwner: address === ownerEmail })),
    quietStartHour: row.quiet_start_hour ?? DEFAULT_QUIET_START_HOUR,
    quietEndHour: row.quiet_end_hour ?? DEFAULT_QUIET_END_HOUR,
    skipWeekends: row.skip_weekends ?? true,
    followupsEnabled: row.followups_enabled ?? true,
    bccAddress: row.bcc_address,
    savedAt: row.preferences_saved_at,
    timezone: row.timezone,
    timezoneSource: row.timezone_source,
    timezoneEditable: timezoneEditable(row.timezone, row.timezone_source),
    onboardingCompleted: row.onboarding_completed_at !== null,
  };
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

/** What the form posts (the action turns FormData into this; every value is untrusted). */
export const PreferencesInputSchema = z.object({
  mail_client: z.string(),
  gmail_account_email: z.string().nullable(),
  /** Up to MAX_NOTIFY_EMAILS non-empty entries; blanks are ignored. */
  notify_emails: z.array(z.string()).max(10),
  /** NaN when the posted value was not a number (reported as `invalid_hour`). */
  quiet_start_hour: z.union([z.number(), z.nan()]),
  quiet_end_hour: z.union([z.number(), z.nan()]),
  skip_weekends: z.boolean(),
  followups_enabled: z.boolean(),
  bcc_address: z.string().nullable(),
  /** Read only when the zone is editable. */
  timezone: z.string().nullable(),
});

export type PreferencesInput = z.input<typeof PreferencesInputSchema>;

export type PreferenceIssueCode =
  | 'invalid'
  | 'invalid_choice'
  | 'invalid_email'
  | 'required'
  | 'too_many'
  | 'invalid_hour'
  | 'no_allowed_hours'
  | 'timezone_required'
  | 'invalid_timezone';

/** One problem, by field (`notify_emails.1`, `quiet_start_hour`, …) and code. */
export interface PreferenceIssue {
  path: string;
  code: PreferenceIssueCode;
}

export interface ValidPreferences {
  mailClient: MailClient;
  gmailAccountEmail: string | null;
  notifyEmails: string[];
  quietStartHour: number;
  quietEndHour: number;
  skipWeekends: boolean;
  followupsEnabled: boolean;
  bccAddress: string | null;
  /** Null: keep the stored zone. */
  timezone: string | null;
}

export interface ValidationContext {
  timezoneEditable: boolean;
  /** The stored zone (null when detection failed and the owner has not chosen one). */
  currentTimezone: string | null;
}

function blankToNull(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length === 0 ? null : trimmed;
}

const isMailClient = (value: string): value is MailClient => (MAIL_CLIENTS as readonly string[]).includes(value);

/** Validates and normalises the form (pure). */
export function validatePreferences(input: unknown, context: ValidationContext): { ok: true; value: ValidPreferences } | { ok: false; issues: PreferenceIssue[] } {
  const parsed = PreferencesInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: [{ path: '', code: 'invalid' }] };
  const data = parsed.data;
  const issues: PreferenceIssue[] = [];

  const mailClient = isMailClient(data.mail_client) ? data.mail_client : null;
  if (mailClient === null) issues.push({ path: 'mail_client', code: 'invalid_choice' });

  let gmailAccountEmail: string | null = null;
  const gmailRaw = blankToNull(data.gmail_account_email);
  if (mailClient === 'gmail' && gmailRaw !== null) {
    gmailAccountEmail = normaliseEmail(gmailRaw);
    if (gmailAccountEmail === null) issues.push({ path: 'gmail_account_email', code: 'invalid_email' });
  }

  const notifyEmails: string[] = [];
  let listed = 0;
  data.notify_emails.forEach((raw, index) => {
    if (blankToNull(raw) === null) return;
    listed += 1;
    const address = normaliseEmail(raw);
    if (address === null) issues.push({ path: `notify_emails.${index}`, code: 'invalid_email' });
    else if (!notifyEmails.includes(address)) notifyEmails.push(address);
  });
  if (listed === 0) issues.push({ path: 'notify_emails', code: 'required' });
  else if (notifyEmails.length > MAX_NOTIFY_EMAILS) issues.push({ path: 'notify_emails', code: 'too_many' });

  const startOk = isValidHour(data.quiet_start_hour);
  const endOk = isValidHour(data.quiet_end_hour);
  if (!startOk) issues.push({ path: 'quiet_start_hour', code: 'invalid_hour' });
  if (!endOk) issues.push({ path: 'quiet_end_hour', code: 'invalid_hour' });
  if (startOk && endOk && allowedHoursPerWeek(data.quiet_start_hour, data.quiet_end_hour, data.skip_weekends) === 0) {
    issues.push({ path: 'quiet_start_hour', code: 'no_allowed_hours' });
  }

  let bccAddress: string | null = null;
  const bccRaw = blankToNull(data.bcc_address);
  if (bccRaw !== null) {
    bccAddress = normaliseEmail(bccRaw);
    if (bccAddress === null) issues.push({ path: 'bcc_address', code: 'invalid_email' });
  }

  let timezone: string | null = null;
  if (context.timezoneEditable) {
    const zone = blankToNull(data.timezone);
    if (zone === null) {
      if (context.currentTimezone === null) issues.push({ path: 'timezone', code: 'timezone_required' });
    } else if (zone === context.currentTimezone) {
      // Unchanged (possibly HubSpot's fixed-offset fallback, which is not an IANA name): keep it.
    } else if (!isValidTimezone(zone)) {
      issues.push({ path: 'timezone', code: 'invalid_timezone' });
    } else {
      timezone = zone;
    }
  }

  if (issues.length > 0 || mailClient === null) return { ok: false, issues };
  return {
    ok: true,
    value: {
      mailClient,
      gmailAccountEmail,
      notifyEmails,
      quietStartHour: data.quiet_start_hour,
      quietEndHour: data.quiet_end_hour,
      skipWeekends: data.skip_weekends,
      followupsEnabled: data.followups_enabled,
      bccAddress,
      timezone,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------------------------

export interface SavedPreferences {
  ok: true;
  /** Confirmation emails reserved by this save (one per new or still-unconfirmed address, once a day). */
  verificationsSent: number;
  /** Some unconfirmed addresses got no email because the daily limit was reached. */
  verificationLimited: boolean;
  /** The BCC address does not look like a HubSpot BCC or forwarding address (saved anyway). */
  bccWarning: boolean;
  /** A settings-change alert was reserved (only after onboarding is complete). */
  alertReserved: boolean;
}

export type SavePreferencesResult = SavedPreferences | { ok: false; issues: PreferenceIssue[] };

const beforeRow = z.object({
  owner_email: z.string(),
  onboarding_completed_at: z.date().nullable(),
  timezone: z.string().nullable(),
  timezone_source: z.enum(TIMEZONE_SOURCES).nullable(),
  notify_emails: z.array(z.string()).nullable(),
  notify_emails_verified: z.array(z.string()).nullable(),
  bcc_address: z.string().nullable(),
  preferences_saved_at: z.date().nullable(),
});

async function loadBefore(db: Db, scope: OwnerScope, lock: boolean): Promise<z.infer<typeof beforeRow>> {
  // Inside the save: the settings row is locked first, so a confirmation committed meanwhile is
  // read (and kept), and one arriving later waits for this save and then re-checks the new list.
  if (lock) await db.query(`select account_id from settings where account_id = $1 for update`, [scope.accountId]);
  const raw = await db.one(
    `select u.email as owner_email, a.onboarding_completed_at, a.timezone, a.timezone_source,
            s.notify_emails, s.notify_emails_verified, s.bcc_address, s.preferences_saved_at
       from accounts a
       join users u on u.account_id = a.id and u.auth_user_id = $2
       left join settings s on s.account_id = a.id
      where a.id = $1
      ${lock ? 'for no key update of a' : ''}`,
    [scope.accountId, scope.userId],
  );
  return beforeRow.parse(raw);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((value) => right.has(value));
}

interface Reserved {
  verifications: { key: string; address: string }[];
  verificationLimited: boolean;
  alertKey: string | null;
}

/** Sends what the transaction reserved (taking each reservation over with its full plan). Never throws. */
async function sendAfterCommit(deps: Deps, accountId: string, reserved: Reserved, savedAt: Date): Promise<void> {
  const sends: { kind: 'verify_notify' | 'owner_alert'; plan: () => Promise<ReserveAndSendInput | null> }[] = [
    ...reserved.verifications.map(({ key, address }) => ({
      kind: 'verify_notify' as const,
      plan: async (): Promise<ReserveAndSendInput> => ({ kind: 'verify_notify' as const, dedupeKey: key, accountId, ...verifyNotifyPlan(deps, accountId, address) }),
    })),
  ];
  if (reserved.alertKey !== null) {
    const key = reserved.alertKey;
    sends.push({
      kind: 'owner_alert',
      plan: async () => {
        const plan = await settingsChangeAlertPlan(deps, accountId, savedAt);
        return plan === null ? null : { kind: 'owner_alert' as const, dedupeKey: key, accountId, ...plan };
      },
    });
  }
  for (const send of sends) {
    try {
      const input = await send.plan();
      if (input !== null) await reserveAndSend(deps, input);
    } catch (error) {
      // Still `sending`: the sweeper resumes it (PLAN §8.3 step 7).
      log.warn('settings email not sent yet', { event: 'settings.email_deferred', accountId, notificationKind: send.kind, code: errorCode(error) }, error);
    }
  }
}

/**
 * Saves the preferences. One transaction updates the settings (and the zone, when the owner chose
 * one), confirms the addresses that need no email, and reserves the confirmation emails and the
 * change alert; after commit they are sent.
 */
export async function savePreferences(scope: OwnerScope, deps: Deps, input: unknown): Promise<SavePreferencesResult> {
  const current = await loadBefore(deps.db, scope, false);
  const validated = validatePreferences(input, {
    timezoneEditable: timezoneEditable(current.timezone, current.timezone_source),
    currentTimezone: current.timezone,
  });
  if (!validated.ok) return validated;
  const value = validated.value;
  const now = deps.clock.now();
  const accountId = scope.accountId;

  const reserved = await deps.db.tx(async (tx): Promise<Reserved> => {
    const before = await loadBefore(tx, scope, true);
    const ownerEmail = before.owner_email.toLowerCase();
    const previousList = before.notify_emails ?? [];
    const previouslyVerified = new Set(before.notify_emails_verified ?? []);
    const verified = value.notifyEmails.filter((address) => address === ownerEmail || previouslyVerified.has(address));

    await tx.query(
      `insert into settings (account_id, notify_emails, notify_emails_verified, mail_client, gmail_account_email, quiet_start_hour,
                             quiet_end_hour, skip_weekends, followups_enabled, bcc_address, preferences_saved_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (account_id) do update set
         notify_emails = excluded.notify_emails, notify_emails_verified = excluded.notify_emails_verified,
         mail_client = excluded.mail_client, gmail_account_email = excluded.gmail_account_email,
         quiet_start_hour = excluded.quiet_start_hour, quiet_end_hour = excluded.quiet_end_hour,
         skip_weekends = excluded.skip_weekends, followups_enabled = excluded.followups_enabled,
         bcc_address = excluded.bcc_address, preferences_saved_at = excluded.preferences_saved_at`,
      [
        accountId,
        value.notifyEmails,
        verified,
        value.mailClient,
        value.gmailAccountEmail,
        value.quietStartHour,
        value.quietEndHour,
        value.skipWeekends,
        value.followupsEnabled,
        value.bccAddress,
        now,
      ],
    );
    if (value.timezone !== null && timezoneEditable(before.timezone, before.timezone_source)) {
      await tx.query(`update accounts set timezone = $2, timezone_source = 'owner' where id = $1`, [accountId, value.timezone]);
    }

    // Confirmation emails: every unconfirmed address, at most once a day each, within the daily cap.
    const verifications: Reserved['verifications'] = [];
    let verificationLimited = false;
    for (const address of value.notifyEmails.filter((entry) => !verified.includes(entry))) {
      const key = verifyNotifyKey(deps.env, accountId, address, now);
      if ((await getNotification(tx, key)) !== null) continue;
      const hit = await hitFixedWindow(tx, { keyHash: rateLimitKeyHash(deps.env, `verify_notify:${accountId}`), windowMs: DAY_MS, now });
      if (hit.count > VERIFY_EMAILS_PER_DAY) {
        verificationLimited = true;
        continue;
      }
      const row = await reserveInTx(tx, {
        kind: 'verify_notify',
        dedupeKey: key,
        accountId,
        predicates: NotificationPredicates.verifyNotify(accountId, address),
        now,
      });
      if (row !== null) verifications.push({ key, address });
    }

    // D-46: alerts only once onboarding is complete, and only for address changes.
    let alertKey: string | null = null;
    const changed = !sameSet(previousList, value.notifyEmails) || (before.bcc_address ?? null) !== value.bccAddress;
    if (before.onboarding_completed_at !== null && before.preferences_saved_at !== null && changed) {
      const key = settingsChangeAlertKey(accountId, now);
      const row = await reserveInTx(tx, { kind: 'owner_alert', dedupeKey: key, accountId, predicates: NotificationPredicates.ownerAlert(), now });
      if (row !== null) alertKey = key;
    }
    return { verifications, verificationLimited, alertKey };
  });

  log.info('preferences saved', {
    event: 'settings.preferences_saved',
    accountId,
    count: value.notifyEmails.length,
    remaining: reserved.verifications.length,
    outcome: reserved.alertKey === null ? 'no_alert' : 'alert',
  });
  await sendAfterCommit(deps, accountId, reserved, now);
  return {
    ok: true,
    verificationsSent: reserved.verifications.length,
    verificationLimited: reserved.verificationLimited,
    bccWarning: value.bccAddress !== null && !looksLikeHubSpotBcc(value.bccAddress),
    alertReserved: reserved.alertKey !== null,
  };
}
