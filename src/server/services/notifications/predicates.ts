import 'server-only';
import type { NotificationKind } from '@/server/domain/types';

// The per-kind notification table (PLAN §8.4): each kind's dedupe key, and the SQL predicate checked
// inside the reservation INSERT…SELECT and again in every takeover (a retry, the paired kind, the
// sweeper). A predicate is a boolean SQL expression built with `bind`, which adds a parameter and
// returns its placeholder, so a predicate composes into any statement.
//
// | Kind                               | Key                                         | Predicate
// |------------------------------------|---------------------------------------------|----------------------------------------------
// | new_lead, needs_touch (initial)    | notify:{leadId}:initial:r{process_rev}      | lead not dismissed, stop_reason null, not is_test,
// |                                    |                                             | account active, connection active
// | follow_up, needs_touch (fu n)      | notify:{leadId}:fu{n}:s{followup_stream}    | the above + replied_at null, not superseded,
// |                                    |                                             | followups_enabled
// | reply_detected                     | reply:{leadId}:s{followup_stream}           | replied_at not null, not dismissed,
// |                                    |                                             | account and connection active
// | inbox_test                         | inbox-test:{checkId}                        | lead is_test, account onboarding|active,
// |                                    |                                             | connection active
// | weekly_report                      | report:{acct}:{week_start}                  | account and connection active
// | reconnect                          | reconnect:{conn}:{status_changed_at}        | connection still revoked at that status_changed_at
// | billing_inactive                   | billing-inactive:{acct}:{entitlement_lost_at} | account still inactive
// | magic_link                         | magic:{intentId}                            | none
// | verify_notify                      | verify-notify:{acct}:{addrHmac}             | address still listed and unverified
// | lead_cap                           | cap:{acct}:{localDate}                      | account active
// | owner_alert                        | alert:{acct}:{kind}:{id}                    | none

/** Adds a parameter and returns its placeholder (`$n`). */
export type Bind = (value: unknown) => string;

/** A boolean SQL expression over bound parameters. */
export type NotificationPredicate = (bind: Bind) => string;

export interface LeadScope {
  accountId: string;
  leadId: string;
}

// ---------------------------------------------------------------------------------------------
// Keys (stored without the {ENV_NAMESPACE}: prefix; the Resend idempotency key adds it)
// ---------------------------------------------------------------------------------------------

export const NotificationKeys = {
  /** new_lead and the needs-touch email that replaces it. */
  initial: (leadId: string, processRev: number): string => `notify:${leadId}:initial:r${processRev}`,
  /** follow_up n and the needs-touch email that replaces it. */
  followUp: (leadId: string, n: 1 | 2, followupStream: number): string => `notify:${leadId}:fu${n}:s${followupStream}`,
  replyDetected: (leadId: string, followupStream: number): string => `reply:${leadId}:s${followupStream}`,
  inboxTest: (checkId: string): string => `inbox-test:${checkId}`,
  /** `weekStart` is the report week's Monday, 'YYYY-MM-DD'. */
  weeklyReport: (accountId: string, weekStart: string): string => `report:${accountId}:${weekStart}`,
  reconnect: (connectionId: string, statusChangedAt: Date): string => `reconnect:${connectionId}:${statusChangedAt.toISOString()}`,
  billingInactive: (accountId: string, entitlementLostAt: Date): string => `billing-inactive:${accountId}:${entitlementLostAt.toISOString()}`,
  magicLink: (intentId: string): string => `magic:${intentId}`,
  /** `addressHmac`: HMAC of the lower-cased address (never the address itself). */
  verifyNotify: (accountId: string, addressHmac: string): string => `verify-notify:${accountId}:${addressHmac}`,
  /** `localDate`: the account's local date, 'YYYY-MM-DD'. */
  leadCap: (accountId: string, localDate: string): string => `cap:${accountId}:${localDate}`,
  ownerAlert: (accountId: string, alertKind: string, id: string): string => `alert:${accountId}:${alertKind}:${id}`,
} as const;

// ---------------------------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------------------------

/** The lead, its account and connection, with extra conditions over `l`, `a` and `c`. */
function leadWhere(bind: Bind, scope: LeadScope, conditions: readonly string[]): string {
  return `exists (
    select 1 from leads l
      join accounts a on a.id = l.account_id
      join hubspot_connections c on c.account_id = a.id
     where l.id = ${bind(scope.leadId)}::uuid and l.account_id = ${bind(scope.accountId)}::uuid
       and ${conditions.join(' and ')})`;
}

