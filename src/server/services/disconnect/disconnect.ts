import 'server-only';
import { z } from 'zod';
import { errorCode } from '@/server/domain/errors';
import { CONNECTION_STATUSES, type ConnectionStatus } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { applyProcessingStateInTx } from '@/server/services/accounts/apply-processing-state';
import { NO_POST_COMMIT_WORK, runPostCommitWork, type PostCommitWork } from '@/server/services/accounts/post-commit';
import { insertAudit } from '@/server/services/audit';
import type { OwnerScope } from '@/server/services/auth/owner-scope';
import { cancelSubscriptionForOwner, type CancelOutcome } from '@/server/services/billing/manage';
import { loadAccountSubscriptions } from '@/server/services/billing/rows';
import { ACCESS_TOKEN_SKEW_MS, acquirePortalSlot, decryptAccessToken, decryptRefreshToken, realSleep, type Sleep } from '@/server/services/hubspot';
import { disconnectBillingOption } from './billing-option';

// The owner's Disconnect (PLAN §9.1 step 5, §7.5, D-10, D-48). Best effort first, each step on its
// own, failures logged by code only (never a token):
// 1. optionally cancel the Razorpay subscription, only from `authenticated` (now: nothing is
//    charged) or `active` (at the end of the period), through the billing page's cancel (the
//    billing lock, Razorpay outside any transaction, apply-if-newer); any other state is explained
//    by the dialog and left alone;
// 2. the uninstall API (`DELETE /appinstalls/…/external-install`; HubSpot emails the portal's admins),
//    then the refresh-token revoke, with the connection's own tokens. A stale access token is
//    refreshed once for the uninstall, straight through the HubSpot port: the token manager would
//    take the revoked path on a revoked refresh token, which emails the owner "Reconnect HubSpot"
//    in the middle of their own disconnect.
// Then ALWAYS, in one transaction (accounts locked before the connection, docs/ARCHITECTURE.md):
// the tokens wiped, the connection `disconnected` (`status_reason = 'owner_disconnected'`), and
// applyProcessingState (→ disconnected: `purge_after = $now + 30 d`, `disconnected_at`, jobs
// cancelled except privacy deletions, action tokens revoked, `stop_reason = 'account_inactive'` on
// the leads whose follow-ups that cancels, D-72), plus one `account.disconnected` audit row. After
// commit, the QStash cancels. The owner stays signed in: the dashboard then offers Reconnect.

export const OWNER_DISCONNECTED_REASON = 'owner_disconnected';
/** Each HubSpot call is bounded like a token refresh (PLAN §9.1 step 3). */
export const DISCONNECT_CALL_TIMEOUT_MS = 8_000;

export interface DisconnectInput {
  /** The owner ticked "also cancel my subscription". */
  readonly cancelBilling: boolean;
}

export interface DisconnectOptions {
  /** For the portal limiter; tests advance their FakeClock instead of waiting. */
  readonly sleep?: Sleep | undefined;
}

export type DisconnectBillingOutcome =
  | 'not_requested'
  /** `authenticated` cancelled now, before its first payment: nothing is charged. */
  | 'cancelled'
  /** `authenticated` cancelled now, after its first payment was due (no future start_at): nothing more is charged. */
  | 'cancelled_after_payment'
  /** `active` cancelled at the end of the current period. */
  | 'cancel_scheduled'
  | 'already_cancelled'
  /** `paused`, `pending`, `halted` or `unknown`: the API can't cancel it (the dialog said so). */
  | 'not_cancellable'
  | 'nothing_to_cancel'
  /** Razorpay refused or was unavailable, or another billing action held the lock: cancel it on the billing page. */
  | 'failed';

export type HubSpotStepOutcome = 'done' | 'failed' | 'skipped';

export interface DisconnectResult {
  /** `already_disconnected`: nothing was connected (a second submit, or an earlier disconnect). */
  readonly type: 'disconnected' | 'already_disconnected' | 'account_missing';
  readonly billing: DisconnectBillingOutcome;
  readonly uninstall: HubSpotStepOutcome;
  readonly revoke: HubSpotStepOutcome;
}

const connectionSchema = z.object({
  id: z.string(),
  portal_id: z.string(),
  status: z.enum(CONNECTION_STATUSES),
  access_token_enc: z.string().nullable(),
  refresh_token_enc: z.string().nullable(),
  access_expires_at: z.date().nullable(),
});
type ConnectionRow = z.infer<typeof connectionSchema>;

async function loadConnection(db: Db, accountId: string): Promise<ConnectionRow | null> {
  const raw = await db.maybeOne(
    `select id, portal_id, status, access_token_enc, refresh_token_enc, access_expires_at from hubspot_connections where account_id = $1`,
    [accountId],
  );
  return raw === null ? null : connectionSchema.parse(raw);
}

function callSignal(): AbortSignal {
  return AbortSignal.timeout(DISCONNECT_CALL_TIMEOUT_MS);
}

function billingOutcome(outcome: CancelOutcome): DisconnectBillingOutcome {
  switch (outcome.type) {
    case 'cancelled':
      return outcome.beforeFirstPayment ? 'cancelled' : 'cancelled_after_payment';
    case 'cancel_scheduled':
      return 'cancel_scheduled';
    case 'already_scheduled':
      return 'already_cancelled';
    case 'nothing_to_cancel':
      return 'nothing_to_cancel';
    case 'refused':
    case 'unavailable':
    case 'busy':
      return 'failed';
  }
}

