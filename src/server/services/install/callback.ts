import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { errorCode, isAppError, isConfigError } from '@/server/domain/errors';
import type { Db } from '@/server/db';
import { isDbError } from '@/server/db';
import { extraScopes, missingRequiredScopes, REQUIRED_SCOPES } from '@/server/hubspot/scopes';
import { raiseAlert } from '@/server/jobs/alert';
import { log } from '@/server/obs/log';
import type { AccountDetails, ActiveTokenInfo, AuthUser, Deps, SessionCookie, TokenSet } from '@/server/ports';
import { claimOnce, hitFixedWindow, rateLimitKeyHash } from '@/server/security/rate-limit';
import { applyProcessingStateInTx } from '@/server/services/accounts/apply-processing-state';
import { accountLocalDate, ownerAlertKey, ownerAlertPlan } from '@/server/services/accounts/emails';
import { NO_POST_COMMIT_WORK, runPostCommitWork, type PostCommitWork } from '@/server/services/accounts/post-commit';
import { encryptTokens } from '@/server/services/hubspot/tokens';
import { reserveAndSend } from '@/server/services/notifications/send';
import { issuePendingInstallCookie, readState } from './cookies';
import { sendReconnectMagicLink as defaultSendReconnectMagicLink, type SendReconnectMagicLink } from './reconnect-magic-link';
import { resolveTimezone, type ResolvedTimezone } from './timezone';

// GET /api/hubspot/oauth/callback (PLAN §7.3, §9.1 step 1, D-12, D-35, D-36):
// rate limit (20 per minute per client IP) → verify the state cookie and spend its nonce (single
// use) → exchange the code → check the granted scopes (a missing one fails the install; an extra
// one is alerted and not stored, law 2) → introspect (portal id, hub_domain, installer email) →
// account details (timezone, UI domain, hosting location; a failure leaves the timezone for the
// owner) → one of four branches:
//   (a) new portal: account (trial from portal_history, else now + 14 d; portal_history written),
//       active connection, default settings, a pending_install cookie → /onboarding/email;
//   (b) existing, never bound: fresh tokens, connection active, last_install_at = now (the orphan
//       clock restarts), pending owner email reset (pending_owner_auth_user_id kept), purge_after and
//       disconnected_at cleared as in (c) (an earlier revoke set them; the → onboarding transition
//       has no side effects), trial kept, a new pending_install cookie → /onboarding/email;
//   (c) existing, owned, with the owner's verified session: reactivate (connection active; purge
//       and status fields cleared) and applyProcessingState → /dashboard?reconnected=1;
//   (d) existing, owned, without that session: nothing changes. The owner as installer → "sign in
//       to finish reconnecting" (+ a magic link, M3); anyone else → "connected elsewhere" and an
//       owner_alert to the owner.
// Tokens are encrypted before they reach the database; the code, the tokens and the installer's
// email are never logged.

export const TRIAL_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * Callbacks per client IP per minute. Every accepted callback costs a request to HubSpot's token
 * endpoint with our client credentials, the endpoint every portal's token refresh also uses.
 */
export const CALLBACK_RATE_LIMIT = 20;
export const CALLBACK_RATE_WINDOW_MS = 60 * 1000;

export type InstallFailureReason =
  /** The state cookie is missing, expired, forged, or carries another nonce. */
  | 'state'
  /** The installer cancelled on HubSpot's consent screen, or no code came back. */
  | 'denied'
  /** HubSpot refused the code (expired or reused). */
  | 'bad_code'
  /** HubSpot granted fewer scopes than the app requires. */
  | 'missing_scopes'
  /** Our OAuth client is misconfigured (the admin is alerted). */
  | 'config'
  /** HubSpot could not be reached, or answered unexpectedly; trying again may work. */
  | 'unavailable';

export type InstallOutcome =
  | { readonly type: 'onboarding'; readonly branch: 'new_portal' | 'unbound'; readonly accountId: string; readonly cookies: readonly SessionCookie[] }
  | { readonly type: 'reconnected'; readonly accountId: string }
  | { readonly type: 'sign_in_to_reconnect'; readonly accountId: string }
  | { readonly type: 'connected_elsewhere'; readonly accountId: string }
  | { readonly type: 'rate_limited'; readonly retryAfterSeconds: number }
  | { readonly type: 'failed'; readonly reason: InstallFailureReason };

