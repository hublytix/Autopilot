import 'server-only';
import { createElement } from 'react';
import { InboxTest, inboxTestSubject } from '@/emails/InboxTest';
import { PermanentError } from '@/server/domain/errors';
import type { Db } from '@/server/db';
import { renderEmail } from '@/server/email/render';
import { insertJob } from '@/server/jobs';
import type { Deps } from '@/server/ports';
import { actionLinkPath } from '@/server/services/action-links/paths';
import { NotificationKeys, NotificationPredicates, type LeadScope, type NotificationPredicate } from '@/server/services/notifications/predicates';
import type { NotificationResumer } from '@/server/services/notifications/renderers';
import type { MintedTokens, NotificationSendPlan, RenderedMail } from '@/server/services/notifications/types';
import { CHECK_INTERVAL_MS, INITIAL_REPLY_WINDOW_MS, LEG_WINDOW_MS } from './constants';
import { checkIdOfInboxTestKey, inboxCheckDedupeKey } from './keys';

// The `inbox_test` email (PLAN §8.4, §9.7 step 2, D-14, D-27): reserved with key
// `inbox-test:{checkId}`, sent to the owner's login address with Reply-To the owner's own address,
// the send button and the default-mail-app link (INBOX_TEST_BUTTONS: M4 adds edit and dismiss once
// those pages exist). Its predicates are PLAN §8.4's (test
// lead, account onboarding or active, connection active) plus "the check is still open with this
// test lead", so a skipped or superseded check's email is never sent late by the sweeper.
// When it is sent (in the `sent` transaction): the deadlines are set from the send time (the send
// leg 10 min, the reply leg 20 min: it can start at the latest when the send window ends; the job
// shortens it once the send is seen), the test lead is marked notified, and the first
// `inbox_check` job is inserted for one interval later. The resumer rebuilds the same plan from the
// reservation key, so a send lost to a crash or a transient Resend error is finished by the sweeper.

export const ONBOARDING_INBOX_PATH = '/onboarding/inbox';

/**
 * The action tokens the email carries. M4 adds 'edit' and 'dismiss' (and passes their URLs to the
 * template) when /a/{t}/edit and /a/{t}/dismiss exist; until then those links would 404 (law 5).
 */
export const INBOX_TEST_BUTTONS = ['send'] as const satisfies readonly ('send' | 'edit' | 'dismiss')[];

/** An action link (`/a/{token}/{action}`); the token is base64url, safe in a path. */
export function actionLinkUrl(appUrl: string, token: string, action: 'send' | 'edit' | 'dismiss'): string {
  return `${appUrl}${actionLinkPath(token, action)}`;
}

export function inboxTestPredicate(scope: LeadScope, checkId: string): NotificationPredicate {
  const base = NotificationPredicates.inboxTest(scope);
  return (bind) =>
    `(${base(bind)} and exists (select 1 from inbox_checks k
                                where k.id = ${bind(checkId)}::uuid and k.account_id = ${bind(scope.accountId)}::uuid
                                  and k.status = 'open' and k.test_lead_id = ${bind(scope.leadId)}::uuid))`;
}

interface InboxTestSource {
  accountId: string;
  leadId: string;
  draftId: string;
  ownerEmail: string;
  testAddress: string;
  leadMessage: string;
  draftSubject: string;
  draftBody: string;
}