const INITIAL_CONDITIONS = [
  'l.dismissed_at is null',
  'l.stop_reason is null',
  'not l.is_test',
  `a.processing_state = 'active'`,
  `c.status = 'active'`,
] as const;

/** D-44: a newer non-test lead for the same contact has already been notified. */
const NOT_SUPERSEDED = `not exists (
      select 1 from leads n
       where n.account_id = l.account_id and n.hubspot_contact_id = l.hubspot_contact_id and n.id <> l.id
         and not n.is_test and n.submitted_at > l.submitted_at and n.first_notified_at is not null)`;

const FOLLOWUPS_ENABLED = 'exists (select 1 from settings s where s.account_id = a.id and s.followups_enabled)';

function accountWhere(bind: Bind, accountId: string, conditions: readonly string[]): string {
  return `exists (select 1 from accounts a where a.id = ${bind(accountId)}::uuid and ${conditions.join(' and ')})`;
}

export const NotificationPredicates = {
  /** new_lead, and needs_touch for the initial email. */
  initial:
    (scope: LeadScope): NotificationPredicate =>
    (bind) =>
      leadWhere(bind, scope, INITIAL_CONDITIONS),

  /** follow_up, and needs_touch for a follow-up. */
  followUp:
    (scope: LeadScope): NotificationPredicate =>
    (bind) =>
      leadWhere(bind, scope, [...INITIAL_CONDITIONS, 'l.replied_at is null', NOT_SUPERSEDED, FOLLOWUPS_ENABLED]),

  /** Reserved inside the markReplied transaction, only while follow-ups were still scheduled (D-08). */
  replyDetected:
    (scope: LeadScope): NotificationPredicate =>
    (bind) =>
      leadWhere(bind, scope, ['l.replied_at is not null', 'l.dismissed_at is null', `a.processing_state = 'active'`, `c.status = 'active'`]),

  /** The onboarding inbox test: `scope.leadId` is the test lead. */
  inboxTest:
    (scope: LeadScope): NotificationPredicate =>
    (bind) =>
      leadWhere(bind, scope, ['l.is_test', `a.processing_state in ('onboarding', 'active')`, `c.status = 'active'`]),

  weeklyReport:
    (accountId: string): NotificationPredicate =>
    (bind) =>
      accountWhere(bind, accountId, [
        `a.processing_state = 'active'`,
        `exists (select 1 from hubspot_connections c where c.account_id = a.id and c.status = 'active')`,
      ]),

  /** Reserved inside the revoke transaction; on resume the connection must still be revoked at that instant. */
  reconnect:
    (connectionId: string, statusChangedAt: Date): NotificationPredicate =>
    (bind) =>
      `exists (select 1 from hubspot_connections c
                where c.id = ${bind(connectionId)}::uuid and c.status = 'revoked'
                  and c.status_changed_at = ${bind(statusChangedAt)}::timestamptz)`,

  /** Reserved inside the → inactive transition; on resume the account must still be inactive. */
  billingInactive:
    (accountId: string): NotificationPredicate =>
    (bind) =>
      accountWhere(bind, accountId, [`a.processing_state = 'inactive'`]),

  magicLink: (): NotificationPredicate => () => 'true',

  /** `address` lower-cased, as `settings.notify_emails` stores it. */
  verifyNotify:
    (accountId: string, address: string): NotificationPredicate =>
    (bind) => {
      const addr = bind(address);
      return `exists (select 1 from settings s
                       where s.account_id = ${bind(accountId)}::uuid
                         and ${addr}::text = any(s.notify_emails) and not (${addr}::text = any(s.notify_emails_verified)))`;
    },

  leadCap:
    (accountId: string): NotificationPredicate =>
    (bind) =>
      accountWhere(bind, accountId, [`a.processing_state = 'active'`]),

  ownerAlert: (): NotificationPredicate => () => 'true',
} as const;

/** Kinds that may take over each other's `sending` reservation because they share keys (PLAN §8.4 step 2). */
const PAIRS: readonly (readonly [NotificationKind, NotificationKind])[] = [
  ['new_lead', 'needs_touch'],
  ['follow_up', 'needs_touch'],
];

export function canTakeOver(existingKind: NotificationKind, newKind: NotificationKind): boolean {
  if (existingKind === newKind) return true;
  return PAIRS.some(([a, b]) => (a === existingKind && b === newKind) || (b === existingKind && a === newKind));
}

/** Builds a predicate's SQL with parameters numbered after `params`, which it extends. */
export function bindPredicate(predicate: NotificationPredicate, params: unknown[]): string {
  return predicate((value) => {
    params.push(value);
    return `$${params.length}`;
  });
}
