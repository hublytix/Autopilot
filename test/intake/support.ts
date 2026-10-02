import type { FakeHubSpot, FakeWebhookEvent } from '@/server/adapters/fake/hubspot';
import type { Db } from '@/server/db';
import { createJobRegistry, JobOutcomes, type JobRegistry } from '@/server/jobs';
import { runSweeper } from '@/server/jobs/sweeper';
import { createJobTestRig, seedAccount, seedSettings, type JobTestRig } from '@/server/jobs/testing';
import { handleCronPoll } from '@/server/http/cron-poll';
import { handleHubSpotWebhook } from '@/server/http/hubspot-webhook';
import { computeHubSpotSignatureV3 } from '@/server/hubspot/signature';
import type { Sleep } from '@/server/services/hubspot';
import { seedInstalledConnection, seedOwner, seedSelectedForm } from '@/server/services/accounts/testing';
import { createNotificationRegistry } from '@/server/services/notifications';
import { createPortalPollJobHandler } from '@/server/services/intake';
import { privacyDeleteJobHandler } from '@/server/services/privacy';

// Shared set-up for the intake tests: every fake around PGlite, the intake job handlers (and a
// stand-in lead_process handler, which another service owns) in a private registry, and an active
// account installed on the fake portal with "Contact us" and "Request a quote" selected at $now.

export interface IntakeRig extends JobTestRig {
  hubspot: FakeHubSpot;
  registry: JobRegistry;
  /** Advances the FakeClock instead of waiting (portal limiter). */
  sleep: Sleep;
  accountId: string;
  connectionId: string;
  portalId: string;
  contactUs: string;
  quote: string;
}

export async function createIntakeRig(db: Db): Promise<IntakeRig> {
  const registry = createJobRegistry();
  const box: { rig?: JobTestRig } = {};
  const sleep: Sleep = async (ms) => {
    box.rig?.clock.advance(ms);
  };
  registry.register('portal_poll', createPortalPollJobHandler({ sleep }));
  registry.register('privacy_delete', privacyDeleteJobHandler);
  registry.register('lead_process', async () => JobOutcomes.done());
  const rig = createJobTestRig(db, registry);
  box.rig = rig;
  const hubspot = rig.fakes.hubspot;
  const now = rig.clock.now();
  const accountId = await seedAccount(db, { now });
  await seedSettings(db, { accountId, now });
  await seedOwner(db, accountId);
  const { connectionId, portalId } = await seedInstalledConnection(rig.deps, hubspot, { accountId, now });
  const contactUs = hubspot.formIdByName('Contact us');
  const quote = hubspot.formIdByName('Request a quote');
  await seedSelectedForm(db, { accountId, formId: contactUs, floor: now });
  await seedSelectedForm(db, { accountId, formId: quote, floor: now });
  // Submissions count only when strictly newer than the floor.
  rig.clock.advance(MINUTE);
  return { ...rig, hubspot, registry, sleep, accountId, connectionId, portalId, contactUs, quote };
}

export interface WebhookOptions {
  clientSecret?: string | undefined;
  timestampMs?: number | undefined;
}

export function webhookRequest(rig: IntakeRig, events: readonly FakeWebhookEvent[], options: WebhookOptions = {}): Request {
  const signed = rig.hubspot.signedWebhook(events, { uri: rig.deps.env.HUBSPOT_WEBHOOK_TARGET_URL, ...options });
  return new Request(rig.deps.env.HUBSPOT_WEBHOOK_TARGET_URL, { method: 'POST', headers: signed.headers, body: signed.body });
}

/** Any raw body, signed with the client secret as HubSpot would sign it. */
export function signedRawRequest(rig: IntakeRig, body: string): Request {
  const uri = rig.deps.env.HUBSPOT_WEBHOOK_TARGET_URL;
  const timestamp = String(rig.clock.now().getTime());
  const signature = computeHubSpotSignatureV3({ secret: rig.deps.env.HUBSPOT_CLIENT_SECRET, method: 'POST', uri, rawBody: body, timestamp });
  return new Request(uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-HubSpot-Signature-v3': signature, 'X-HubSpot-Request-Timestamp': timestamp },
    body,
  });
}

export async function deliverWebhook(rig: IntakeRig, events: readonly FakeWebhookEvent[], options: WebhookOptions = {}): Promise<Response> {
  return handleHubSpotWebhook(webhookRequest(rig, events, options), rig.deps);
}

export function cronRequest(rig: IntakeRig, secret: string | null = rig.deps.env.CRON_SECRET): Request {
  const headers: Record<string, string> = secret === null ? {} : { Authorization: `Bearer ${secret}` };
  return new Request(`${rig.deps.env.APP_URL}/api/cron/poll`, { method: 'GET', headers });
}

/** One poll-cron run through the route, with the sweeper on the rig's own registry. */
export async function runCron(rig: IntakeRig, options: { budgetMs?: number } = {}): Promise<Record<string, unknown>> {
  const response = await handleCronPoll(cronRequest(rig), rig.deps, {
    sweep: (deps) => runSweeper(deps, { jobRegistry: rig.registry, notificationRegistry: createNotificationRegistry() }),
    sleep: rig.sleep,
    budgetMs: options.budgetMs,
  });
  if (response.status !== 200) throw new Error(`cron answered ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

export interface LeadRow {
  id: string;
  hubspot_contact_id: string | null;
  form_id: string | null;
  submitted_at: Date;
  conversion_id: string | null;
  submission_key: string | null;
  intake_trigger: string;
  processing_state: string;
  stop_reason: string | null;
}

export async function leadsOf(db: Db, accountId: string): Promise<LeadRow[]> {
  return db.query<LeadRow>(
    `select id, hubspot_contact_id, form_id, submitted_at, conversion_id, submission_key, intake_trigger, processing_state, stop_reason
       from leads where account_id = $1 order by submitted_at, id`,
    [accountId],
  );
}

export async function cursorOf(db: Db, accountId: string, formId: string): Promise<Date> {
  const row = await db.one<{ cursor_submitted_at: Date }>(
    `select cursor_submitted_at from selected_forms where account_id = $1 and form_id = $2`,
    [accountId, formId],
  );
  return row.cursor_submitted_at;
}

export async function jobsOf(db: Db, kind: string): Promise<{ id: string; dedupe_key: string; status: string; run_at: Date; lead_id: string | null; payload: Record<string, unknown> }[]> {
  return db.query(`select id, dedupe_key, status, run_at, lead_id, payload from scheduled_jobs where kind = $1 order by run_at, dedupe_key`, [kind]);
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
