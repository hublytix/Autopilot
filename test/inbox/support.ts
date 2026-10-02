import type { FakeHubSpot } from '@/server/adapters/fake/hubspot';
import type { Db } from '@/server/db';
import { createJobRegistry, type JobRegistry } from '@/server/jobs';
import { createJobTestRig, seedAccount, seedSettings, type JobTestRig } from '@/server/jobs/testing';
import type { AccountProcessingState } from '@/server/domain/types';
import { seedInstalledConnection, seedOwner } from '@/server/services/accounts/testing';
import { createOwnerScopeForTest, type OwnerScope } from '@/server/services/auth';
import type { Sleep } from '@/server/services/hubspot';
import { createInboxCheckJobHandler, inboxCheckFailurePath, resumeInboxTest, startInboxCheck, type StartInboxCheckResult } from '@/server/services/inbox-check';
import { createNotificationRegistry, type NotificationRegistry } from '@/server/services/notifications';

// Shared set-up for the inbox-check tests: every fake around PGlite, the inbox_check handler and
// failure path in a private job registry (delivered through the FakeScheduler like fake mode), the
// inbox_test resumer in a private notification registry, and an account installed on the fake
// portal with a bound owner (the fixture's installer, whose mailbox logs everything by default).

export const OWNER_EMAIL = 'owner@brightside-plumbing.example';
export const TEST_ADDRESS = 'owner.personal@example.net';
export const BCC_ADDRESS = '1234567@bcc.hubspot.com';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export interface InboxRig extends JobTestRig {
  hubspot: FakeHubSpot;
  registry: JobRegistry;
  notifications: NotificationRegistry;
  sleep: Sleep;
  accountId: string;
  connectionId: string;
  scope: OwnerScope;
}

export interface InboxRigOptions {
  processingState?: AccountProcessingState | undefined;
  /** Default true: a BCC address is saved (the owner's send then creates the test contact). */
  bcc?: boolean | undefined;
  /** Scopes the fake portal grants before the connection is stored. */
  grantedScopes?: readonly string[] | undefined;
}

export async function createInboxRig(db: Db, options: InboxRigOptions = {}): Promise<InboxRig> {
  const registry = createJobRegistry();
  const notifications = createNotificationRegistry();
  const box: { rig?: JobTestRig } = {};
  const sleep: Sleep = async (ms) => {
    box.rig?.clock.advance(ms);
  };
  registry.register('inbox_check', createInboxCheckJobHandler({ sleep }));
  registry.registerFailurePath('inbox_check', inboxCheckFailurePath);
  notifications.register('inbox_test', resumeInboxTest);
  const rig = createJobTestRig(db, registry);
  box.rig = rig;
  const hubspot = rig.fakes.hubspot;
  const now = rig.clock.now();
  const accountId = await seedAccount(db, { now, processingState: options.processingState ?? 'onboarding' });
  await seedSettings(db, { accountId, now });
  if (options.bcc ?? true) await db.query(`update settings set bcc_address = $2 where account_id = $1`, [accountId, BCC_ADDRESS]);
  const userId = await seedOwner(db, accountId, OWNER_EMAIL);
  if (options.grantedScopes !== undefined) hubspot.setGrantedScopes(options.grantedScopes);
  const { connectionId } = await seedInstalledConnection(rig.deps, hubspot, { accountId, now });
  return { ...rig, hubspot, registry, notifications, sleep, accountId, connectionId, scope: createOwnerScopeForTest(accountId, userId) };
}

export async function start(rig: InboxRig, address: string = TEST_ADDRESS): Promise<StartInboxCheckResult> {
  return startInboxCheck(rig.scope, rig.deps, { testAddress: address }, { sleep: rig.sleep });
}

/** Delivers every job due up to `until`, moving the clock to each delivery (QStash's timing), then to `until`. */
export async function runUntil(rig: InboxRig, until: Date): Promise<void> {
  for (let guard = 0; guard < 500; guard++) {
    const next = rig.fakes.scheduler.nextRunAt();
    if (next === null || next.getTime() > until.getTime()) break;
    if (next.getTime() > rig.clock.now().getTime()) rig.clock.set(next);
    await rig.fakes.scheduler.runDue(rig.clock.now());
  }
  if (until.getTime() > rig.clock.now().getTime()) rig.clock.set(until);
}

export function at(base: Date, ms: number): Date {
  return new Date(base.getTime() + ms);
}

export interface CheckRow {
  id: string;
  status: string;
  send_leg: string;
  reply_leg: string;
  test_address: string | null;
  test_address_hmac: string;
  test_lead_id: string | null;
  history_outbound_30d: number | null;
  history_inbound_30d: number | null;
  send_deadline_at: Date | null;
  reply_deadline_at: Date | null;
  created_at: Date;
  closed_at: Date | null;
}

export async function checkOf(db: Db, checkId: string): Promise<CheckRow> {
  return db.one<CheckRow>(
    `select id, status, send_leg, reply_leg, test_address, test_address_hmac, test_lead_id, history_outbound_30d, history_inbound_30d,
            send_deadline_at, reply_deadline_at, created_at, closed_at
       from inbox_checks where id = $1`,
    [checkId],
  );
}

export async function loggingModeOf(db: Db, accountId: string): Promise<string> {
  return (await db.one<{ logging_mode: string }>(`select logging_mode from accounts where id = $1`, [accountId])).logging_mode;
}

export async function inboxJobs(db: Db): Promise<{ dedupe_key: string; status: string; seq: number; run_at: Date }[]> {
  return db.query(`select dedupe_key, status, seq, run_at from scheduled_jobs where kind = 'inbox_check' order by seq`);
}

export function checkIdOf(result: StartInboxCheckResult): string {
  if (!('checkId' in result) || result.checkId === undefined) throw new Error(`no check id: ${result.type}`);
  return result.checkId;
}
