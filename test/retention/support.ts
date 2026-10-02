import { randomBytes, randomUUID } from 'node:crypto';
import type { FakeBilling } from '@/server/adapters/fake/billing';
import type { FakeHubSpot } from '@/server/adapters/fake/hubspot';
import type { Db } from '@/server/db';
import { onAlert, type RaisedAlert } from '@/server/jobs/alert';
import { createJobRegistry, type JobRegistry } from '@/server/jobs';
import { createJobTestRig, seedAccount, seedSettings, type JobTestRig } from '@/server/jobs/testing';
import type { AuthUser } from '@/server/ports';
import { applyProcessingState } from '@/server/services/accounts';
import { seedInstalledConnection, seedOwner } from '@/server/services/accounts/testing';
import { createAccountDailyHandler, runAccountDaily, type AccountDailyResult } from '@/server/services/daily';
import type { Sleep } from '@/server/services/hubspot';
import { completeInstall, startInstall, type InstallOutcome } from '@/server/services/install';

// Shared set-up for the retention and purge tests (PLAN §9.10, §12 "Retention purge"): every fake
// around PGlite, the account_daily handler in a private registry, the alerts raised, and helpers
// that install through the real OAuth callback (branches a-c), seed lead content, and read back what
// is left of it.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const OWNER_EMAIL = 'owner@brightside-plumbing.example';

export interface RetentionRig extends JobTestRig {
  readonly hubspot: FakeHubSpot;
  readonly billing: FakeBilling;
  readonly registry: JobRegistry;
  /** Advances the FakeClock instead of waiting (portal limiter). */
  readonly sleep: Sleep;
  readonly alerts: RaisedAlert[];
  /** Stops collecting alerts (call in afterEach). */
  readonly stop: () => void;
}

export function createRetentionRig(db: Db, options: { start?: Date | undefined } = {}): RetentionRig {
  const registry = createJobRegistry();
  const box: { rig?: JobTestRig } = {};
  const sleep: Sleep = async (ms) => {
    box.rig?.clock.advance(ms);
  };
  registry.register('account_daily', createAccountDailyHandler({ sleep }));
  const rig = createJobTestRig(db, registry, { start: options.start });
  box.rig = rig;
  const alerts: RaisedAlert[] = [];
  const stop = onAlert((alert) => alerts.push(alert));
  return { ...rig, hubspot: rig.fakes.hubspot, billing: rig.fakes.billing, registry, sleep, alerts, stop };
}

export function alertCodes(rig: RetentionRig): string[] {
  return rig.alerts.map((alert) => alert.code);
}

/** One account_daily run, as the job runs it (with the rig's limiter sleep). */
export function runDaily(rig: RetentionRig, accountId: string): Promise<AccountDailyResult> {
  return runAccountDaily(rig.deps, accountId, { sleep: rig.sleep });
}

export interface InstalledAccount {
  readonly accountId: string;
  readonly connectionId: string;
  readonly portalId: string;
  /** The bound owner's auth user. */
  readonly ownerUserId: string;
}

/** An active, onboarded account on the fake portal with real encrypted tokens and a bound owner (a fake auth user). */
export async function seedInstalledAccount(rig: RetentionRig, email = OWNER_EMAIL): Promise<InstalledAccount> {
  const db = rig.deps.db;
  const now = rig.clock.now();
  const accountId = await seedAccount(db, { now });
  await seedSettings(db, { accountId, now });
  const { userId } = await rig.fakes.auth.createUser(email);
  await seedOwner(db, accountId, email, userId);
  const { connectionId, portalId } = await seedInstalledConnection(rig.deps, rig.hubspot, { accountId, now });
  return { accountId, connectionId, portalId, ownerUserId: userId };
}

/** An install through the real OAuth callback (the branch follows from the portal's state and the session). */
export async function installViaOAuth(rig: RetentionRig, sessionUser: AuthUser | null = null): Promise<InstallOutcome> {
  const started = await startInstall(rig.deps, { ip: '203.0.113.9' });
  if (started.type !== 'redirect') throw new Error('install rate limited');
  const state = new URL(started.location).searchParams.get('state');
  const cookie = started.cookies[0];
  if (state === null || cookie === undefined) throw new Error('install state missing');
  const code = rig.hubspot.createAuthCode({ redirectUri: rig.deps.env.HUBSPOT_REDIRECT_URI });
  return completeInstall(rig.deps, { code, state, error: null, stateCookie: cookie.value, ip: '203.0.113.9', sessionUser: async () => sessionUser });
}