async function loadSource(db: Db, checkId: string): Promise<InboxTestSource | null> {
  const row = await db.maybeOne<{
    account_id: string;
    lead_id: string;
    draft_id: string;
    owner_email: string;
    test_address: string | null;
    message: string | null;
    subject: string | null;
    body: string | null;
  }>(
    `select k.account_id, l.id as lead_id, d.id as draft_id, u.email as owner_email, m.email as test_address, m.message,
            d.subject, d.body
       from inbox_checks k
       join leads l on l.id = k.test_lead_id and l.account_id = k.account_id and l.is_test
       join lead_messages m on m.lead_id = l.id
       join drafts d on d.lead_id = l.id and d.kind = 'initial' and d.purged_at is null
       join accounts a on a.id = k.account_id
       join users u on u.account_id = a.id and u.auth_user_id = a.owner_user_id
      where k.id = $1`,
    [checkId],
  );
  if (row === null || row.test_address === null || row.subject === null || row.body === null) return null;
  return {
    accountId: row.account_id,
    leadId: row.lead_id,
    draftId: row.draft_id,
    ownerEmail: row.owner_email,
    testAddress: row.test_address,
    leadMessage: row.message ?? '',
    draftSubject: row.subject,
    draftBody: row.body,
  };
}

function requireToken(tokens: MintedTokens, purpose: 'send' | 'edit' | 'dismiss'): string {
  const token = tokens[purpose];
  if (token === undefined) throw new PermanentError('inbox_test_token_missing');
  return token;
}

export interface InboxTestPlan {
  readonly accountId: string;
  readonly leadId: string;
  readonly plan: NotificationSendPlan;
}

/** The send plan for a check whose test lead exists; null when its content is gone or nobody owns the account. */
export async function inboxTestPlan(deps: Deps, checkId: string): Promise<InboxTestPlan | null> {
  const source = await loadSource(deps.db, checkId);
  if (source === null) return null;
  const { env } = deps;
  const scope: LeadScope = { accountId: source.accountId, leadId: source.leadId };
  const plan: NotificationSendPlan = {
    predicates: inboxTestPredicate(scope, checkId),
    buttons: INBOX_TEST_BUTTONS,
    draftId: source.draftId,
    render: async (tokens): Promise<RenderedMail> => {
      const send = requireToken(tokens, 'send');
      const { html, text } = await renderEmail(
        createElement(InboxTest, {
          productName: env.PRODUCT_NAME,
          testAddress: source.testAddress,
          leadMessage: source.leadMessage,
          draftSubject: source.draftSubject,
          draftBody: source.draftBody,
          sendUrl: actionLinkUrl(env.APP_URL, send, 'send'),
          mailtoUrl: `${actionLinkUrl(env.APP_URL, send, 'send')}?via=mailto`,
          checkUrl: `${env.APP_URL}${ONBOARDING_INBOX_PATH}`,
        }),
      );
      return { to: [source.ownerEmail], replyTo: source.ownerEmail, subject: inboxTestSubject(env.PRODUCT_NAME), html, text };
    },
    onSent: async (tx) => {
      const now = deps.clock.now();
      await tx.query(
        `update leads set first_notified_at = coalesce(first_notified_at, $2), processing_state = 'notified'
          where id = $1 and is_test`,
        [source.leadId, now],
      );
      const started = await tx.maybeOne(
        `update inbox_checks set send_deadline_at = $2, reply_deadline_at = $3
          where id = $1 and status = 'open' and send_deadline_at is null returning id`,
        [checkId, new Date(now.getTime() + LEG_WINDOW_MS), new Date(now.getTime() + INITIAL_REPLY_WINDOW_MS)],
      );
      if (started === null) return [];
      const job = await insertJob(tx, {
        kind: 'inbox_check',
        accountId: source.accountId,
        dedupeKey: inboxCheckDedupeKey(source.accountId, checkId, 1),
        payload: { checkId },
        runAt: new Date(now.getTime() + CHECK_INTERVAL_MS),
        now,
        seq: 1,
      });
      return [job];
    },
  };
  return { accountId: source.accountId, leadId: source.leadId, plan };
}

export function inboxTestKey(checkId: string): string {
  return NotificationKeys.inboxTest(checkId);
}

/** Rebuilds a `sending` inbox_test reservation for the sweeper (or a later sendReserved). */
export const resumeInboxTest: NotificationResumer = async (deps, row) => {
  const checkId = checkIdOfInboxTestKey(row.dedupeKey);
  if (checkId === null) return null;
  return (await inboxTestPlan(deps, checkId))?.plan ?? null;
};
