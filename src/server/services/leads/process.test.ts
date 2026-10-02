import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/server/db';
import type { Classification, LeadProcessingState } from '@/server/domain/types';
import { onAlert, type RaisedAlert } from '@/server/jobs/alert';
import { runJob } from '@/server/jobs/dispatcher';
import { handleFailureCallback } from '@/server/jobs/failure';
import { insertJob, publishJobs } from '@/server/jobs/outbox';
import { createJobRegistry, type JobRegistry } from '@/server/jobs/registry';
import { getJob } from '@/server/jobs/rows';
import { createJobTestRig, seedActiveAccount, type JobTestRig } from '@/server/jobs/testing';
import { JobLeaseLostError, type JobContext, type JobRow } from '@/server/jobs/types';
import { createNotificationRegistry } from '@/server/services/notifications/renderers';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import { jobProcessRev, leadProcessDedupeKey, leadProcessHandler, registerLeadProcessJob } from './process';

const getDb = setUpTestDb();

const FORM_ID = 'b1f0c6a2-3d4e-4f50-8a61-7b2c9d0e1f01';

let registry: JobRegistry;
let rig: JobTestRig;
let accountId: string;
let alerts: RaisedAlert[];
let stopAlerts: () => void;

beforeEach(async () => {
  registry = createJobRegistry();
  registerLeadProcessJob({ jobs: registry, notifications: createNotificationRegistry() });
  rig = createJobTestRig(getDb(), registry);
  ({ accountId } = await seedActiveAccount(getDb(), rig.clock.now()));
  await getDb().query(
    `insert into selected_forms (account_id, form_id, form_name, form_type, intake_floor_at, cursor_submitted_at)
     values ($1, $2, 'Contact us', 'hubspot', $3, $3)`,
    [accountId, FORM_ID, rig.clock.now()],
  );
  alerts = [];
  stopAlerts = onAlert((alert) => alerts.push(alert));
});

afterEach(() => {
  stopAlerts();
});

interface LeadSeed {
  message?: string | null | undefined;
  withContent?: boolean | undefined;
  processRev?: number | undefined;
  classification?: Classification | null | undefined;
  classificationOverride?: Classification | null | undefined;
  processingState?: LeadProcessingState | undefined;
  dismissed?: boolean | undefined;
  privacyDeleted?: boolean | undefined;
  isTest?: boolean | undefined;
}

async function seedLead(db: Db, seed: LeadSeed = {}): Promise<string> {
  const now = rig.clock.now();
  const isTest = seed.isTest ?? false;
  const lead = await db.one<{ id: string }>(
    `insert into leads (account_id, hubspot_contact_id, form_id, submitted_at, intake_trigger, is_test, received_at,
                        classification, classification_override, processing_state, process_rev, dismissed_at, stop_reason, classified_at)
     values ($1, $2, $3, $4, $5, $6, $4, $7, $8, $9, $10, $11, $12, case when $7::text is null then null else $4::timestamptz end)
     returning id`,
    [
      accountId,
      randomUUID(),
      FORM_ID,
      now,
      isTest ? 'inbox_check' : 'webhook',
      isTest,
      seed.classification ?? null,
      seed.classificationOverride ?? null,
      seed.processingState ?? 'new',
      seed.processRev ?? 0,
      seed.dismissed === true ? now : null,
      seed.privacyDeleted === true ? 'privacy_deletion' : null,
    ],
  );
  if ((seed.withContent ?? true) && seed.privacyDeleted !== true) {
    await db.query(
      `insert into lead_messages (lead_id, account_id, message, first_name, last_name, company, email, purge_at)
       values ($1, $2, $3, 'Maya', 'Okafor', 'Okafor Bakery', 'maya@okafor-bakery.example', $4)`,
      [lead.id, accountId, seed.message === undefined ? 'Our water heater is leaking. Could you come this week?' : seed.message, new Date(now.getTime() + 30 * 86_400_000)],
    );
  }
  return lead.id;
}

async function scheduleProcessJob(db: Db, leadId: string, rev = 0): Promise<JobRow> {
  const now = rig.clock.now();
  const job = await db.tx((tx) => insertJob(tx, { kind: 'lead_process', accountId, leadId, dedupeKey: leadProcessDedupeKey(leadId, rev), runAt: now, now }));
  if (job === null) throw new Error('job not inserted');
  await publishJobs(rig.deps, [job]);
  const published = await getJob(db, job.id);
  if (published === null) throw new Error('job vanished');
  return published;
}

