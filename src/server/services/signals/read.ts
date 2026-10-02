import 'server-only';
import { errorCode, isAppError } from '@/server/domain/errors';
import { mergedContactIds, SIGNAL_CONTACT_PROPERTIES, type ContactProperties } from '@/server/domain/signals';
import { EMAIL_METADATA_PROPERTIES } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { canReadEmails } from '@/server/hubspot/scopes';
import { log } from '@/server/obs/log';
import type { Deps, EmailEngagement } from '@/server/ports';
import { forAccount, type PortalHubSpotClient, type Sleep } from '@/server/services/hubspot';

// The contact read behind the follow-up stops and signals (PLAN §9.5 step 3, D-08, D-09,
// HS-EMAIL-BY-CONTACT, HS-CONTACT-GET-WITH-EMAILS, HS-CONTACT-DELETED-MERGED), read-only (law 2)
// and metadata only (law 4):
// 1. GET contacts/{id} with SIGNAL_CONTACT_PROPERTIES and associations=emails, by the stored id (a
//    single GET resolves a merged contact's old id; batch endpoints may not). 404 (null) → the
//    contact was deleted. A different id, or ids in `hs_merged_object_ids` → the contact was merged:
//    every non-test lead of the account on the old id or any merged id is re-mapped to the new one,
//    and the read continues with it.
// 2. The remaining association pages (listContactEmailIds), up to MAX_ASSOCIATION_PAGES; a cursor
//    seen before ends the paging. Either way the id list may miss emails (association order is not
//    chronological), so the read is not complete (`emailsComplete: false`).
// 3. emails/batch/read in chunks of 100 (the portal client chunks) with EMAIL_METADATA_PROPERTIES
//    only. Without `sales-email-read` (stored grant, or HubSpot's 403 MISSING_SCOPES on the contact GET
//    with associations, on an association page or on the email read) no email is read.
// A read without every logged email (`emailsAvailable` or `emailsComplete` false) can confirm nothing
// from engagements and never shows "no reply": "not enough data", never an estimate (law 3, D-73).
// HubSpot errors other than the missing scope propagate (a follow-up job retries; the daily limit
// re-targets it, D-11).

/** Association pages after the contact GET's first one; beyond it the read goes on with what it has. */
export const MAX_ASSOCIATION_PAGES = 50;

export type ContactSignalsRead =
  | { readonly type: 'deleted'; readonly contactId: string }
  | {
      readonly type: 'found';
      /** The id the contact has now (the merged record's after a merge). */
      readonly contactId: string;
      /** The stored id when HubSpot answered with another one (a merge); null otherwise. */
      readonly mergedFrom: string | null;
      readonly properties: ContactProperties;
      /** Metadata of the contact's logged emails; empty when they could not be read. */
      readonly emails: readonly EmailEngagement[];
      /** False without the email scope: no send or reply can be confirmed from engagements. */
      readonly emailsAvailable: boolean;
      /** False when the association paging stopped early (the cap, a repeated cursor): some emails were not read. */
      readonly emailsComplete: boolean;
    };

export interface SignalLeadRef {
  readonly id: string;
  /** `leads.hubspot_contact_id`. */
  readonly hubspotContactId: string;
}

export interface ReadContactSignalsOptions {
  /** An existing client for the account (the caller's job may already hold one). */
  readonly client?: PortalHubSpotClient | undefined;
  /** The portal limiter's wait (tests and the simulation advance their FakeClock). */
  readonly sleep?: Sleep | undefined;
  readonly signal?: AbortSignal | undefined;
}

async function grantedScopes(db: Db, accountId: string): Promise<readonly string[]> {
  const row = await db.maybeOne<{ scopes: string[] | null }>(`select scopes from hubspot_connections where account_id = $1`, [accountId]);
  return row?.scopes ?? [];
}

/**
 * Re-maps the account's non-test leads from a merged contact's old ids to its new one. A lead whose
 * (account, contact, submitted_at) would collide with a lead already on the new id keeps its old id.
 */
export async function remapMergedContact(
  db: Db,
  input: { accountId: string; fromContactIds: readonly string[]; toContactId: string },
): Promise<number> {
  const from = input.fromContactIds.filter((id) => id !== input.toContactId);
  if (from.length === 0) return 0;
  const rows = await db.query<{ id: string }>(
    `update leads l set hubspot_contact_id = $3
      where l.account_id = $1 and l.hubspot_contact_id = any($2::text[]) and not l.is_test
        and not exists (select 1 from leads o
                         where o.account_id = l.account_id and o.hubspot_contact_id = $3 and o.submitted_at = l.submitted_at)
      returning l.id`,
    [input.accountId, from, input.toContactId],
  );
  return rows.length;
}

function isMissingScopes(error: unknown): boolean {
  return isAppError(error) && error.code === 'hubspot_missing_scopes';
}

function emailsUnavailable(client: PortalHubSpotClient, error: unknown): void {
  log.warn('email metadata not readable', { event: 'signals.emails_unavailable', accountId: client.accountId, code: errorCode(error) });
}

