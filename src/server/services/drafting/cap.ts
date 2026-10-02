import 'server-only';
import { DateTime } from 'luxon';
import { createElement } from 'react';
import { LeadCapReached, leadCapReachedSubject } from '@/emails/LeadCapReached';
import { isRetryable, errorCode } from '@/server/domain/errors';
import type { Db } from '@/server/db';
import { renderEmail } from '@/server/email/render';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { NotificationKeys, NotificationPredicates } from '@/server/services/notifications/predicates';
import { defaultNotificationRegistry, type NotificationRegistry, type NotificationResumer } from '@/server/services/notifications/renderers';
import { reserveInTx } from '@/server/services/notifications/reserve';
import { reserveAndSend } from '@/server/services/notifications/send';
import type { NotificationSendPlan, RenderedMail, SendResult } from '@/server/services/notifications/types';

// The per-account daily cap on drafted leads (D-36, PLAN §9.3 step 4). Counted after
// classification, so spam is still filtered: a lead counts as drafted on the portal's local date
// when it was notified that day (`first_notified_at`), or holds an `initial` draft row and was
// classified that day. The check and the slot are one transaction under the account row lock: the
// lead either claims its slot by inserting its (empty) `initial` draft row, which every later count
// sees, or, at or over MAX_DRAFTED_LEADS_PER_DAY, becomes `deferred` (no draft call) and the day's
// one `lead_cap` email (`cap:{acct}:{localDate}`) is reserved in the same transaction, then sent
// after commit through reserveAndSend. A send that fails transiently is left `sending` for the
// sweeper (the `lead_cap` resumer below): the lead stays deferred either way.

const DASHBOARD_PATH = '/dashboard';

export interface LocalDay {
  /** 'YYYY-MM-DD' in the account's zone (UTC when unknown or invalid). */
  readonly date: string;
  readonly start: Date;
  readonly end: Date;
}

/** The account-local day containing `now`. */
export function localDay(now: Date, timezone: string | null): LocalDay {
  const zoned = DateTime.fromJSDate(now, { zone: timezone ?? 'UTC' });
  const day = (zoned.isValid ? zoned : DateTime.fromJSDate(now, { zone: 'UTC' })).startOf('day');
  return { date: day.toFormat('yyyy-MM-dd'), start: day.toJSDate(), end: day.plus({ days: 1 }).toJSDate() };
}

/** Leads (other than `leadId`) drafted on the local day: notified that day, or holding a draft row and classified that day. */
export async function countDraftedLeads(db: Db, input: { accountId: string; exceptLeadId: string; day: LocalDay }): Promise<number> {
  const row = await db.one<{ count: number }>(
    `select count(*)::int as count from leads l
      where l.account_id = $1 and not l.is_test and l.id <> $2
        and (l.first_notified_at is not null or exists (select 1 from drafts d where d.lead_id = l.id and d.kind = 'initial'))
        and coalesce(l.first_notified_at, l.classified_at, l.received_at) >= $3
        and coalesce(l.first_notified_at, l.classified_at, l.received_at) < $4`,
    [input.accountId, input.exceptLeadId, input.day.start, input.day.end],
  );
  return row.count;
}

// ---------------------------------------------------------------------------------------------
// The lead_cap email
// ---------------------------------------------------------------------------------------------

/** The account's verified notify addresses; the owner's sign-in address when none is verified (it is always verified, D-46). */
async function capRecipients(db: Db, accountId: string): Promise<string[]> {
  const row = await db.maybeOne<{ verified: string[] | null; owner_email: string | null }>(
    `select s.notify_emails_verified as verified, u.email as owner_email
       from accounts a
       left join settings s on s.account_id = a.id
       left join users u on u.account_id = a.id and u.auth_user_id = a.owner_user_id
      where a.id = $1`,
    [accountId],
  );
  if (row === null) return [];
  const verified = (row.verified ?? []).filter((address) => address.trim() !== '');
  if (verified.length > 0) return verified;
  return row.owner_email === null ? [] : [row.owner_email];
}

/** The `lead_cap` plan for the account, or null when it has nobody to email. */
export async function leadCapPlan(deps: Pick<Deps, 'db' | 'env'>, accountId: string): Promise<NotificationSendPlan | null> {
  const to = await capRecipients(deps.db, accountId);
  if (to.length === 0) return null;
  const productName = deps.env.PRODUCT_NAME;
  const limit = deps.env.MAX_DRAFTED_LEADS_PER_DAY;
  return {
    predicates: NotificationPredicates.leadCap(accountId),
    render: async (): Promise<RenderedMail> => {
      const { html, text } = await renderEmail(createElement(LeadCapReached, { productName, limit, dashboardUrl: `${deps.env.APP_URL}${DASHBOARD_PATH}` }));
      return { to, subject: leadCapReachedSubject(productName, limit), html, text, tags: [{ name: 'kind', value: 'lead_cap' }] };
    },
  };
}

const CAP_KEY = /^cap:([0-9a-f-]{36}):(\d{4}-\d{2}-\d{2})$/;