async function run(job: JobRow): Promise<Awaited<ReturnType<typeof runJob>>> {
  return runJob(rig.deps, { jobId: job.id, messageId: job.externalId, retried: 0 }, registry);
}

interface LeadState {
  processing_state: LeadProcessingState;
  classification: Classification | null;
  classified_at: Date | null;
  process_rev: number;
}

async function leadState(db: Db, leadId: string): Promise<LeadState> {
  return db.one<LeadState>('select processing_state, classification, classified_at, process_rev from leads where id = $1', [leadId]);
}

async function aiCallCount(db: Db): Promise<number> {
  const row = await db.one<{ n: string }>(`select count(*) as n from ai_calls where purpose = 'classify'`);
  return Number(row.n);
}

/** A context for calling the handler directly, as a redelivery after a crash would. */
function directContext(job: JobRow, assertOwned: JobContext['assertOwned'] = async () => undefined): JobContext {
  return { attemptId: randomUUID(), messageId: null, retried: 0, isFinalDelivery: false, claimedAt: rig.clock.now(), assertOwned };
}

describe('lead_process: classification', () => {
  it('stores a genuine enquiry as lead with classified_at, then drafts and notifies it, and the job ends done', async () => {
    const db = getDb();
    const leadId = await seedLead(db);
    const job = await scheduleProcessJob(db, leadId);

    expect(await run(job)).toEqual({ status: 200, outcome: 'done' });

    expect(await leadState(db, leadId)).toEqual({ processing_state: 'notified', classification: 'lead', classified_at: rig.clock.now(), process_rev: 0 });
    expect((await getJob(db, job.id))?.status).toBe('done');
    expect(await aiCallCount(db)).toBe(1);
  });

  it('sends the message, form name, first name and company to the classifier', async () => {
    const db = getDb();
    const leadId = await seedLead(db, { message: 'Can you quote a new bathroom?' });
    await run(await scheduleProcessJob(db, leadId));

    const calls = rig.fakes.llm.callsFor('classify');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toEqual({ message: 'Can you quote a new bathroom?', formName: 'Contact us', firstName: 'Maya', company: 'Okafor Bakery' });
  });

  it.each<[string, string | null, Classification, LeadProcessingState]>([
    ['spam', 'Buy crypto now and click here', 'spam', 'filtered'],
    ['a vendor pitch', 'We offer SEO services to get you on the first page of Google', 'vendor_pitch', 'filtered'],
    ['a job seeker', 'I am looking for a job as an apprentice plumber, CV attached', 'job_seeker', 'filtered'],
    ['a support request', 'Where is my order? The invoice number is 42', 'support_request', 'filtered'],
    ['an empty message', null, 'unclear', 'notified'],
  ])('files %s as %s / %s', async (_label, message, classification, state) => {
    const db = getDb();
    const leadId = await seedLead(db, { message });
    expect(await run(await scheduleProcessJob(db, leadId))).toEqual({ status: 200, outcome: 'done' });
    expect(await leadState(db, leadId)).toMatchObject({ classification, processing_state: state, classified_at: rig.clock.now() });
  });

  it('a classifier failure becomes unclear and the lead is still drafted and notified', async () => {
    const db = getDb();
    rig.fakes.llm.injectFault('transient', { purpose: 'classify' });
    const leadId = await seedLead(db);
    expect(await run(await scheduleProcessJob(db, leadId))).toEqual({ status: 200, outcome: 'done' });
    expect(await leadState(db, leadId)).toMatchObject({ classification: 'unclear', processing_state: 'notified' });
  });

  it('a redelivery after the lead was stored reuses the class and makes no second model call', async () => {
    const db = getDb();
    const leadId = await seedLead(db);
    const job = await scheduleProcessJob(db, leadId);
    expect(await leadProcessHandler(rig.deps, job, directContext(job))).toEqual({ type: 'done' });
    rig.clock.advance({ minutes: 1 });
    expect(await leadProcessHandler(rig.deps, job, directContext(job))).toEqual({ type: 'done' });

    expect(await aiCallCount(db)).toBe(1);
    // classified_at keeps the first classification's time.
    expect((await leadState(db, leadId)).classified_at).toEqual(new Date(rig.clock.now().getTime() - 60_000));
  });

  it('a redelivery after the lead was filtered finishes without touching it', async () => {
    const db = getDb();
    const leadId = await seedLead(db, { message: 'Bitcoin casino backlinks' });
    const job = await scheduleProcessJob(db, leadId);
    await leadProcessHandler(rig.deps, job, directContext(job));
    expect(await leadProcessHandler(rig.deps, job, directContext(job))).toEqual({ type: 'done' });
    expect(await leadState(db, leadId)).toMatchObject({ processing_state: 'filtered', classification: 'spam' });
    expect(await aiCallCount(db)).toBe(1);
  });

  it('writes nothing when the attempt lost its claim before committing', async () => {
    const db = getDb();
    const leadId = await seedLead(db);
    const job = await scheduleProcessJob(db, leadId);
    const lost = directContext(job, async () => {
      throw new JobLeaseLostError();
    });
    await expect(leadProcessHandler(rig.deps, job, lost)).rejects.toBeInstanceOf(JobLeaseLostError);
    expect(await leadState(db, leadId)).toMatchObject({ processing_state: 'new', classification: null, classified_at: null });
  });
});