type AssociatedIds = { readonly type: 'ids'; readonly ids: string[]; readonly complete: boolean } | { readonly type: 'unavailable' };

async function associatedEmailIds(
  client: PortalHubSpotClient,
  contactId: string,
  first: { ids: readonly string[]; nextAfter: string | undefined },
  signal: AbortSignal | undefined,
): Promise<AssociatedIds> {
  const ids = [...first.ids];
  const seen = new Set<string>();
  let after = first.nextAfter;
  let pages = 0;
  while (after !== undefined && pages < MAX_ASSOCIATION_PAGES && !seen.has(after)) {
    seen.add(after);
    let page: Awaited<ReturnType<PortalHubSpotClient['listContactEmailIds']>>;
    try {
      page = await client.listContactEmailIds(contactId, { after, signal });
    } catch (error) {
      if (!isMissingScopes(error)) throw error;
      emailsUnavailable(client, error);
      return { type: 'unavailable' };
    }
    ids.push(...page.ids);
    after = page.nextAfter;
    pages += 1;
  }
  if (after !== undefined) {
    const reason = seen.has(after) ? 'cursor_repeated' : 'page_cap';
    log.warn('contact email associations not all read', { event: 'signals.association_pages_capped', accountId: client.accountId, contactId, pages, reason });
  }
  return { type: 'ids', ids: [...new Set(ids)], complete: after === undefined };
}

async function readEmails(
  client: PortalHubSpotClient,
  ids: readonly string[],
  signal: AbortSignal | undefined,
): Promise<{ emails: EmailEngagement[]; available: boolean }> {
  if (ids.length === 0) return { emails: [], available: true };
  try {
    return { emails: await client.batchReadEmails(ids, EMAIL_METADATA_PROPERTIES, { signal }), available: true };
  } catch (error) {
    if (!isMissingScopes(error)) throw error;
    emailsUnavailable(client, error);
    return { emails: [], available: false };
  }
}

/** The contact GET; with associations, a 403 MISSING_SCOPES is retried once without them (the emails then stay unread). */
async function getSignalContact(
  client: PortalHubSpotClient,
  contactId: string,
  withEmails: boolean,
  signal: AbortSignal | undefined,
): Promise<{ contact: Awaited<ReturnType<PortalHubSpotClient['getContact']>>; emailsReadable: boolean }> {
  if (!withEmails) return { contact: await client.getContact(contactId, { properties: SIGNAL_CONTACT_PROPERTIES, signal }), emailsReadable: false };
  try {
    return { contact: await client.getContact(contactId, { properties: SIGNAL_CONTACT_PROPERTIES, associations: ['emails'], signal }), emailsReadable: true };
  } catch (error) {
    if (!isMissingScopes(error)) throw error;
    emailsUnavailable(client, error);
    return { contact: await client.getContact(contactId, { properties: SIGNAL_CONTACT_PROPERTIES, signal }), emailsReadable: false };
  }
}

/** PLAN §9.5 step 3 for one lead. Never called for a test lead (they have no contact). */
export async function readContactSignals(
  deps: Deps,
  accountId: string,
  lead: SignalLeadRef,
  options: ReadContactSignalsOptions = {},
): Promise<ContactSignalsRead> {
  const client = options.client ?? forAccount(deps, accountId, { sleep: options.sleep });
  const signal = options.signal;
  const scopes = await grantedScopes(deps.db, accountId);
  const emailsReadable = canReadEmails(scopes);

  const { contact, emailsReadable: withEmails } = await getSignalContact(client, lead.hubspotContactId, emailsReadable, signal);
  if (contact === null) return { type: 'deleted', contactId: lead.hubspotContactId };

  // A merge: every lead of the account on any id folded into this record (the stored one and
  // `hs_merged_object_ids`, so a lead on the other merged contact moves too, D-44 sees one contact).
  const mergedFrom = contact.id !== lead.hubspotContactId ? lead.hubspotContactId : null;
  const fromContactIds = [...new Set([...(mergedFrom === null ? [] : [mergedFrom]), ...mergedContactIds(contact.properties)])];
  if (fromContactIds.some((id) => id !== contact.id)) {
    const remapped = await remapMergedContact(deps.db, { accountId, fromContactIds, toContactId: contact.id });
    if (mergedFrom !== null || remapped > 0) {
      log.info('merged contact re-mapped', { event: 'signals.contact_remapped', accountId, leadId: lead.id, contactId: contact.id, count: remapped });
    }
  }

  const found = { type: 'found', contactId: contact.id, mergedFrom, properties: contact.properties } as const;
  if (!withEmails) return { ...found, emails: [], emailsAvailable: false, emailsComplete: false };
  const ids = await associatedEmailIds(
    client,
    contact.id,
    { ids: contact.associatedEmailIds ?? [], nextAfter: contact.associationsNextAfter },
    signal,
  );
  if (ids.type === 'unavailable') return { ...found, emails: [], emailsAvailable: false, emailsComplete: false };
  const { emails, available } = await readEmails(client, ids.ids, signal);
  return { ...found, emails, emailsAvailable: available, emailsComplete: available && ids.complete };
}
