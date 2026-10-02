import 'server-only';
import { DateTime } from 'luxon';
import { createElement } from 'react';
import { BillingInactive, billingInactiveSubject } from '@/emails/BillingInactive';
import { OwnerAlert } from '@/emails/OwnerAlert';
import { ReconnectHubSpot, reconnectHubSpotSubject } from '@/emails/ReconnectHubSpot';
import type { NotificationKind } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { renderEmail } from '@/server/email/render';
import type { Deps } from '@/server/ports';
import { NotificationKeys, NotificationPredicates } from '@/server/services/notifications/predicates';
import { defaultNotificationRegistry, type NotificationRegistry, type NotificationResumer } from '@/server/services/notifications/renderers';
import type { NotificationSendPlan, RenderedMail } from '@/server/services/notifications/types';
import { isSettingsChangeAlertKey, resumeSettingsChangeAlert } from '@/server/services/onboarding/change-alerts';

// The account-level owner emails (PLAN §8.4): `reconnect`, `billing_inactive` and `owner_alert`.
// Each kind has a plan builder (used when the email is first sent) and a resumer that rebuilds the
// same plan from the reservation row alone, so the sweeper can resume a lost send. They go to the
// bound owner's login email; an account without a bound owner gets none (the plan is null).
// Reply-To: `EMAIL_REPLY_TO` for billing only (D-27); the others carry none.

/** `/api/hubspot/install`: starts the HubSpot install again (branch (c) with the owner's session, else (d)). */
export const HUBSPOT_INSTALL_PATH = '/api/hubspot/install';
const BILLING_PATH = '/dashboard/billing';
const LOGIN_PATH = '/login';

interface Owner {
  readonly email: string;
  readonly timezone: string | null;
  readonly purgeAfter: Date | null;
}

async function loadOwner(db: Db, accountId: string): Promise<Owner | null> {
  const row = await db.maybeOne<{ email: string; timezone: string | null; purge_after: Date | null }>(
    `select u.email, a.timezone, a.purge_after
       from accounts a join users u on u.account_id = a.id and u.auth_user_id = a.owner_user_id
      where a.id = $1`,
    [accountId],
  );
  return row === null ? null : { email: row.email, timezone: row.timezone, purgeAfter: row.purge_after };
}

/** Whether the account has a bound owner to email (checked before reserving). */
export async function hasBoundOwner(db: Db, accountId: string): Promise<boolean> {
  return (await loadOwner(db, accountId)) !== null;
}

/** "November 5, 2026" in the account's zone (UTC when unknown or invalid). */
export function formatAccountDate(date: Date, timezone: string | null): string {
  const zoned = DateTime.fromJSDate(date, { zone: timezone ?? 'UTC' });
  return (zoned.isValid ? zoned : DateTime.fromJSDate(date, { zone: 'UTC' })).toFormat('MMMM d, yyyy');
}

/** The account's local date 'YYYY-MM-DD' (UTC when unknown or invalid), e.g. for daily alert keys. */
export function accountLocalDate(now: Date, timezone: string | null): string {
  const zoned = DateTime.fromJSDate(now, { zone: timezone ?? 'UTC' });
  return (zoned.isValid ? zoned : DateTime.fromJSDate(now, { zone: 'UTC' })).toFormat('yyyy-MM-dd');
}

// ---------------------------------------------------------------------------------------------
// reconnect: `reconnect:{connectionId}:{status_changed_at ISO}`
// ---------------------------------------------------------------------------------------------

export function parseReconnectKey(dedupeKey: string): { connectionId: string; statusChangedAt: Date } | null {
  const match = /^reconnect:([0-9a-f-]{36}):(.+)$/.exec(dedupeKey);
  if (match === null) return null;
  const statusChangedAt = new Date(match[2] ?? '');
  if (Number.isNaN(statusChangedAt.getTime()) || statusChangedAt.toISOString() !== match[2]) return null;
  return { connectionId: match[1] ?? '', statusChangedAt };
}

export async function reconnectPlan(deps: Deps, connectionId: string, statusChangedAt: Date): Promise<NotificationSendPlan | null> {
  const connection = await deps.db.maybeOne<{ account_id: string }>(`select account_id from hubspot_connections where id = $1`, [connectionId]);
  if (connection === null) return null;
  const owner = await loadOwner(deps.db, connection.account_id);
  if (owner === null) return null;
  const productName = deps.env.PRODUCT_NAME;
  return {
    predicates: NotificationPredicates.reconnect(connectionId, statusChangedAt),
    render: async (): Promise<RenderedMail> => {
      const { html, text } = await renderEmail(
        createElement(ReconnectHubSpot, {
          productName,
          reconnectUrl: `${deps.env.APP_URL}${HUBSPOT_INSTALL_PATH}`,
          purgeDate: owner.purgeAfter === null ? null : formatAccountDate(owner.purgeAfter, owner.timezone),
        }),
      );
      return { to: [owner.email], subject: reconnectHubSpotSubject(productName), html, text };
    },
    onSent: async (tx) => {
      await tx.query(`update hubspot_connections set reconnect_email_sent_at = $2 where id = $1`, [connectionId, deps.clock.now()]);
    },
  };
}

const resumeReconnect: NotificationResumer = async (deps, row) => {
  const parsed = parseReconnectKey(row.dedupeKey);
  return parsed === null ? null : reconnectPlan(deps, parsed.connectionId, parsed.statusChangedAt);
};

