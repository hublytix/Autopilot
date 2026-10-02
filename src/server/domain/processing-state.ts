import 'server-only';
import { entitled, type EntitlementAccount, type SubscriptionSnapshot } from './entitlement';
import type { AccountProcessingState, ConnectionStatus } from './types';

// The account's derived `processing_state` (PLAN §6.1, D-42, D-48). Pure: the first rule that
// matches wins.
//
//   1. disconnected  the connection is disconnected (or there is none)
//   2. revoked       the connection is revoked
//   3. onboarding    onboarding_completed_at is null
//   4. paused        paused_at is set (the owner's intent survives revoke, reconnect and billing)
//   5. inactive      the account is not entitled (D-18)
//   6. active
//
// applyProcessingState (services/accounts) loads the inputs, calls this and applies the result with
// a compare-and-set, running the transition's side effects for the winner only.

export interface ProcessingStateAccount extends EntitlementAccount {
  readonly pausedAt: Date | null;
  readonly onboardingCompletedAt: Date | null;
}

export interface ProcessingStateConnection {
  readonly status: ConnectionStatus;
}

/**
 * `connection` null means the account has no connection row: treated as disconnected, since nothing
 * can be processed without one (every install creates it, so this is defensive).
 */
export function computeProcessingState(
  account: ProcessingStateAccount,
  connection: ProcessingStateConnection | null,
  currentSubscription: SubscriptionSnapshot | null,
  now: Date,
): AccountProcessingState {
  if (connection === null || connection.status === 'disconnected') return 'disconnected';
  if (connection.status === 'revoked') return 'revoked';
  if (account.onboardingCompletedAt === null) return 'onboarding';
  if (account.pausedAt !== null) return 'paused';
  if (!entitled(account, currentSubscription, now)) return 'inactive';
  return 'active';
}