/** Branch (a) for the fake portal: the new, unbound account's id. */
export async function installNewPortal(rig: RetentionRig): Promise<string> {
  const outcome = await installViaOAuth(rig);
  if (outcome.type !== 'onboarding' || outcome.branch !== 'new_portal') throw new Error(`unexpected install outcome ${outcome.type}`);
  return outcome.accountId;
}

/** Binds an owner (a fake auth user) and completes onboarding, so the account turns active. */
export async function bindAndActivate(rig: RetentionRig, accountId: string, email = OWNER_EMAIL): Promise<string> {
  const db = rig.deps.db;
  const { userId } = await rig.fakes.auth.createUser(email);
  await seedOwner(db, accountId, email, userId);
  await db.query(`update settings set notify_emails = $2, notify_emails_verified = $2, preferences_saved_at = $3 where account_id = $1`, [
    accountId,
    [email],
    rig.clock.now(),
  ]);
  await db.query(`update accounts set onboarding_completed_at = $2 where id = $1`, [accountId, rig.clock.now()]);
  await applyProcessingState(rig.deps, accountId);
  return userId;
}

export interface SeedContentInput {
  readonly accountId: string;
  readonly submittedAt: Date;
  readonly isTest?: boolean | undefined;
  readonly contactId?: string | undefined;
}

export interface SeededContent {
  readonly leadId: string;
  readonly purgeAt: Date;
}

let contactCounter = 700000;

/** A notified lead with everything intake and drafting store: the message row, two drafts, a send token. */
export async function seedLeadContent(db: Db, input: SeedContentInput): Promise<SeededContent> {
  const isTest = input.isTest ?? false;
  const purgeAt = new Date(input.submittedAt.getTime() + (isTest ? DAY : 30 * DAY));
  const lead = await db.one<{ id: string }>(
    `insert into leads (account_id, hubspot_contact_id, form_id, submitted_at, submission_key, intake_trigger, is_test, received_at,
                        classification, processing_state, first_notified_at, stop_reason)
     values ($1, $2, $3, $4, $5, $6, $7, $4, 'lead', 'notified', $4, $8) returning id`,
    [
      input.accountId,
      isTest ? null : (input.contactId ?? String((contactCounter += 1))),
      isTest ? null : 'form-1',
      input.submittedAt,
      isTest ? null : randomBytes(32).toString('hex'),
      isTest ? 'inbox_check' : 'webhook',
      isTest,
      isTest ? 'test_lead' : null,
    ],
  );
  await db.query(
    `insert into lead_messages (lead_id, account_id, message, first_name, last_name, company, email, purge_at)
     values ($1, $2, 'Our kitchen tap drips; can you come Tuesday?', 'Maya', 'Okafor', 'Okafor Bakery', 'maya@okafor-bakery.example', $3)`,
    [lead.id, input.accountId, purgeAt],
  );
  const drafts = await db.query<{ id: string }>(
    `insert into drafts (lead_id, account_id, kind, subject, body, flags, validation_ok, purge_at)
     values ($1, $2, 'initial', 'Re: your tap', 'Hi Maya, Tuesday works.', '{urgent}', true, $3),
            ($1, $2, 'fu1', 'Following up', 'Hi Maya, still keen?', '{}', true, $3)
     returning id`,
    [lead.id, input.accountId, purgeAt],
  );
  await db.query(
    `insert into action_tokens (token_hash, account_id, lead_id, draft_id, notification_key, purpose, expires_at)
     values ($1, $2, $3, $4, $5, 'send', $6)`,
    [randomBytes(32).toString('hex'), input.accountId, lead.id, drafts[0]?.id ?? null, `notify:${lead.id}:initial:r0`, new Date(input.submittedAt.getTime() + 7 * DAY)],
  );
  return { leadId: lead.id, purgeAt };
}