/** Step 1: the optional Razorpay cancel (never throws). */
async function cancelBilling(deps: Deps, scope: OwnerScope): Promise<DisconnectBillingOutcome> {
  try {
    const option = disconnectBillingOption(await loadAccountSubscriptions(deps.db, scope.accountId));
    switch (option.type) {
      case 'none':
        return 'nothing_to_cancel';
      case 'not_cancellable':
        return 'not_cancellable';
      case 'already_cancelled':
        return 'already_cancelled';
      case 'cancellable': {
        const outcome = billingOutcome(await cancelSubscriptionForOwner(deps, scope));
        if (outcome === 'failed') log.warn('disconnect: billing cancel failed', { event: 'disconnect.billing_failed', accountId: scope.accountId });
        return outcome;
      }
    }
  } catch (error) {
    log.warn('disconnect: billing cancel failed', { event: 'disconnect.billing_failed', accountId: scope.accountId, code: errorCode(error) });
    return 'failed';
  }
}

/** An access token for the uninstall: the stored one while fresh, else one refresh (not stored: the tokens are wiped next). */
async function accessTokenFor(deps: Deps, connection: ConnectionRow, refreshToken: string): Promise<string> {
  const now = deps.clock.now();
  if (connection.access_token_enc !== null && connection.access_expires_at !== null && connection.access_expires_at.getTime() - ACCESS_TOKEN_SKEW_MS > now.getTime()) {
    return decryptAccessToken(deps.env, connection.id, connection.access_token_enc);
  }
  return (await deps.hubspot.refresh(refreshToken, { signal: callSignal() })).accessToken;
}

/** Step 2: the uninstall API, then the token revoke (never throws). */
async function releaseHubSpot(deps: Deps, accountId: string, options: DisconnectOptions): Promise<{ uninstall: HubSpotStepOutcome; revoke: HubSpotStepOutcome }> {
  const connection = await loadConnection(deps.db, accountId);
  if (connection === null || connection.status !== 'active' || connection.refresh_token_enc === null) return { uninstall: 'skipped', revoke: 'skipped' };
  let refreshToken: string;
  try {
    refreshToken = decryptRefreshToken(deps.env, connection.id, connection.refresh_token_enc);
  } catch (error) {
    log.warn('disconnect: tokens unreadable', { event: 'disconnect.tokens_unreadable', accountId, connectionId: connection.id, code: errorCode(error) });
    return { uninstall: 'failed', revoke: 'failed' };
  }

  let uninstall: HubSpotStepOutcome = 'done';
  try {
    const accessToken = await accessTokenFor(deps, connection, refreshToken);
    await acquirePortalSlot(deps, connection.portal_id, 'general', options.sleep ?? realSleep);
    await deps.hubspot.uninstallApp(accessToken, { signal: callSignal() });
  } catch (error) {
    uninstall = 'failed';
    log.warn('disconnect: uninstall failed', { event: 'disconnect.uninstall_failed', accountId, connectionId: connection.id, code: errorCode(error) });
  }

  let revoke: HubSpotStepOutcome = 'done';
  try {
    await deps.hubspot.revoke(refreshToken, { signal: callSignal() });
  } catch (error) {
    revoke = 'failed';
    log.warn('disconnect: token revoke failed', { event: 'disconnect.revoke_failed', accountId, connectionId: connection.id, code: errorCode(error) });
  }
  return { uninstall, revoke };
}

interface LocalOutcome {
  readonly type: DisconnectResult['type'];
  readonly work: PostCommitWork;
}

/** The part that always runs: one transaction, accounts locked before the connection. */
export async function disconnectLocallyInTx(tx: Db, now: Date, accountId: string): Promise<LocalOutcome> {
  const locked = await tx.maybeOne(`select id from accounts where id = $1 for no key update`, [accountId]);
  if (locked === null) return { type: 'account_missing', work: NO_POST_COMMIT_WORK };
  const before = await tx.maybeOne<{ status: ConnectionStatus; holds_tokens: boolean }>(
    `select status, (access_token_enc is not null or refresh_token_enc is not null) as holds_tokens
       from hubspot_connections where account_id = $1 for update`,
    [accountId],
  );
  const changed = before !== null && (before.status !== 'disconnected' || before.holds_tokens);
  if (changed) {
    await tx.query(
      `update hubspot_connections
          set status = 'disconnected', status_reason = $3,
              status_changed_at = case when status <> 'disconnected' then $2 else status_changed_at end,
              access_token_enc = null, refresh_token_enc = null, access_expires_at = null,
              refresh_lease_id = null, refresh_lease_until = null
        where account_id = $1`,
      [accountId, now, OWNER_DISCONNECTED_REASON],
    );
  }
  const applied = await applyProcessingStateInTx(tx, now, accountId);
  if (changed) {
    await insertAudit(tx, { accountId, actor: 'owner', action: 'account.disconnected', level: 'info', meta: {} });
  }
  return { type: changed ? 'disconnected' : 'already_disconnected', work: applied?.work ?? NO_POST_COMMIT_WORK };
}

/** Disconnect HubSpot for the owner's account (see the header). */
export async function disconnectHubSpot(deps: Deps, scope: OwnerScope, input: DisconnectInput, options: DisconnectOptions = {}): Promise<DisconnectResult> {
  const accountId = scope.accountId;
  const billing = input.cancelBilling ? await cancelBilling(deps, scope) : 'not_requested';
  const hubspot = await releaseHubSpot(deps, accountId, options);
  const local = await deps.db.tx((tx) => disconnectLocallyInTx(tx, deps.clock.now(), accountId));
  await runPostCommitWork(deps, local.work);
  log.info('hubspot disconnected by the owner', {
    event: 'disconnect.done',
    accountId,
    outcome: local.type,
    codes: [`uninstall_${hubspot.uninstall}`, `revoke_${hubspot.revoke}`, `billing_${billing}`],
  });
  return { type: local.type, billing, ...hubspot };
}