describe('lead_process: skips', () => {
  it.each<[string, LeadSeed]>([
    ['dismissed', { dismissed: true }],
    ['privacy-deleted', { privacyDeleted: true }],
    ['whose content is gone', { withContent: false }],
    ['a test lead', { isTest: true }],
  ])('skips a lead that is %s without calling the model', async (_label, seed) => {
    const db = getDb();
    const leadId = await seedLead(db, seed);
    const job = await scheduleProcessJob(db, leadId);
    expect(await run(job)).toEqual({ status: 200, outcome: 'skipped' });
    expect((await leadState(db, leadId)).processing_state).toBe('skipped');
    expect((await getJob(db, job.id))?.status).toBe('skipped');
    expect(rig.fakes.llm.callsFor('classify')).toHaveLength(0);
  });

  it.each(['paused', 'inactive', 'revoked', 'disconnected', 'onboarding'] as const)('skips a lead whose account is %s', async (state) => {
    const db = getDb();
    const leadId = await seedLead(db);
    await db.query('update accounts set processing_state = $2 where id = $1', [accountId, state]);
    expect(await run(await scheduleProcessJob(db, leadId))).toEqual({ status: 200, outcome: 'skipped' });
    expect((await leadState(db, leadId)).processing_state).toBe('skipped');
    expect(rig.fakes.llm.callsFor('classify')).toHaveLength(0);
  });

  it('skips a job a newer override superseded, leaving the lead alone', async () => {
    const db = getDb();
    const leadId = await seedLead(db, { processRev: 1, classification: 'spam', classificationOverride: 'lead', processingState: 'processing' });
    const stale = await scheduleProcessJob(db, leadId, 0);
    expect(await run(stale)).toEqual({ status: 200, outcome: 'skipped' });
    expect(await leadState(db, leadId)).toMatchObject({ processing_state: 'processing', process_rev: 1 });
  });

  it('skips a job whose lead no longer exists', async () => {
    const db = getDb();
    const leadId = await seedLead(db);
    const job = await scheduleProcessJob(db, leadId);
    await db.query('delete from leads where id = $1', [leadId]);
    expect(await leadProcessHandler(rig.deps, job, directContext(job))).toEqual({ type: 'skipped' });
  });
});

describe('lead_process: owner override', () => {
  it('drafts an overridden filtered lead without filtering or reclassifying it', async () => {
    const db = getDb();
    const leadId = await seedLead(db, { message: 'Bitcoin casino', processRev: 1, classification: 'spam', classificationOverride: 'lead', processingState: 'filtered' });
    const classifiedAt = (await leadState(db, leadId)).classified_at;
    rig.clock.advance({ hours: 2 });

    expect(await run(await scheduleProcessJob(db, leadId, 1))).toEqual({ status: 200, outcome: 'done' });

    expect(await leadState(db, leadId)).toEqual({ processing_state: 'notified', classification: 'spam', classified_at: classifiedAt, process_rev: 1 });
    expect(rig.fakes.llm.callsFor('classify')).toHaveLength(0);
  });

  it('classifies an overridden lead that has no class yet, but never filters it', async () => {
    const db = getDb();
    const leadId = await seedLead(db, { message: 'Guest post offer', processRev: 1 });
    expect(await run(await scheduleProcessJob(db, leadId, 1))).toEqual({ status: 200, outcome: 'done' });
    expect(await leadState(db, leadId)).toMatchObject({ processing_state: 'notified', classification: 'spam' });
  });

  it('an override job on a paused account marks the filtered lead skipped', async () => {
    const db = getDb();
    const leadId = await seedLead(db, { processRev: 1, classification: 'spam', classificationOverride: 'lead', processingState: 'filtered' });
    await db.query(`update accounts set processing_state = 'paused' where id = $1`, [accountId]);
    expect(await run(await scheduleProcessJob(db, leadId, 1))).toEqual({ status: 200, outcome: 'skipped' });
    expect((await leadState(db, leadId)).processing_state).toBe('skipped');
  });
});