export interface CallbackInput {
  /** Query parameters as received. */
  readonly code: string | null;
  readonly state: string | null;
  /** HubSpot's `error` parameter (e.g. the installer cancelled). */
  readonly error: string | null;
  /** The `ap_hs_state` cookie value. */
  readonly stateCookie: string | undefined;
  /** The client IP for the rate limit (only its HMAC is stored). */
  readonly ip: string;
  /** The verified session's user, read only when the portal already has an owner. */
  readonly sessionUser: () => Promise<AuthUser | null>;
}

export interface CallbackOptions {
  /** Branch (d)'s magic link (M3 builds it). */
  readonly sendReconnectMagicLink?: SendReconnectMagicLink | undefined;
}

/** Everything the branches need from HubSpot. */
interface Installed {
  readonly tokens: TokenSet;
  readonly info: ActiveTokenInfo;
  readonly scopes: readonly string[];
  readonly details: AccountDetails | null;
  readonly timezone: ResolvedTimezone;
}

function failed(reason: InstallFailureReason): InstallOutcome {
  return { type: 'failed', reason };
}

/** Maps an OAuth call's error to the failure page reason; a config error alerts the admin. */
function oauthFailure(error: unknown, step: 'exchange' | 'introspect'): InstallFailureReason {
  log.warn('hubspot install step failed', { event: 'hubspot.install_failed', reason: step, code: errorCode(error) }, error);
  if (isConfigError(error)) {
    raiseAlert('hubspot_install_oauth_config', { errorCode: error.code });
    return 'config';
  }
  if (step === 'exchange' && isAppError(error) && error.code === 'hubspot_bad_auth_code') return 'bad_code';
  return 'unavailable';
}

export async function completeInstall(deps: Deps, input: CallbackInput, options: CallbackOptions = {}): Promise<InstallOutcome> {
  const now = deps.clock.now();
  const hit = await hitFixedWindow(deps.db, {
    keyHash: rateLimitKeyHash(deps.env, `install:callback:ip:${input.ip}`),
    windowMs: CALLBACK_RATE_WINDOW_MS,
    now,
  });
  if (hit.count > CALLBACK_RATE_LIMIT) {
    log.warn('hubspot install callback rate limited', { event: 'hubspot.install_rate_limited', count: hit.count });
    return { type: 'rate_limited', retryAfterSeconds: Math.max(1, Math.ceil((hit.windowEnd.getTime() - now.getTime()) / 1000)) };
  }
  const state = readState(deps.env, input.stateCookie, input.state, now);
  if (state === null) return failed('state');
  // Single use: a replayed cookie and state pair cannot reach the token endpoint again.
  const firstUse = await claimOnce(deps.db, { keyHash: rateLimitKeyHash(deps.env, `install:state:${input.state ?? ''}`), windowStart: state.expiresAt });
  if (!firstUse) return failed('state');
  if (input.error !== null || input.code === null || input.code.length === 0 || input.code.length > 2048) return failed('denied');

  let tokens: TokenSet;
  try {
    tokens = await deps.hubspot.exchangeCode(input.code, deps.env.HUBSPOT_REDIRECT_URI);
  } catch (error) {
    return failed(oauthFailure(error, 'exchange'));
  }
  if (tokens.scopes !== undefined && missingRequiredScopes(tokens.scopes).length > 0) return failed('missing_scopes');

  let info: ActiveTokenInfo;
  try {
    const introspection = await deps.hubspot.introspect(tokens.accessToken, 'access_token');
    if (!introspection.active) return failed('unavailable');
    info = introspection;
  } catch (error) {
    return failed(oauthFailure(error, 'introspect'));
  }
  const granted = tokens.scopes ?? info.scopes;
  if (missingRequiredScopes(granted).length > 0) return failed('missing_scopes');
  // Law 2: the app asks for exactly REQUIRED_SCOPES. Anything more (a write scope added to the app's
  // optional scopes, say) is alerted, and only the required scopes are recorded; the request
  // allow-list still refuses every write.
  const extra = extraScopes(granted);
  if (extra.length > 0) {
    log.warn('hubspot granted extra scopes', { event: 'hubspot.install_extra_scopes', portalId: info.hubId, count: extra.length });
    raiseAlert('hubspot_install_extra_scopes', { portalId: info.hubId, count: extra.length });
  }
  const scopes: readonly string[] = REQUIRED_SCOPES.filter((scope) => granted.includes(scope));

  let details: AccountDetails | null = null;
  try {
    details = await deps.hubspot.accountDetails(tokens.accessToken);
  } catch (error) {
    // D-12: onboarding asks the owner for the timezone instead.
    log.warn('hubspot account details unavailable at install', { event: 'hubspot.install_details_failed', portalId: info.hubId, code: errorCode(error) });
  }
  const installed: Installed = { tokens, info, scopes, details, timezone: resolveTimezone(details) };

  // Two installs of a new portal can race on its account row: the loser retries as an existing portal.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const outcome = await routeInstall(deps, input, installed, options);
    if (outcome !== 'retry') {
      log.info('hubspot install handled', {
        event: 'hubspot.install',
        portalId: info.hubId,
        outcome: outcome.type === 'onboarding' ? outcome.branch : outcome.type,
        accountId: outcome.type === 'failed' || outcome.type === 'rate_limited' ? undefined : outcome.accountId,
      });
      return outcome;
    }
  }
  return failed('unavailable');
}