// ---------------------------------------------------------------------------------------------
// billing_inactive: `billing-inactive:{accountId}:{entitlement_lost_at ISO}`
// ---------------------------------------------------------------------------------------------

export async function billingInactivePlan(deps: Deps, accountId: string): Promise<NotificationSendPlan | null> {
  const owner = await loadOwner(deps.db, accountId);
  if (owner === null) return null;
  const productName = deps.env.PRODUCT_NAME;
  return {
    predicates: NotificationPredicates.billingInactive(accountId),
    render: async (): Promise<RenderedMail> => {
      const { html, text } = await renderEmail(createElement(BillingInactive, { productName, billingUrl: `${deps.env.APP_URL}${BILLING_PATH}` }));
      return { to: [owner.email], replyTo: deps.env.EMAIL_REPLY_TO, subject: billingInactiveSubject(productName), html, text };
    },
  };
}

const resumeBillingInactive: NotificationResumer = async (deps, row) => {
  const match = /^billing-inactive:([0-9a-f-]{36}):/.exec(row.dedupeKey);
  const accountId = match?.[1];
  return accountId === undefined ? null : billingInactivePlan(deps, accountId);
};

// ---------------------------------------------------------------------------------------------
// owner_alert: `alert:{accountId}:{alertKind}:{id}`
// ---------------------------------------------------------------------------------------------

interface OwnerAlertCopy {
  subject(productName: string): string;
  heading: string;
  paragraphs(productName: string): readonly string[];
  action?: { label: string; path: string } | undefined;
}

/** Fixed copy per alert kind. Later milestones add theirs here (settings changes, D-46). */
const OWNER_ALERTS = {
  /** Branch (d) of the OAuth callback, when the installer is not the owner (D-35). */
  reconnect_attempt: {
    subject: (productName) => `Someone tried to connect ${productName} to your HubSpot account`,
    heading: 'Someone tried to connect HubSpot',
    paragraphs: (productName) => [
      `Someone in your HubSpot account tried to connect ${productName}. Nothing changed. If this was you, sign in and tap Reconnect.`,
    ],
    action: { label: 'Sign in', path: LOGIN_PATH },
  },
} as const satisfies Record<string, OwnerAlertCopy>;

export type OwnerAlertKind = keyof typeof OWNER_ALERTS;

function isOwnerAlertKind(value: string): value is OwnerAlertKind {
  return Object.hasOwn(OWNER_ALERTS, value);
}

export async function ownerAlertPlan(deps: Deps, accountId: string, alertKind: OwnerAlertKind): Promise<NotificationSendPlan | null> {
  const owner = await loadOwner(deps.db, accountId);
  if (owner === null) return null;
  const copy: OwnerAlertCopy = OWNER_ALERTS[alertKind];
  const productName = deps.env.PRODUCT_NAME;
  return {
    predicates: NotificationPredicates.ownerAlert(),
    render: async (): Promise<RenderedMail> => {
      const action = copy.action === undefined ? undefined : { label: copy.action.label, url: `${deps.env.APP_URL}${copy.action.path}` };
      const { html, text } = await renderEmail(
        createElement(OwnerAlert, { productName, heading: copy.heading, paragraphs: copy.paragraphs(productName), action }),
      );
      return { to: [owner.email], subject: copy.subject(productName), html, text };
    },
  };
}

/** `alert:{acct}:{kind}:{id}` for an owner alert. */
export function ownerAlertKey(accountId: string, alertKind: OwnerAlertKind, id: string): string {
  return NotificationKeys.ownerAlert(accountId, alertKind, id);
}

const resumeOwnerAlert: NotificationResumer = async (deps, row) => {
  // Settings-change alerts (M3) share the `owner_alert` kind; services/onboarding rebuilds them. Handled
  // here too, so the sweeper can resume one whichever registration ran first in this process.
  if (isSettingsChangeAlertKey(row.dedupeKey)) return resumeSettingsChangeAlert(deps, row);
  const match = /^alert:([0-9a-f-]{36}):([a-z_]+):/.exec(row.dedupeKey);
  const accountId = match?.[1];
  const alertKind = match?.[2];
  if (accountId === undefined || alertKind === undefined || !isOwnerAlertKind(alertKind)) return null;
  return ownerAlertPlan(deps, accountId, alertKind);
};

// ---------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------

const RESUMERS: readonly (readonly [NotificationKind, NotificationResumer])[] = [
  ['reconnect', resumeReconnect],
  ['billing_inactive', resumeBillingInactive],
  ['owner_alert', resumeOwnerAlert],
];

/**
 * Registers the resumers for `reconnect`, `billing_inactive` and `owner_alert` (a `Registration` for
 * src/server/jobs/handlers.ts). Kinds already registered are left alone, so it is safe to call more
 * than once.
 */
export function registerAccountNotifications(registries: { readonly notifications: NotificationRegistry }): void {
  for (const [kind, resumer] of RESUMERS) {
    if (registries.notifications.resumer(kind) === undefined) registries.notifications.register(kind, resumer);
  }
}

/** Before sendReserved in this process: the resumers are in the default registry. */
export function ensureAccountNotificationsRegistered(): void {
  registerAccountNotifications({ notifications: defaultNotificationRegistry });
}
