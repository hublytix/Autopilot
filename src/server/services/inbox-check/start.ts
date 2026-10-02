import 'server-only';
import { errorCode, isRetryable, isRevoked } from '@/server/domain/errors';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import type { OwnerScope } from '@/server/services/auth/owner-scope';
import { forAccount, type Sleep } from '@/server/services/hubspot';
import { emailHmac, normalizeEmail } from '@/server/services/intake/submission';
import { reserveAndSend } from '@/server/services/notifications/send';
import { INBOX_CHECKS_PER_DAY, MAX_ADDRESS_LENGTH } from './constants';
import { inboxTestKey, inboxTestPlan } from './email';
import { readEmailHistory, type EmailHistory } from './history';
import { closeOpenChecksInTx } from './repository';
import { insertTestLeadInTx } from './test-lead';

// Starting the live test (PLAN §9.7 steps 1-2, D-14), from the owner's "Start the test":
// 1. the owner's other address is checked, and the `inbox_checks` row (address, its HMAC with the
//    dedupe key, `open`, created_at) is created AT ONCE, before any HubSpot call, so intake skips
//    submissions from that address made from 1 h before to 24 h after now (§9.2) — including the
//    form the owner may submit with it as a fix step. Earlier open checks are closed (legs skipped):
//    the newest test is the one that counts. At most INBOX_CHECKS_PER_DAY starts per rolling 24 h;
// 2. the history counts (two emails/search calls) are stored on the row (informational);
// 3. GET contacts/{testEmail}?idProperty=email: a 404 with no BCC address saved stops here and asks
//    the owner to add their BCC address or submit one of their own forms with the test address
//    (with a BCC address, the owner's send creates the contact);
// 4. the test lead (template draft, no LLM, content purged after 24 h) is created and linked;
// 5. the inbox_test email goes out through reserveAndSend; when it is sent, the deadlines are set
//    and the first inbox_check job is inserted (email.ts).
// HubSpot calls run outside any transaction. The address is never logged or put into an error.

export type StartInboxCheckResult =
  | { readonly type: 'started'; readonly checkId: string }
  | { readonly type: 'invalid_address' }
  /** The owner's own sign-in address: the test needs a different mailbox. */
  | { readonly type: 'same_as_owner' }
  /** The account is not onboarding/active or its HubSpot connection is not active. */
  | { readonly type: 'not_connected'; readonly checkId?: string | undefined }
  | { readonly type: 'rate_limited' }
  /** HubSpot has no contact for the address and no BCC address is saved: the fix step. */
  | { readonly type: 'test_contact_missing'; readonly checkId: string }
  /** HubSpot did not answer the contact lookup; the owner can try again. */
  | { readonly type: 'hubspot_unavailable'; readonly checkId: string }
  /** The test email could not be sent now; a transient failure is retried in the background. */
  | { readonly type: 'send_failed'; readonly checkId: string };

export interface StartInboxCheckInput {
  /** The raw form value. */
  readonly testAddress: unknown;
}

export interface StartInboxCheckOptions {
  /** For the portal limiter; default real timers (tests advance their FakeClock). */
  readonly sleep?: Sleep | undefined;
}

// A plain address: one @, no spaces, a dot in the domain.
const ADDRESS_SHAPE = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]+$/;

export function parseTestAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const address = normalizeEmail(value);
  if (address === null || address.length > MAX_ADDRESS_LENGTH || !ADDRESS_SHAPE.test(address)) return null;
  return address;
}

interface StartContext {
  ownerEmail: string;
  processingState: string;
  connectionStatus: string | null;
  scopes: readonly string[];
  bccSaved: boolean;
}

async function loadStartContext(deps: Deps, accountId: string): Promise<StartContext | null> {
  const row = await deps.db.maybeOne<{
    owner_email: string;
    processing_state: string;
    connection_status: string | null;
    scopes: string[] | null;
    bcc_address: string | null;
  }>(
    `select u.email as owner_email, a.processing_state, c.status as connection_status, c.scopes, s.bcc_address
       from accounts a
       join users u on u.account_id = a.id and u.auth_user_id = a.owner_user_id
       left join hubspot_connections c on c.account_id = a.id
       left join settings s on s.account_id = a.id
      where a.id = $1`,
    [accountId],
  );
  if (row === null) return null;
  return {
    ownerEmail: row.owner_email.trim().toLowerCase(),
    processingState: row.processing_state,
    connectionStatus: row.connection_status,
    scopes: row.scopes ?? [],
    bccSaved: (row.bcc_address ?? '').trim().length > 0,
  };
}

