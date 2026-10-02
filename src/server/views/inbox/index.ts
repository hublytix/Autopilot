import 'server-only';
import { DateTime } from 'luxon';
import { isLoggingMode, type InboxLegStatus, type LoggingMode } from '@/server/domain/types';
import { canReadEmails } from '@/server/hubspot/scopes';
import type { Deps } from '@/server/ports';
import type { OwnerScope } from '@/server/services/auth/owner-scope';
import { INBOX_CHECK_ABANDON_MS } from '@/server/services/inbox-check/constants';
import { loggingModeFor } from '@/server/services/inbox-check/legs';
import { latestInboxCheck, type InboxCheckRow } from '@/server/services/inbox-check/repository';

// The /onboarding/inbox read model (PLAN §7.5, §9.7, D-14): the account's logging mode, whether the
// test can run, and the newest check with its history counts and legs. Database reads only: the
// HubSpot reads happen when the owner starts the test and in the inbox_check job. Scoped by the
// OwnerScope, so a page can only ever see its own account.

export type InboxHistoryView =
  | { readonly status: 'ok'; readonly outbound: number; readonly inbound: number }
  /** No email scope (D-03 path b). */
  | { readonly status: 'unavailable' }
  /** Not counted (HubSpot did not answer when the test started). */
  | { readonly status: 'unknown' };

/**
 * Where the newest check is:
 * - `needs_contact`: started, but stopped before the test email (no test contact and no BCC
 *   address, or HubSpot did not answer): the owner fixes it and starts again;
 * - `sending`: the test email is waiting to go out (a transient send failure, retried);
 * - `running`: the email went out and the job is checking HubSpot;
 * - `finished`: both legs resolved, the logging mode is set;
 * - `closed_early`: skipped, superseded, abandoned or not checkable (legs skipped).
 */
export type InboxCheckPhase = 'needs_contact' | 'sending' | 'running' | 'finished' | 'closed_early';

export interface InboxLegView {
  readonly status: InboxLegStatus;
  /** "9:13 AM" in the account's zone, while the leg is pending with a deadline. */
  readonly until: string | null;
}

export interface InboxCheckView {
  readonly phase: InboxCheckPhase;
  /** The owner's own other address; null once cleared (24 h). */
  readonly testAddress: string | null;
  readonly history: InboxHistoryView;
  readonly send: InboxLegView;
  readonly reply: InboxLegView;
  /** For `finished`: what the legs showed. */
  readonly result: LoggingMode | null;
}

export interface InboxCheckPageView {
  readonly loggingMode: LoggingMode;
  /** The owner's sign-in address (the test needs another one). */
  readonly ownerEmail: string;
  readonly bccSaved: boolean;
  readonly emailScope: boolean;
  /** Account onboarding or active, connection active: a test can start. */
  readonly canStart: boolean;
  /** Onboarding is complete (a re-run from the dashboard): "Continue" goes back there. */
  readonly onboardingComplete: boolean;
  readonly check: InboxCheckView | null;
}

function formatTime(date: Date, timezone: string | null): string {
  const zoned = DateTime.fromJSDate(date, { zone: timezone ?? 'UTC' });
  return (zoned.isValid ? zoned : DateTime.fromJSDate(date, { zone: 'UTC' })).toFormat('h:mm a');
}

function phaseOf(check: InboxCheckRow, now: Date): InboxCheckPhase {
  if (check.status === 'closed') return loggingModeFor(check.sendLeg, check.replyLeg) === null ? 'closed_early' : 'finished';
  if (check.sendDeadlineAt !== null) return 'running';
  if (check.createdAt.getTime() + INBOX_CHECK_ABANDON_MS <= now.getTime()) return 'closed_early';
  return check.testLeadId === null ? 'needs_contact' : 'sending';
}

function historyOf(check: InboxCheckRow, emailScope: boolean): InboxHistoryView {
  if (!emailScope) return { status: 'unavailable' };
  if (check.historyOutbound30d === null || check.historyInbound30d === null) return { status: 'unknown' };
  return { status: 'ok', outbound: check.historyOutbound30d, inbound: check.historyInbound30d };
}

function legView(status: InboxLegStatus, deadline: Date | null, phase: InboxCheckPhase, timezone: string | null): InboxLegView {
  const until = status === 'pending' && phase === 'running' && deadline !== null ? formatTime(deadline, timezone) : null;
  return { status, until };
}

export async function loadInboxCheckPage(scope: OwnerScope, deps: Pick<Deps, 'db' | 'clock'>): Promise<InboxCheckPageView> {
  const account = await deps.db.one<{
    logging_mode: string;
    processing_state: string;
    onboarding_completed_at: Date | null;
    timezone: string | null;
    owner_email: string;
    connection_status: string | null;
    scopes: string[] | null;
    bcc_address: string | null;
  }>(
    `select a.logging_mode, a.processing_state, a.onboarding_completed_at, a.timezone, u.email as owner_email, c.status as connection_status, c.scopes,
            s.bcc_address
       from accounts a
       join users u on u.account_id = a.id and u.auth_user_id = $2
       left join hubspot_connections c on c.account_id = a.id
       left join settings s on s.account_id = a.id
      where a.id = $1`,
    [scope.accountId, scope.userId],
  );
  const emailScope = canReadEmails(account.scopes ?? []);
  const latest = await latestInboxCheck(deps.db, scope.accountId);
  let check: InboxCheckView | null = null;
  if (latest !== null) {
    const phase = phaseOf(latest, deps.clock.now());
    check = {
      phase,
      testAddress: latest.testAddress,
      history: historyOf(latest, emailScope),
      send: legView(latest.sendLeg, latest.sendDeadlineAt, phase, account.timezone),
      reply: legView(latest.replyLeg, latest.replyDeadlineAt, phase, account.timezone),
      result: phase === 'finished' ? loggingModeFor(latest.sendLeg, latest.replyLeg) : null,
    };
  }
  return {
    loggingMode: isLoggingMode(account.logging_mode) ? account.logging_mode : 'unknown',
    ownerEmail: account.owner_email,
    bccSaved: (account.bcc_address ?? '').trim().length > 0,
    emailScope,
    canStart: ['onboarding', 'active'].includes(account.processing_state) && account.connection_status === 'active',
    onboardingComplete: account.onboarding_completed_at !== null,
    check,
  };
}