export interface LeadContent {
  /** The lead_messages row is still there. */
  readonly message: boolean;
  readonly submissionKey: string | null;
  readonly drafts: readonly { subject: string | null; body: string | null; flags: string[]; purged: boolean }[];
}

export async function contentOf(db: Db, leadId: string): Promise<LeadContent> {
  const message = await db.maybeOne(`select 1 as present from lead_messages where lead_id = $1`, [leadId]);
  const lead = await db.maybeOne<{ submission_key: string | null }>(`select submission_key from leads where id = $1`, [leadId]);
  const drafts = await db.query<{ subject: string | null; body: string | null; flags: string[]; purged_at: Date | null }>(
    `select subject, body, flags, purged_at from drafts where lead_id = $1 order by kind`,
    [leadId],
  );
  return {
    message: message !== null,
    submissionKey: lead?.submission_key ?? null,
    drafts: drafts.map((d) => ({ subject: d.subject, body: d.body, flags: d.flags, purged: d.purged_at !== null })),
  };
}

/** Every content column null, emptied or deleted (PLAN §9.10 step 8). */
export const CONTENT_GONE: LeadContent = {
  message: false,
  submissionKey: null,
  drafts: [
    { subject: null, body: null, flags: [], purged: true },
    { subject: null, body: null, flags: [], purged: true },
  ],
};

/** Rows left for the account in every account-scoped table (0 everywhere after a purge). */
export async function accountRowCounts(db: Db, accountId: string): Promise<Record<string, number>> {
  const tables = [
    'accounts:id',
    'users:account_id',
    'settings:account_id',
    'hubspot_connections:account_id',
    'leads:account_id',
    'lead_messages:account_id',
    'drafts:account_id',
    'action_tokens:account_id',
    'scheduled_jobs:account_id',
    'notifications_sent:account_id',
    'subscriptions:account_id',
    'login_intents:account_id',
    'audit_log:account_id',
  ];
  const counts: Record<string, number> = {};
  for (const entry of tables) {
    const [table, column] = entry.split(':') as [string, string];
    const row = await db.one<{ n: number }>(`select count(*)::int as n from ${table} where ${column} = $1`, [accountId]);
    counts[table] = row.n;
  }
  return counts;
}

/** A Razorpay subscription in the fake, driven to `status`, and its local row. Returns the provider id. */
export async function seedSubscription(
  rig: RetentionRig,
  accountId: string,
  status: 'created' | 'authenticated' | 'active' | 'pending' | 'halted' | 'paused' | 'cancelled',
): Promise<string> {
  const now = rig.clock.now();
  const futureStart = status === 'authenticated';
  const sub = await rig.billing.createSubscription({
    planId: rig.deps.env.RAZORPAY_PLAN_ID,
    totalCount: 120,
    quantity: 1,
    customerNotify: true,
    startAt: futureStart ? new Date(now.getTime() + 60 * DAY) : undefined,
    expireBy: new Date(now.getTime() + 7 * DAY),
    notes: { autopilot_account_id: accountId },
  });
  if (status !== 'created') rig.billing.authenticate(sub.id);
  if (status === 'pending' || status === 'halted') rig.billing.failPayment(sub.id);
  if (status === 'halted') rig.billing.halt(sub.id);
  if (status === 'paused') rig.billing.pause(sub.id);
  if (status === 'cancelled') await rig.billing.cancelSubscription(sub.id, false);
  rig.billing.takeWebhooks();
  await rig.deps.db.query(
    `insert into subscriptions (account_id, provider_subscription_id, plan_id, status, status_changed_at, short_url, start_at, expire_by, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $5)`,
    [accountId, sub.id, rig.deps.env.RAZORPAY_PLAN_ID, status, now, sub.shortUrl, sub.startAt ?? null, sub.expireBy ?? null],
  );
  return sub.id;
}

/** Sets the account up to be purged: revoked 30 days ago (purge_after in the past), via the real revoke path. */
export async function revokeNow(rig: RetentionRig, accountId: string): Promise<void> {
  rig.hubspot.revokeToken();
  const result = await runDaily(rig, accountId);
  if (result.introspect !== 'revoked') throw new Error(`expected the probe to revoke, got ${String(result.introspect)}`);
}

export function uuid(): string {
  return randomUUID();
}
