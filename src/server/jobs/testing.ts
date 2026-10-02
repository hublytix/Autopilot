import 'server-only';
import { randomUUID } from 'node:crypto';
import { createFakeDeps, type FakeAdapters } from '@/server/adapters/fake';
import { FakeClock } from '@/server/adapters/fake/clock';
import type { FakeMailSink } from '@/server/adapters/fake/mailer';
import type { AccountProcessingState, ConnectionStatus, StopReason } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { parseEnv, type EnvSource } from '@/server/env';
import type { Deps } from '@/server/ports';
import { createSchedulerBridge } from './bridge';
import type { JobRegistry } from './registry';

// Test support for the job system and the notification service (Vitest only; nothing in the app
// imports this). A rig wires every fake around a PGlite database, with the FakeScheduler delivering
// through the same bridge fake mode uses, and seeds build the minimum rows the predicates read.

export const TEST_START = new Date('2026-10-06T14:00:00.000Z');

export interface JobTestRig {
  deps: Deps;
  fakes: FakeAdapters;
  clock: FakeClock;
}

export interface JobTestRigOptions {
  start?: Date | undefined;
  env?: EnvSource | undefined;
  mailSink?: FakeMailSink | undefined;
}

export function createJobTestRig(db: Db, registry: JobRegistry, options: JobTestRigOptions = {}): JobTestRig {
  const clock = new FakeClock(options.start ?? TEST_START);
  const env = parseEnv({ APP_MODE: 'fake', ...options.env });
  const box: { deps?: Deps | undefined } = {};
  const bridge = createSchedulerBridge(() => {
    if (box.deps === undefined) throw new Error('job_test_rig_not_ready');
    return box.deps;
  }, registry);
  const built = createFakeDeps({
    env,
    db,
    clock,
    mailSink: options.mailSink ?? { kind: 'memory' },
    dispatch: (delivery) => bridge.dispatch(delivery),
    onJobFailure: (failure) => bridge.onFailure(failure),
  });
  box.deps = built.deps;
  return { deps: built.deps, fakes: built.fakes, clock };
}

// A token ciphertext in the D-51 shape (the schema refuses plaintext); never decrypted in these tests.
const FAKE_CIPHERTEXT = 'v1.0123abcd.aaaa.bbbb.cccc';

export interface SeedAccountInput {
  now: Date;
  processingState?: AccountProcessingState | undefined;
  timezone?: string | undefined;
}

export async function seedAccount(db: Db, input: SeedAccountInput): Promise<string> {
  const trialEnds = new Date(input.now.getTime() + 14 * 86_400_000);
  const row = await db.one<{ id: string }>(
    `insert into accounts (hubspot_portal_id, processing_state, processing_state_changed_at, trial_started_at, trial_ends_at,
                           last_install_at, created_at, timezone, onboarding_completed_at)
     values ($1, $2, $3, $3, $4, $3, $3, $5, case when $2 = 'onboarding' then null else $3::timestamptz end)
     returning id`,
    [randomUUID(), input.processingState ?? 'active', input.now, trialEnds, input.timezone ?? 'America/New_York'],
  );
  return row.id;
}

export interface SeedConnectionInput {
  accountId: string;
  now: Date;
  status?: ConnectionStatus | undefined;
  statusChangedAt?: Date | undefined;
}

export async function seedConnection(db: Db, input: SeedConnectionInput): Promise<string> {
  const active = (input.status ?? 'active') === 'active';
  const row = await db.one<{ id: string }>(
    `insert into hubspot_connections (account_id, portal_id, status, status_changed_at, access_token_enc, refresh_token_enc)
     values ($1, $2, $3, $4, $5, $5) returning id`,
    [input.accountId, randomUUID(), input.status ?? 'active', input.statusChangedAt ?? input.now, active ? FAKE_CIPHERTEXT : null],
  );
  return row.id;
}

export async function seedSettings(db: Db, input: { accountId: string; now: Date; followupsEnabled?: boolean | undefined }): Promise<void> {
  await db.query(
    `insert into settings (account_id, notify_emails, notify_emails_verified, followups_enabled, preferences_saved_at)
     values ($1, $2, $2, $3, $4)`,
    [input.accountId, ['owner@example.com'], input.followupsEnabled ?? true, input.now],
  );
}

export interface SeedLeadInput {
  accountId: string;
  now: Date;
  isTest?: boolean | undefined;
  contactId?: string | undefined;
  submittedAt?: Date | undefined;
  dismissedAt?: Date | undefined;
  repliedAt?: Date | undefined;
  firstNotifiedAt?: Date | undefined;
  stopReason?: StopReason | undefined;
}

export async function seedLead(db: Db, input: SeedLeadInput): Promise<string> {
  const isTest = input.isTest ?? false;
  const row = await db.one<{ id: string }>(
    `insert into leads (account_id, hubspot_contact_id, form_id, submitted_at, intake_trigger, is_test, received_at,
                        dismissed_at, replied_at, first_notified_at, stop_reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
    [
      input.accountId,
      isTest ? null : (input.contactId ?? randomUUID()),
      isTest ? null : 'form-1',
      input.submittedAt ?? input.now,
      isTest ? 'inbox_check' : 'webhook',
      isTest,
      input.now,
      input.dismissedAt ?? null,
      input.repliedAt ?? null,
      input.firstNotifiedAt ?? null,
      input.stopReason ?? null,
    ],
  );
  return row.id;
}

/** An active account with an active connection and saved settings. */
export async function seedActiveAccount(db: Db, now: Date): Promise<{ accountId: string; connectionId: string }> {
  const accountId = await seedAccount(db, { now });
  const connectionId = await seedConnection(db, { accountId, now });
  await seedSettings(db, { accountId, now });
  return { accountId, connectionId };
}