/** Rebuilds a `lead_cap` reservation's plan from its key (the sweeper's resume). */
export const resumeLeadCap: NotificationResumer = async (deps, row) => {
  const accountId = CAP_KEY.exec(row.dedupeKey)?.[1];
  return accountId === undefined ? null : leadCapPlan(deps, accountId);
};

/** Registers the `lead_cap` resumer (a `Registration` for src/server/jobs/handlers.ts); safe to call more than once. */
export function registerDraftingNotifications(registries: { readonly notifications: NotificationRegistry }): void {
  if (registries.notifications.resumer('lead_cap') === undefined) registries.notifications.register('lead_cap', resumeLeadCap);
}

/** Before sendReserved in this process: the resumer is in the default registry. */
export function ensureDraftingNotificationsRegistered(): void {
  registerDraftingNotifications({ notifications: defaultNotificationRegistry });
}

// ---------------------------------------------------------------------------------------------
// The cap check
// ---------------------------------------------------------------------------------------------

export interface DailyCapInput {
  readonly accountId: string;
  readonly leadId: string;
  /** The job's revision: the deferral is a compare-and-set on it and on `processing`. */
  readonly processRev: number;
  /** Runs first inside the transaction (lead_process passes `ctx.assertOwned`). */
  readonly guard?: ((tx: Db) => Promise<void>) | undefined;
}

export type DailyCapResult =
  /** Under the cap: the lead holds its slot (its `initial` draft row); go on and draft it. */
  | { readonly type: 'allowed' }
  /** At or over the cap: the lead is `deferred`; `email` is the lead_cap send's outcome (null when nobody could be emailed). */
  | { readonly type: 'deferred'; readonly email: SendResult | { readonly status: 'retry_later' } | null }
  /** The lead or account moved on meanwhile (an override, a dismissal, …): nothing was written. */
  | { readonly type: 'lead_changed' };

/**
 * PLAN §9.3 step 4: claims the lead's daily slot, or defers the lead and sends the day's lead_cap
 * email. Idempotent: a lead that already holds a slot is allowed again.
 */
export async function applyDailyCap(deps: Deps, input: DailyCapInput): Promise<DailyCapResult> {
  const now = deps.clock.now();
  const limit = deps.env.MAX_DRAFTED_LEADS_PER_DAY;
  const decided = await deps.db.tx(async (tx) => {
    if (input.guard !== undefined) await input.guard(tx);
    const account = await tx.maybeOne<{ timezone: string | null }>(`select timezone from accounts where id = $1 for no key update`, [input.accountId]);
    if (account === null) return { type: 'lead_changed' as const };
    const held = await tx.maybeOne(`select id from drafts where lead_id = $1 and kind = 'initial'`, [input.leadId]);
    if (held !== null) return { type: 'allowed' as const };

    const day = localDay(now, account.timezone);
    const drafted = await countDraftedLeads(tx, { accountId: input.accountId, exceptLeadId: input.leadId, day });
    if (drafted < limit) {
      await tx.query(
        `insert into drafts (lead_id, account_id, kind, purge_at)
         select l.id, l.account_id, 'initial', m.purge_at
           from leads l join lead_messages m on m.lead_id = l.id
          where l.id = $1 and l.account_id = $2
         on conflict (lead_id, kind) do nothing`,
        [input.leadId, input.accountId],
      );
      return { type: 'allowed' as const };
    }

    const deferred = await tx.maybeOne(
      `update leads set processing_state = 'deferred'
        where id = $1 and account_id = $2 and process_rev = $3 and processing_state = 'processing'
        returning id`,
      [input.leadId, input.accountId, input.processRev],
    );
    if (deferred === null) return { type: 'lead_changed' as const };
    const dedupeKey = NotificationKeys.leadCap(input.accountId, day.date);
    const hasRecipients = (await capRecipients(tx, input.accountId)).length > 0;
    if (hasRecipients) {
      await reserveInTx(tx, { kind: 'lead_cap', dedupeKey, accountId: input.accountId, predicates: NotificationPredicates.leadCap(input.accountId), now });
    }
    return { type: 'deferred' as const, dedupeKey: hasRecipients ? dedupeKey : null, drafted };
  });

  if (decided.type !== 'deferred') return decided;
  log.info('lead deferred: daily cap reached', { event: 'lead.deferred', accountId: input.accountId, leadId: input.leadId, count: decided.drafted, limit });
  if (decided.dedupeKey === null) return { type: 'deferred', email: null };

  const plan = await leadCapPlan(deps, input.accountId);
  if (plan === null) return { type: 'deferred', email: null };
  try {
    const email = await reserveAndSend(deps, { kind: 'lead_cap', dedupeKey: decided.dedupeKey, accountId: input.accountId, ...plan });
    return { type: 'deferred', email };
  } catch (error) {
    if (!isRetryable(error)) throw error;
    // The reservation stays `sending`; the sweeper resumes it through resumeLeadCap. The lead stays deferred.
    log.warn('lead cap email not sent yet', { event: 'lead_cap.send_deferred', accountId: input.accountId, errorCode: errorCode(error) });
    return { type: 'deferred', email: { status: 'retry_later' } };
  }
}