/** Step 1: the row, under the account lock with the daily limit; null when over the limit. */
async function createCheckRow(deps: Deps, accountId: string, address: string, now: Date): Promise<string | null> {
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return deps.db.tx(async (tx) => {
    await tx.query(`select id from accounts where id = $1 for no key update`, [accountId]);
    const recent = await tx.one<{ count: string }>(`select count(*) as count from inbox_checks where account_id = $1 and created_at > $2`, [
      accountId,
      dayAgo,
    ]);
    if (Number(recent.count) >= INBOX_CHECKS_PER_DAY) return null;
    await closeOpenChecksInTx(tx, accountId, now);
    const row = await tx.one<{ id: string }>(
      `insert into inbox_checks (account_id, test_address, test_address_hmac, status, created_at)
       values ($1, $2, $3, 'open', $4) returning id`,
      [accountId, address, emailHmac(deps.env, address), now],
    );
    return row.id;
  });
}

async function storeHistory(deps: Deps, checkId: string, history: EmailHistory): Promise<void> {
  if (history.status !== 'ok') return;
  await deps.db.query(`update inbox_checks set history_outbound_30d = $2, history_inbound_30d = $3 where id = $1`, [
    checkId,
    history.outbound,
    history.inbound,
  ]);
}

export async function startInboxCheck(
  scope: OwnerScope,
  deps: Deps,
  input: StartInboxCheckInput,
  options: StartInboxCheckOptions = {},
): Promise<StartInboxCheckResult> {
  const address = parseTestAddress(input.testAddress);
  if (address === null) return { type: 'invalid_address' };
  const accountId = scope.accountId;
  const context = await loadStartContext(deps, accountId);
  if (context === null) return { type: 'not_connected' };
  if (address === context.ownerEmail) return { type: 'same_as_owner' };
  if (!['onboarding', 'active'].includes(context.processingState) || context.connectionStatus !== 'active') return { type: 'not_connected' };

  // 1. The row, before any HubSpot call (the intake skip window starts now).
  const checkId = await createCheckRow(deps, accountId, address, deps.clock.now());
  if (checkId === null) return { type: 'rate_limited' };

  // 2. History (informational).
  const client = forAccount(deps, accountId, { sleep: options.sleep });
  await storeHistory(deps, checkId, await readEmailHistory(client, { scopes: context.scopes, now: deps.clock.now() }));

  // 3. The test contact.
  let contactId: string | null;
  try {
    const contact = await client.getContact(address, { idProperty: 'email', properties: ['email'] });
    contactId = contact?.id ?? null;
  } catch (error) {
    if (isRevoked(error)) return { type: 'not_connected', checkId };
    log.warn('inbox check contact lookup failed', { event: 'inbox_check.contact_failed', accountId, code: errorCode(error) });
    return { type: 'hubspot_unavailable', checkId };
  }
  if (contactId === null && !context.bccSaved) return { type: 'test_contact_missing', checkId };

  // 4. The test lead, its content and its template draft.
  const now = deps.clock.now();
  const lead = await deps.db.tx((tx) =>
    insertTestLeadInTx(tx, { accountId, checkId, contactId, testAddress: address, productName: deps.env.PRODUCT_NAME, now }),
  );
  if (lead === null) return { type: 'send_failed', checkId };

  // 5. The test email; its `sent` transaction sets the deadlines and inserts the first job.
  const built = await inboxTestPlan(deps, checkId);
  if (built === null) return { type: 'send_failed', checkId };
  try {
    const result = await reserveAndSend(deps, {
      ...built.plan,
      kind: 'inbox_test',
      dedupeKey: inboxTestKey(checkId),
      accountId,
      leadId: built.leadId,
    });
    if (result.status === 'sent' || result.status === 'already_sent') {
      log.info('inbox check started', { event: 'inbox_check.started', accountId, leadId: built.leadId });
      return { type: 'started', checkId };
    }
    log.warn('inbox test email not sent', { event: 'inbox_check.email_not_sent', accountId, status: result.status });
    return { type: 'send_failed', checkId };
  } catch (error) {
    if (!isRetryable(error)) throw error;
    // The reservation stays `sending`: the sweeper resumes it (resumeInboxTest), and its `sent`
    // transaction then starts the check.
    log.warn('inbox test email deferred', { event: 'inbox_check.email_deferred', accountId, code: errorCode(error) });
    return { type: 'send_failed', checkId };
  }
}
