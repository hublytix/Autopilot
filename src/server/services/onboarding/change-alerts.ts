import 'server-only';
import { DateTime } from 'luxon';
import { createElement } from 'react';
import { z } from 'zod';
import { SettingsChangeAlert, settingsChangeAlertSubject } from '@/emails/SettingsChangeAlert';
import type { Db } from '@/server/db';
import { renderEmail } from '@/server/email/render';
import type { Deps } from '@/server/ports';
import { NotificationKeys, NotificationPredicates } from '@/server/services/notifications/predicates';
import type { NotificationResumer } from '@/server/services/notifications/renderers';
import type { NotificationSendPlan, RenderedMail } from '@/server/services/notifications/types';

// The settings-change alert (D-46, PLAN §7.5, §8.4 `owner_alert`): once onboarding is complete, a
// change to the lead-alert addresses or the BCC address emails the owner's own sign-in address.
// The first save during onboarding never does. Key `alert:{acct}:settings_change:{saved-at ISO}`:
// one alert per save. The email shows the settings as they are when it is rendered (a resumed send
// shows them as they are then). This module must not import services/accounts, which may delegate
// its owner_alert resumer here.

export const SETTINGS_CHANGE_ALERT_KIND = 'settings_change';
export const SETTINGS_PATH = '/dashboard/settings';

export function settingsChangeAlertKey(accountId: string, savedAt: Date): string {
  return NotificationKeys.ownerAlert(accountId, SETTINGS_CHANGE_ALERT_KIND, savedAt.toISOString());
}

const KEY_PATTERN = /^alert:([0-9a-f-]{36}):settings_change:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;

export function parseSettingsChangeAlertKey(key: string): { accountId: string; savedAt: Date } | null {
  const match = KEY_PATTERN.exec(key);
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  const savedAt = new Date(match[2]);
  return Number.isNaN(savedAt.getTime()) ? null : { accountId: match[1], savedAt };
}

export function isSettingsChangeAlertKey(key: string): boolean {
  return parseSettingsChangeAlertKey(key) !== null;
}

const contextRow = z.object({
  email: z.string(),
  timezone: z.string().nullable(),
  notify_emails: z.array(z.string()),
  notify_emails_verified: z.array(z.string()),
  bcc_address: z.string().nullable(),
});

async function loadAlertContext(db: Db, accountId: string): Promise<z.infer<typeof contextRow> | null> {
  const raw = await db.maybeOne(
    `select u.email, a.timezone, s.notify_emails, s.notify_emails_verified, s.bcc_address
       from accounts a
       join users u on u.account_id = a.id and u.auth_user_id = a.owner_user_id
       join settings s on s.account_id = a.id
      where a.id = $1`,
    [accountId],
  );
  return raw === null ? null : contextRow.parse(raw);
}

/** "October 6, 2026 at 9:02 AM (America/New_York)" in the account's zone (UTC when unknown). */
export function formatChangedOn(at: Date, timezone: string | null): string {
  let zoned = DateTime.fromJSDate(at, { zone: timezone ?? 'UTC' });
  if (!zoned.isValid) zoned = DateTime.fromJSDate(at, { zone: 'UTC' });
  return `${zoned.toFormat("MMMM d, yyyy 'at' h:mm a")} (${zoned.zoneName ?? 'UTC'})`;
}

/** The plan for one alert; null when the account has no bound owner (nobody to tell). */
export async function settingsChangeAlertPlan(deps: Deps, accountId: string, savedAt: Date): Promise<NotificationSendPlan | null> {
  const context = await loadAlertContext(deps.db, accountId);
  if (context === null) return null;
  const productName = deps.env.PRODUCT_NAME;
  return {
    predicates: NotificationPredicates.ownerAlert(),
    render: async (): Promise<RenderedMail> => {
      // Read again at send time: a resumed send shows the settings as they are then.
      const current = (await loadAlertContext(deps.db, accountId)) ?? context;
      const verified = new Set(current.notify_emails_verified);
      const { html, text } = await renderEmail(
        createElement(SettingsChangeAlert, {
          productName,
          changedOn: formatChangedOn(savedAt, current.timezone),
          notifyAddresses: current.notify_emails.map((address) => ({ address, confirmed: verified.has(address) })),
          bccAddress: current.bcc_address,
          settingsUrl: `${deps.env.APP_URL}${SETTINGS_PATH}`,
        }),
      );
      return { to: [current.email], subject: settingsChangeAlertSubject(productName), html, text };
    },
  };
}

/** Rebuilds a `settings_change` alert from its key; null for any other owner alert. */
export const resumeSettingsChangeAlert: NotificationResumer = async (deps, row) => {
  const parsed = parseSettingsChangeAlertKey(row.dedupeKey);
  return parsed === null ? null : settingsChangeAlertPlan(deps, parsed.accountId, parsed.savedAt);
};