describe('lead_process: failure path', () => {
  it('marks the lead failed when QStash gives up on the job', async () => {
    const db = getDb();
    const leadId = await seedLead(db);
    const job = await scheduleProcessJob(db, leadId);
    expect(job.externalId).not.toBeNull();

    expect(await handleFailureCallback(rig.deps, { jobId: job.id, sourceMessageId: job.externalId ?? '' }, registry)).toBe('won');

    expect((await leadState(db, leadId)).processing_state).toBe('failed');
    expect((await getJob(db, job.id))?.status).toBe('failed');
    expect(alerts.map((a) => a.code)).toEqual(['job_failed']);
  });

  it('marks a lead failed on a permanent error and is idempotent', async () => {
    const db = getDb();
    const leadId = await seedLead(db, { processingState: 'processing', classification: 'lead' });
    const job = await scheduleProcessJob(db, leadId);
    const failurePath = registry.failurePath('lead_process');
    if (failurePath === undefined) throw new Error('failure path not registered');
    await failurePath(rig.deps, job, { reason: 'permanent', code: 'db_error' });
    await failurePath(rig.deps, job, { reason: 'sweeper', code: 'job_too_many_attempts' });
    expect((await leadState(db, leadId)).processing_state).toBe('failed');
  });

  it.each<[string, LeadSeed, LeadProcessingState]>([
    ['notified', { processingState: 'notified', classification: 'lead' }, 'notified'],
    ['filtered (no override)', { processingState: 'filtered', classification: 'spam' }, 'filtered'],
    ['skipped', { processingState: 'skipped' }, 'skipped'],
  ])('leaves a lead that is already %s alone', async (_label, seed, expected) => {
    const db = getDb();
    const leadId = await seedLead(db, seed);
    const job = await scheduleProcessJob(db, leadId);
    await handleFailureCallback(rig.deps, { jobId: job.id, sourceMessageId: job.externalId ?? '' }, registry);
    expect((await leadState(db, leadId)).processing_state).toBe(expected);
  });

  it('marks an overridden filtered lead failed, but not for a superseded job', async () => {
    const db = getDb();
    const leadId = await seedLead(db, { processRev: 1, classification: 'spam', classificationOverride: 'lead', processingState: 'filtered' });
    const stale = await scheduleProcessJob(db, leadId, 0);
    await handleFailureCallback(rig.deps, { jobId: stale.id, sourceMessageId: stale.externalId ?? '' }, registry);
    expect((await leadState(db, leadId)).processing_state).toBe('filtered');

    const current = await scheduleProcessJob(db, leadId, 1);
    await handleFailureCallback(rig.deps, { jobId: current.id, sourceMessageId: current.externalId ?? '' }, registry);
    expect((await leadState(db, leadId)).processing_state).toBe('failed');
  });
});

describe('lead_process: wiring', () => {
  it('registers the handler and the failure path', () => {
    expect(registry.handler('lead_process')).toBe(leadProcessHandler);
    expect(registry.failurePath('lead_process')).toBeTypeOf('function');
  });

  it('reads the job revision from the payload, else from the dedupe key', () => {
    expect(leadProcessDedupeKey('L1', 3)).toBe('lead:L1:process:r3');
    expect(jobProcessRev({ dedupeKey: 'lead:L1:process:r3', payload: {} })).toBe(3);
    expect(jobProcessRev({ dedupeKey: 'lead:L1:process:r3', payload: { processRev: 4 } })).toBe(4);
    expect(jobProcessRev({ dedupeKey: 'lead:L1:other', payload: {} })).toBeNull();
  });

  it('a job without a lead fails permanently', async () => {
    const db = getDb();
    const now = rig.clock.now();
    const job = await db.tx((tx) => insertJob(tx, { kind: 'lead_process', accountId, dedupeKey: 'lead:none:process:r0', runAt: now, now }));
    if (job === null) throw new Error('job not inserted');
    expect(await leadProcessHandler(rig.deps, job, directContext(job))).toEqual({ type: 'permanent', code: 'lead_process_without_lead' });
  });
});
