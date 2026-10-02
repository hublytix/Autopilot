import 'server-only';
import { isAppError, isRevoked, TransientError } from '@/server/domain/errors';
import type { EmailMetadataProperty } from '@/server/domain/types';
import type {
  AccountDetails,
  Deps,
  EmailCountQuery,
  EmailEngagement,
  EmailIdPage,
  GetContactOptions,
  HubSpotCallOptions,
  HubSpotContact,
  HubSpotForm,
  ListContactEmailIdsOptions,
  ListSubmissionsOptions,
  SubmissionPage,
} from '@/server/ports';
import { currentDailyLimit, dailyLimitError, isDailyLimit, recordDailyLimit } from './daily-limit';
import { acquirePortalSlot, type PortalBucket } from './portal-limiter';
import { ACCESS_TOKEN_SKEW_MS, getAccessToken, realSleep, resetRefreshFailures, type AccessToken, type Sleep } from './token-manager';

// One account's view of HubSpot (PLAN §9.1 step 3, D-11, D-36): the HubSpotClient API methods
// without the token argument. Each call
// 1. obtains the access token from the token manager (cached for this client while fresh);
// 2. waits for the portal limiter (general 9 and search 2 per one-second window, portal-limiter.ts);
// 3. on a 401, forces one refresh and retries once. A refresh classified revoked takes the revoked
//    path and rethrows; any other refresh failure, or a second 401, is a TransientError;
// 4. after the first success, resets the inline failure counters (D-11 "any successful API call");
// 5. honours HubSpot's daily limit (./daily-limit.ts): a portal held until its next local midnight
//    is refused before any call (checked once per client), and a daily-limit 429 records the hold
//    and is rethrown with a Retry-After up to it, so a job is re-targeted there (D-11).
// OAuth calls (exchange, refresh, introspect, revoke) are not portal-limited and are not here.

/** HubSpot's batch read takes at most 100 ids: one limiter slot per batch. */
export const EMAIL_BATCH_SIZE = 100;

export interface PortalClientOptions {
  /** The poll cron and the lead-page refresh (D-11): their refresh failures are counted. */
  inline?: boolean | undefined;
  /** Default: real timers. Tests inject one that advances their FakeClock. */
  sleep?: Sleep | undefined;
}

export interface PortalHubSpotClient {
  readonly accountId: string;
  accountDetails(options?: HubSpotCallOptions): Promise<AccountDetails>;
  listForms(options?: HubSpotCallOptions): Promise<HubSpotForm[]>;
  listSubmissions(formId: string, options: ListSubmissionsOptions): Promise<SubmissionPage>;
  getContact(idOrEmail: string, options: GetContactOptions): Promise<HubSpotContact | null>;
  listContactEmailIds(contactId: string, options: ListContactEmailIdsOptions): Promise<EmailIdPage>;
  batchReadEmails(ids: readonly string[], properties: readonly EmailMetadataProperty[], options?: HubSpotCallOptions): Promise<EmailEngagement[]>;
  searchEmailsCount(query: EmailCountQuery, options?: HubSpotCallOptions): Promise<number>;
  uninstallApp(options?: HubSpotCallOptions): Promise<void>;
}

function isUnauthorized(error: unknown): boolean {
  return isAppError(error) && error.code === 'hubspot_unauthorized';
}

export function forAccount(deps: Deps, accountId: string, options: PortalClientOptions = {}): PortalHubSpotClient {
  const sleep = options.sleep ?? realSleep;
  const inline = options.inline === true;
  let cached: AccessToken | null = null;
  let failuresReset = false;
  /** Undefined until the first call reads the stored hold; null when there is none. */
  let heldUntil: Date | null | undefined;

  async function token(forceRefreshFromVersion?: number): Promise<AccessToken> {
    const now = deps.clock.now();
    if (forceRefreshFromVersion === undefined && cached !== null && cached.expiresAt.getTime() - ACCESS_TOKEN_SKEW_MS > now.getTime()) {
      return cached;
    }
    cached = await getAccessToken(deps, accountId, { inline, sleep, forceRefreshFromVersion });
    return cached;
  }

  async function succeeded(current: AccessToken): Promise<void> {
    if (failuresReset || !current.hasFailureCount) return;
    failuresReset = true;
    await resetRefreshFailures(deps.db, current.connectionId);
  }

  async function call<T>(bucket: PortalBucket, request: (accessToken: string) => Promise<T>): Promise<T> {
    const now = deps.clock.now();
    heldUntil ??= await currentDailyLimit(deps.db, accountId, now);
    if (heldUntil !== null && now.getTime() < heldUntil.getTime()) throw dailyLimitError(heldUntil, now);
    try {
      return await callWithTokenRules(bucket, request);
    } catch (error) {
      if (!isDailyLimit(error)) throw error;
      const at = deps.clock.now();
      heldUntil = await recordDailyLimit(deps.db, accountId, at);
      throw dailyLimitError(heldUntil, at);
    }
  }

  async function callWithTokenRules<T>(bucket: PortalBucket, request: (accessToken: string) => Promise<T>): Promise<T> {
    let current = await token();
    await acquirePortalSlot(deps, current.portalId, bucket, sleep);
    try {
      const result = await request(current.accessToken);
      await succeeded(current);
      return result;
    } catch (error) {
      if (!isUnauthorized(error)) throw error;
    }

    // The 401 rule (D-11): one forced refresh, then one retry.
    try {
      current = await token(current.tokenVersion);
    } catch (error) {
      if (isRevoked(error) || error instanceof TransientError) throw error;
      throw new TransientError('hubspot_unauthorized', { httpStatus: 401 });
    }
    await acquirePortalSlot(deps, current.portalId, bucket, sleep);
    try {
      const result = await request(current.accessToken);
      await succeeded(current);
      return result;
    } catch (error) {
      if (isUnauthorized(error)) throw new TransientError('hubspot_unauthorized', { httpStatus: 401 });
      throw error;
    }
  }

  return {
    accountId,
    accountDetails: (callOptions) => call('general', (t) => deps.hubspot.accountDetails(t, callOptions)),
    listForms: (callOptions) => call('general', (t) => deps.hubspot.listForms(t, callOptions)),
    listSubmissions: (formId, callOptions) => call('general', (t) => deps.hubspot.listSubmissions(t, formId, callOptions)),
    getContact: (idOrEmail, callOptions) => call('general', (t) => deps.hubspot.getContact(t, idOrEmail, callOptions)),
    listContactEmailIds: (contactId, callOptions) => call('general', (t) => deps.hubspot.listContactEmailIds(t, contactId, callOptions)),
    async batchReadEmails(ids, properties, callOptions) {
      const results: EmailEngagement[] = [];
      for (let start = 0; start < ids.length; start += EMAIL_BATCH_SIZE) {
        const chunk = ids.slice(start, start + EMAIL_BATCH_SIZE);
        results.push(...(await call('general', (t) => deps.hubspot.batchReadEmails(t, chunk, properties, callOptions))));
      }
      return results;
    },
    searchEmailsCount: (query, callOptions) => call('search', (t) => deps.hubspot.searchEmailsCount(t, query, callOptions)),
    uninstallApp: (callOptions) => call('general', (t) => deps.hubspot.uninstallApp(t, callOptions)),
  };
}
