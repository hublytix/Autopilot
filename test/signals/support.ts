import type { FakeHubSpot } from '@/server/adapters/fake/hubspot';
import type { Db } from '@/server/db';
import { insertJob, publishJobs } from '@/server/jobs/outbox';
import { seedAccount, seedSettings } from '@/server/jobs/testing';
import { seedInstalledConnection, seedOwner } from '@/server/services/accounts/testing';
import { followUpDedupeKey } from '@/server/services/followups/schedule';
import type { Sleep } from '@/server/services/hubspot';
import { applySignals, type ApplySignalsOptions, type ApplySignalsResult } from '@/server/services/signals';
import { createLeadsRig, LEAD_EMAIL, LEAD_MESSAGE, OWNER_EMAIL, ZONE, type LeadsRig } from '../leads/support';

// Shared set-up for the signal tests (PGlite + every fake): the leads rig (its registries hold the
// lead email resumers, reply_detected included), an active account installed on the fake HubSpot
// portal (real encrypted tokens, the fixture's scopes), a bound owner, and a notified lead whose
// contact exists in the fake portal, with its two follow-up jobs scheduled and published.

export { LEAD_EMAIL, OWNER_EMAIL };
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export interface SignalsRig extends LeadsRig {
  readonly hubspot: FakeHubSpot;
  readonly sleep: Sleep;
  readonly accountId: string;
  readonly connectionId: string;
  readonly portalId: string;
}

export interface SignalsRigOptions {
  /** Scopes the fake portal grants before the connection is stored. */
  readonly grantedScopes?: readonly string[] | undefined;
}

export async function createSignalsRig(db: Db, options: SignalsRigOptions = {}): Promise<SignalsRig> {
  const rig = createLeadsRig(db);
  const sleep: Sleep = async (ms) => {
    rig.clock.advance(ms);
  };
  const hubspot = rig.fakes.hubspot;
  const now = rig.clock.now();
  const accountId = await seedAccount(db, { now, timezone: ZONE });
  await seedSettings(db, { accountId, now });
  await seedOwner(db, accountId, OWNER_EMAIL);
  if (options.grantedScopes !== undefined) hubspot.setGrantedScopes(options.grantedScopes);
  const { connectionId, portalId } = await seedInstalledConnection(rig.deps, hubspot, { accountId, now });
  await db.query(`update hubspot_connections set ui_domain = 'app.hubspot.com' where account_id = $1`, [accountId]);
  await db.query(`update accounts set logging_mode = 'log_all' where id = $1`, [accountId]);
  return { ...rig, hubspot, sleep, accountId, connectionId, portalId };
}

export interface SeedNotifiedLeadInput {
  /** An existing contact; default: a new one for `email`. */
  readonly contactId?: string | undefined;
  readonly email?: string | undefined;
  readonly firstName?: string | undefined;
  /** T0; default: the rig's clock now. */
  readonly firstNotifiedAt?: Date | undefined;
  readonly submittedAt?: Date | undefined;
  /** Default true: both follow-up jobs scheduled and published. */
  readonly followUps?: boolean | undefined;
  readonly isTest?: boolean | undefined;
  /** Default true: lead_messages as intake stores it. */
  readonly content?: boolean | undefined;
}

export interface NotifiedLead {
  readonly leadId: string;
  readonly contactId: string;
  readonly jobIds: readonly string[];
}

/** A lead whose owner email went out at T0: `notified`, its contact in the portal, its follow-ups scheduled. */
export async function seedNotifiedLead(rig: SignalsRig, input: SeedNotifiedLeadInput = {}): Promise<NotifiedLead> {
  const db = rig.deps.db;
  const now = rig.clock.now();
  const t0 = input.firstNotifiedAt ?? now;
  const submittedAt = input.submittedAt ?? new Date(t0.getTime() - 5 * MINUTE);
  const email = input.email ?? LEAD_EMAIL;
  const contactId =
    input.contactId ?? rig.hubspot.createContact({ email, firstName: input.firstName ?? 'Maya', lastName: 'Okafor', at: submittedAt });
  const isTest = input.isTest ?? false;
  const lead = await db.one<{ id: string }>(
    `insert into leads (account_id, hubspot_contact_id, form_id, submitted_at, intake_trigger, is_test, received_at,
                        classification, classified_at, processing_state, first_notified_at, stop_reason)
     values ($1, $2, $3, $4, $5, $6, $4, 'lead', $4, 'notified', $7, $8) returning id`,
    [rig.accountId, contactId, isTest ? null : 'form-1', submittedAt, isTest ? 'inbox_check' : 'webhook', isTest, t0, isTest ? 'test_lead' : null],
  );
  if (input.content ?? true) {
    await db.query(
      `insert into lead_messages (lead_id, account_id, message, first_name, last_name, company, email, purge_at)
       values ($1, $2, $3, $4, 'Okafor', 'Okafor Bakery', $5, $6)`,
      [lead.id, rig.accountId, LEAD_MESSAGE, input.firstName ?? 'Maya', email, new Date(submittedAt.getTime() + 30 * DAY)],
    );
  }
  const jobIds: string[] = [];
  if ((input.followUps ?? true) && !isTest) {
    const rows = await db.tx(async (tx) =>
      Promise.all(
        ([1, 2] as const).map((n) =>
          insertJob(tx, {
            kind: 'followup',
            accountId: rig.accountId,
            leadId: lead.id,
            dedupeKey: followUpDedupeKey(lead.id, n, 0),
            payload: { leadId: lead.id, n, followupStream: 0 },
            runAt: new Date(t0.getTime() + (n === 1 ? 2 : 5) * DAY),
            now,
            seq: n,
          }),
        ),
      ),
    );
    await publishJobs(rig.deps, rows);
    for (const row of rows) if (row !== null) jobIds.push(row.id);
  }
  return { leadId: lead.id, contactId, jobIds };
}

/** applySignals as a follow-up job (or a refresh) runs it, with the rig's limiter sleep and registry. */
export function apply(
  rig: SignalsRig,
  leadId: string,
  options: Partial<ApplySignalsOptions> & Pick<ApplySignalsOptions, 'caller'>,
): Promise<ApplySignalsResult> {
  return applySignals(rig.deps, leadId, { sleep: rig.sleep, notifications: rig.notifications, ...options });
}

export interface SignalLeadRow {
  hubspot_contact_id: string | null;
  send_confirmed_at: Date | null;
  replied_at: Date | null;
  stop_reason: string | null;
  signals_checked_at: Date | null;
  followup_stream: number;
}

export async function signalRow(db: Db, leadId: string): Promise<SignalLeadRow> {
  return db.one<SignalLeadRow>(
    `select hubspot_contact_id, send_confirmed_at, replied_at, stop_reason, signals_checked_at, followup_stream from leads where id = $1`,
    [leadId],
  );
}

export async function jobStatuses(db: Db, leadId: string): Promise<{ seq: number; status: string; cancel_reason: string | null; external_id: string | null }[]> {
  return db.query(`select seq, status, cancel_reason, external_id from scheduled_jobs where lead_id = $1 and kind = 'followup' order by seq`, [leadId]);
}

export async function replyReservations(db: Db, leadId: string): Promise<{ dedupe_key: string; kind: string; status: string }[]> {
  return db.query(`select dedupe_key, kind, status from notifications_sent where lead_id = $1 and kind = 'reply_detected' order by id`, [leadId]);
}

export function at(base: Date, ms: number): Date {
  return new Date(base.getTime() + ms);
}