// ---------------------------------------------------------------------------------------------
// Branch selection
// ---------------------------------------------------------------------------------------------

const existingSchema = z.object({
  id: z.string(),
  owner_user_id: z.string().nullable(),
  timezone_source: z.string().nullable(),
  owner_auth_user_id: z.string().nullable(),
  owner_email: z.string().nullable(),
  connection_id: z.string().nullable(),
});

type ExistingAccount = z.infer<typeof existingSchema>;

async function findAccount(db: Db, portalId: string): Promise<ExistingAccount | null> {
  const raw = await db.maybeOne(
    `select a.id, a.owner_user_id, a.timezone_source, u.auth_user_id as owner_auth_user_id, u.email as owner_email, c.id as connection_id
       from accounts a
       left join users u on u.account_id = a.id
       left join hubspot_connections c on c.account_id = a.id
      where a.hubspot_portal_id = $1`,
    [portalId],
  );
  return raw === null ? null : existingSchema.parse(raw);
}

async function routeInstall(deps: Deps, input: CallbackInput, installed: Installed, options: CallbackOptions): Promise<InstallOutcome | 'retry'> {
  const existing = await findAccount(deps.db, installed.info.hubId);
  if (existing === null) return createPortal(deps, installed);
  if (existing.owner_user_id === null) return reinstallUnbound(deps, existing, installed);

  const user = await input.sessionUser();
  if (user !== null && user.userId === existing.owner_user_id && existing.owner_auth_user_id === user.userId) {
    return reconnectOwned(deps, existing, installed, user.userId);
  }
  return refuseOwned(deps, existing, installed, options);
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

interface ConnectionWrite {
  readonly connectionId: string;
  readonly accountId: string;
  readonly installed: Installed;
  readonly now: Date;
  /** Branch (c) also clears `reconnect_email_sent_at` (PLAN §9.1). */
  readonly clearReconnectEmail: boolean;
}

/** Stores fresh tokens on the account's connection (inserting it if missing) and makes it active. */
async function storeConnection(tx: Db, deps: Deps, write: ConnectionWrite, exists: boolean): Promise<void> {
  const { installed, now } = write;
  const encrypted = encryptTokens(deps.env, write.connectionId, installed.tokens);
  const expiresAt = new Date(now.getTime() + installed.tokens.expiresInSeconds * 1000);
  const d = installed.details;
  const values = [
    write.connectionId,
    installed.info.hubId,
    installed.info.hubDomain,
    d?.uiDomain ?? null,
    d?.dataHostingLocation ?? null,
    d?.accountType ?? null,
    [...installed.scopes],
    encrypted.accessTokenEnc,
    encrypted.refreshTokenEnc,
    expiresAt,
    now,
  ];
  if (!exists) {
    await tx.query(
      `insert into hubspot_connections
         (id, account_id, portal_id, hub_domain, ui_domain, data_hosting_location, account_type, scopes,
          access_token_enc, refresh_token_enc, access_expires_at, token_version, status, status_changed_at, last_refresh_at)
       values ($1, $12, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, 'active', $11, $11)`,
      [...values, write.accountId],
    );
    return;
  }
  // token_version moves, so a refresh or revoke still holding the old tokens can never overwrite these.
  await tx.query(
    `update hubspot_connections
        set portal_id = $2, hub_domain = $3, ui_domain = coalesce($4, ui_domain),
            data_hosting_location = coalesce($5, data_hosting_location), account_type = coalesce($6, account_type), scopes = $7,
            access_token_enc = $8, refresh_token_enc = $9, access_expires_at = $10, token_version = token_version + 1,
            status_changed_at = case when status <> 'active' then $11 else status_changed_at end, status = 'active',
            status_reason = null, refresh_lease_id = null, refresh_lease_until = null,
            transient_failures = 0, next_refresh_attempt_at = null, last_refresh_at = $11
            ${write.clearReconnectEmail ? ', reconnect_email_sent_at = null' : ''}
      where id = $1`,
    values,
  );
}

/** Updates the timezone from HubSpot unless the owner chose one. */
async function refreshTimezone(tx: Db, accountId: string, timezone: ResolvedTimezone): Promise<void> {
  if (timezone.timezone === null) return;
  await tx.query(
    `update accounts set timezone = $2, timezone_source = $3 where id = $1 and timezone_source is distinct from 'owner'`,
    [accountId, timezone.timezone, timezone.source],
  );
}

/** Branch (a). */
async function createPortal(deps: Deps, installed: Installed): Promise<InstallOutcome | 'retry'> {
  const now = deps.clock.now();
  const accountId = randomUUID();
  const portalId = installed.info.hubId;
  let work: PostCommitWork;
  try {
    work = await deps.db.tx(async (tx) => {
      const history = await tx.maybeOne<{ first_trial_started_at: Date }>(
        `select first_trial_started_at from portal_history where hubspot_portal_id = $1`,
        [portalId],
      );
      const trialStartedAt = history?.first_trial_started_at ?? now;
      await tx.query(`insert into portal_history (hubspot_portal_id, first_trial_started_at) values ($1, $2) on conflict do nothing`, [portalId, now]);
      await tx.query(
        `insert into accounts
           (id, hubspot_portal_id, processing_state, processing_state_changed_at, trial_started_at, trial_ends_at,
            timezone, timezone_source, last_install_at, created_at)
         values ($1, $2, 'onboarding', $3, $4, $5, $6, $7, $3, $3)`,
        [accountId, portalId, now, trialStartedAt, new Date(trialStartedAt.getTime() + TRIAL_MS), installed.timezone.timezone, installed.timezone.source],
      );
      await storeConnection(tx, deps, { connectionId: randomUUID(), accountId, installed, now, clearReconnectEmail: false }, false);
      // Defaults: quiet hours 19-08, weekends skipped, follow-ups on (the column defaults).
      await tx.query(`insert into settings (account_id) values ($1)`, [accountId]);
      return (await applyProcessingStateInTx(tx, now, accountId))?.work ?? NO_POST_COMMIT_WORK;
    });
  } catch (error) {
    if (isDbError(error) && (error.isUniqueViolation('accounts_hubspot_portal_id_key') || error.isUniqueViolation('hubspot_connections_portal_id_key'))) {
      return 'retry';
    }
    throw error;
  }
  await runPostCommitWork(deps, work);
  // `now` is the last_install_at this install wrote: only the newest cookie matches it (M3).
  const cookie = issuePendingInstallCookie(deps.env, { accountId, installerEmail: installed.info.userEmail, installedAt: now }, now);
  return { type: 'onboarding', branch: 'new_portal', accountId, cookies: [cookie] };
}

/** Branch (b). */
async function reinstallUnbound(deps: Deps, existing: ExistingAccount, installed: Installed): Promise<InstallOutcome | 'retry'> {
  const now = deps.clock.now();
  const accountId = existing.id;
  const result = await deps.db.tx(async (tx): Promise<PostCommitWork | 'retry'> => {
    const still = await tx.maybeOne(
      `update accounts set last_install_at = $2, pending_owner_email = null, pending_owner_expires_at = null,
                          purge_after = null, disconnected_at = null
        where id = $1 and owner_user_id is null returning id`,
      [accountId, now],
    );
    // Bound meanwhile: decide again as an owned portal.
    if (still === null) return 'retry';
    await refreshTimezone(tx, accountId, installed.timezone);
    const connectionId = existing.connection_id ?? randomUUID();
    await storeConnection(tx, deps, { connectionId, accountId, installed, now, clearReconnectEmail: false }, existing.connection_id !== null);
    return (await applyProcessingStateInTx(tx, now, accountId))?.work ?? NO_POST_COMMIT_WORK;
  });
  if (result === 'retry') return 'retry';
  await runPostCommitWork(deps, result);
  // `now` is the last_install_at this install wrote: only the newest cookie matches it (M3).
  const cookie = issuePendingInstallCookie(deps.env, { accountId, installerEmail: installed.info.userEmail, installedAt: now }, now);
  return { type: 'onboarding', branch: 'unbound', accountId, cookies: [cookie] };
}

/** Branch (c). */
async function reconnectOwned(deps: Deps, existing: ExistingAccount, installed: Installed, ownerUserId: string): Promise<InstallOutcome | 'retry'> {
  const now = deps.clock.now();
  const accountId = existing.id;
  const result = await deps.db.tx(async (tx): Promise<PostCommitWork | 'retry'> => {
    const still = await tx.maybeOne(
      `update accounts set purge_after = null, disconnected_at = null where id = $1 and owner_user_id = $2 returning id`,
      [accountId, ownerUserId],
    );
    if (still === null) return 'retry';
    await refreshTimezone(tx, accountId, installed.timezone);
    const connectionId = existing.connection_id ?? randomUUID();
    await storeConnection(tx, deps, { connectionId, accountId, installed, now, clearReconnectEmail: true }, existing.connection_id !== null);
    return (await applyProcessingStateInTx(tx, now, accountId))?.work ?? NO_POST_COMMIT_WORK;
  });
  if (result === 'retry') return 'retry';
  await runPostCommitWork(deps, result);
  return { type: 'reconnected', accountId };
}

/** Branch (d): nothing changes; the owner is told, one way or the other. */
async function refuseOwned(deps: Deps, existing: ExistingAccount, installed: Installed, options: CallbackOptions): Promise<InstallOutcome> {
  const accountId = existing.id;
  const installerEmail = installed.info.userEmail;
  if (installerEmail !== null && existing.owner_email !== null && installerEmail.toLowerCase() === existing.owner_email.toLowerCase()) {
    const send = options.sendReconnectMagicLink ?? defaultSendReconnectMagicLink;
    try {
      await send(deps, { accountId });
    } catch (error) {
      log.warn('reconnect magic link failed', { event: 'install.reconnect_magic_link_failed', accountId, code: errorCode(error) });
    }
    return { type: 'sign_in_to_reconnect', accountId };
  }

  try {
    const plan = await ownerAlertPlan(deps, accountId, 'reconnect_attempt');
    if (plan !== null) {
      const timezone = await deps.db.maybeOne<{ timezone: string | null }>(`select timezone from accounts where id = $1`, [accountId]);
      // One alert per account per local day, however often someone tries.
      const dedupeKey = ownerAlertKey(accountId, 'reconnect_attempt', accountLocalDate(deps.clock.now(), timezone?.timezone ?? null));
      await reserveAndSend(deps, { ...plan, kind: 'owner_alert', dedupeKey, accountId });
    }
  } catch (error) {
    // Still `sending`: the sweeper resumes it.
    log.warn('owner alert not sent yet', { event: 'install.owner_alert_deferred', accountId, code: errorCode(error) });
  }
  return { type: 'connected_elsewhere', accountId };
}
