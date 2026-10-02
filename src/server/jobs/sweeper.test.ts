import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PermanentError } from '@/server/domain/errors';
import type { Deps } from '@/server/ports';
import {
  createNotificationRegistry,
  getNotification,
  NotificationKeys,
  NotificationPredicates,
  reserveAndSend,
  reserveInTx,
  type NotificationRegistry,
} from '@/server/services/notifications';
import { useTestDb as setUpTestDb } from '../../../test/db/harness';
import { onAlert, type RaisedAlert } from './alert';
import { claimJob } from './claim';
import { insertJob, publishJobs } from './outbox';
import { createJobRegistry, type JobRegistry } from './registry';
import { republishJob } from './republish';
import { getJob } from './rows';
import { runSweeper } from './sweeper';
import { createJobTestRig, seedActiveAccount, seedLead, type JobTestRig } from './testing';
import { JobOutcomes, type JobRow } from './types';

const getDb = setUpTestDb();

let jobs: JobRegistry;
let notifications: NotificationRegistry;
let rig: JobTestRig;
let alerts: RaisedAlert[];
let stopAlerts: () => void;

beforeEach(() => {
  jobs = createJobRegistry();
  notifications = createNotificationRegistry();
  rig = createJobTestRig(getDb(), jobs);
  alerts = [];
  stopAlerts = onAlert((alert) => alerts.push(alert));
});

afterEach(() => {
  stopAlerts();
});

const sweep = () => runSweeper(rig.deps, { jobRegistry: jobs, notificationRegistry: notifications });

async function insert(deps: Deps, options: { key?: string; publish?: boolean; kind?: JobRow['kind']; accountId?: string | null } = {}): Promise<JobRow> {
  const now = deps.clock.now();
  const job = await deps.db.tx((tx) =>
    insertJob(tx, { kind: options.kind ?? 'portal_poll', accountId: options.accountId ?? null, dedupeKey: options.key ?? 'poll:sweep:1', runAt: now, now }),
  );
  if (job === null) throw new Error('job not inserted');
  if (options.publish !== false) await publishJobs(deps, [job]);
  return (await getJob(deps.db, job.id)) ?? job;
}

describe('sweeper: jobs', () => {
  it('publishes a row left unpublished for more than 2 minutes', async () => {
    const { deps, fakes, clock } = rig;
    const job = await insert(deps, { publish: false });
    clock.advance({ minutes: 1 });
    expect((await sweep()).published).toBe(0);
    clock.advance({ minutes: 2 });
    expect((await sweep()).published).toBe(1);
    expect(await getJob(deps.db, job.id)).toMatchObject({ status: 'scheduled', hops: 0 });
    expect(fakes.scheduler.pending().map((m) => m.dedupeId)).toEqual(['fake-local:poll:sweep:1']);
  });

  it('re-publishes a scheduled row whose run_at passed more than 30 minutes ago (lost message)', async () => {
    const { deps, fakes, clock } = rig;
    let runs = 0;
    jobs.register('portal_poll', async () => {
      runs += 1;
      return JobOutcomes.done();
    });
    const job = await insert(deps);
    await fakes.scheduler.cancel(job.externalId ?? '');
    clock.advance({ minutes: 29 });
    expect((await sweep()).republished).toBe(0);
    clock.advance({ minutes: 2 });
    expect((await sweep()).republished).toBe(1);
    expect(fakes.scheduler.pending().map((m) => m.dedupeId)).toEqual(['fake-local:poll:sweep:1:h1']);
    await fakes.scheduler.runDue();
    expect(runs).toBe(1);
    expect(await getJob(deps.db, job.id)).toMatchObject({ status: 'done', hops: 1 });
  });

  it('re-publishes a running row whose lease expired (the attempt died)', async () => {
    const { deps, fakes, clock } = rig;
    let runs = 0;
    jobs.register('portal_poll', async () => {
      runs += 1;
      return JobOutcomes.done();
    });
    const job = await insert(deps);
    await fakes.scheduler.cancel(job.externalId ?? '');
    await claimJob(deps.db, job.id, 'dead-attempt', deps.clock.now());
    clock.advance({ minutes: 5 });
    expect((await sweep()).republished).toBe(0);
    clock.advance({ minutes: 2 });
    expect((await sweep()).republished).toBe(1);
    expect(await getJob(deps.db, job.id)).toMatchObject({ status: 'scheduled', hops: 1, leaseUntil: null });
    await fakes.scheduler.runDue();
    expect(runs).toBe(1);
    expect(await getJob(deps.db, job.id)).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('re-publishes a lost hop message for the job’s real target, never early (PLAN §8.5 hop past 7 days)', async () => {
    const { deps, fakes, clock } = rig;
    const runs: Date[] = [];
    jobs.register('portal_poll', async () => {
      runs.push(clock.now());
      return JobOutcomes.done();
    });
    const start = clock.now();
    const target = new Date(start.getTime() + 10 * 86_400_000);
    const job = await deps.db.tx((tx) => insertJob(tx, { kind: 'portal_poll', accountId: null, dedupeKey: 'poll:sweep:far', runAt: target, now: start }));
    await publishJobs(deps, [job]);
    const parked = await getJob(deps.db, job?.id ?? '');
    // Parked at the hop point (the QStash maximum delay), then its message is lost.
    expect(parked?.runAt).toEqual(new Date(start.getTime() + deps.env.QSTASH_MAX_DELAY_SECONDS * 1000));
    await fakes.scheduler.cancel(parked?.externalId ?? '');

    clock.set(new Date((parked?.runAt.getTime() ?? 0) + 31 * 60_000));
    expect((await sweep()).republished).toBe(1);
    const moved = await getJob(deps.db, job?.id ?? '');
    expect(moved).toMatchObject({ status: 'scheduled', hops: 1, runAt: target, payload: { targetAt: target.toISOString() } });

    await fakes.scheduler.runDue();
    expect(runs).toEqual([]);
    clock.set(target);
    await fakes.scheduler.runDue();
    expect(runs).toEqual([target]);
  });

  it('leaves a row whose re-publish is in flight to its publisher (no false deduplicated alert)', async () => {
    const { deps, fakes, clock } = rig;
    jobs.register('portal_poll', async () => JobOutcomes.done());
    const job = await insert(deps);
    clock.advance({ minutes: 10 });
    // The sweep lands between the re-publish compare-and-set and its publish call.
    let swept: Awaited<ReturnType<typeof sweep>> | null = null;
    const racing: Deps = {
      ...deps,
      scheduler: {
        publish: async (request) => {
          if (request.dedupeId.endsWith(':h1') && swept === null) swept = await sweep();
          return deps.scheduler.publish(request);
        },
        cancel: (messageId) => deps.scheduler.cancel(messageId),
      },
    };
    const moved = await republishJob(racing, job, new Date(clock.now().getTime() + 30 * 60_000), { type: 'hops', hops: 0 });
    expect(swept).toMatchObject({ published: 0 });
    expect(moved?.publish.deduplicated).toBe(false);
    expect(alerts.filter((a) => a.code === 'job_republish_deduplicated')).toEqual([]);
    expect(fakes.scheduler.pending().filter((m) => m.dedupeId.endsWith(':h1'))).toHaveLength(1);
  });

  it('still publishes a re-published row whose publish failed, once its run_at has passed', async () => {
    const { deps, fakes, clock } = rig;
    jobs.register('portal_poll', async () => JobOutcomes.done());
    const job = await insert(deps);
    const failing: Deps = {
      ...deps,
      scheduler: { publish: () => Promise.reject(new Error('qstash down')), cancel: (messageId) => deps.scheduler.cancel(messageId) },
    };
    await expect(republishJob(failing, job, clock.now(), { type: 'hops', hops: 0 })).rejects.toThrow();
    expect(await getJob(deps.db, job.id)).toMatchObject({ status: 'scheduled', hops: 1, externalId: null });
    clock.advance({ minutes: 1 });
    expect((await sweep()).published).toBe(0);
    clock.advance({ minutes: 2 });
    expect((await sweep()).published).toBe(1);
    expect(fakes.scheduler.pending().map((m) => m.dedupeId)).toContain('fake-local:poll:sweep:1:h1');
  });

  it('runs the failure path instead of re-publishing once attempts reach 6', async () => {
    const { deps, clock } = rig;
    const reasons: string[] = [];
    jobs.registerFailurePath('portal_poll', async (_deps, _job, info) => {
      reasons.push(info.reason);
    });
    const job = await insert(deps);
    await claimJob(deps.db, job.id, 'dead-attempt', deps.clock.now());
    await deps.db.query(`update scheduled_jobs set attempts = 6, last_error_code = 'hubspot_server_error' where id = $1`, [job.id]);
    clock.advance({ minutes: 7 });
    const summary = await sweep();
    expect(summary).toMatchObject({ failed: 1, republished: 0 });
    expect(reasons).toEqual(['sweeper']);
    expect(alerts.filter((a) => a.code === 'job_failed')).toHaveLength(1);
    expect(await getJob(deps.db, job.id)).toMatchObject({ status: 'failed', hops: 0 });
    expect((await sweep()).failed).toBe(0);
  });
});

describe('sweeper: weekly reports', () => {
  // Monday 2026-10-05, 16:00 in New York: the report week's Monday, before Tuesday 00:00 local.
  const MONDAY_AFTERNOON = new Date('2026-10-05T20:00:00.000Z');

  async function setUpFailedReport(deps: Deps): Promise<{ jobId: string; reportId: string; sends: () => number }> {
    const db = getDb();
    const { accountId } = await seedActiveAccount(db, deps.clock.now());
    const report = await db.one<{ id: string }>(
      `insert into weekly_reports (account_id, week_start, timezone, period_start, period_end, status, attempts)
       values ($1, '2026-10-05', 'America/New_York', '2026-09-28T12:00:00Z', '2026-10-05T12:00:00Z', 'pending', 0) returning id`,
      [accountId],
    );
    let runs = 0;
    jobs.register('weekly_report', async (d) => {
      runs += 1;
      if (runs === 1) throw new PermanentError('report_metrics_failed');
      await reserveAndSend(d, {
        kind: 'weekly_report',
        dedupeKey: NotificationKeys.weeklyReport(accountId, '2026-10-05'),
        accountId,
        predicates: NotificationPredicates.weeklyReport(accountId),
        render: () => ({ to: ['owner@example.com'], subject: 'Your Monday report', html: '<p>report</p>', text: 'report' }),
      });
      return JobOutcomes.done();
    });
    jobs.registerFailurePath('weekly_report', async (d) => {
      await d.db.query(`update weekly_reports set status = 'failed' where id = $1`, [report.id]);
    });
    const job = await insert(deps, { kind: 'weekly_report', key: `report:${accountId}:2026-10-05`, accountId });
    await rig.fakes.scheduler.runDue();
    expect((await getJob(deps.db, job.id))?.status).toBe('failed');
    return { jobId: job.id, reportId: report.id, sends: () => rig.fakes.mailer.sent.length };
  }

  it('re-enqueues a failed report before local Tuesday 00:00 and sends it once', async () => {
    rig = createJobTestRig(getDb(), jobs, { start: MONDAY_AFTERNOON });
    const { deps, fakes } = rig;
    const { jobId, reportId, sends } = await setUpFailedReport(deps);
    expect((await sweep()).weeklyReportsRequeued).toBe(1);
    expect(await getJob(deps.db, jobId)).toMatchObject({ status: 'scheduled', attempts: 0, hops: 1, finishedAt: null });
    expect(await getDb().one(`select status, attempts from weekly_reports where id = $1`, [reportId])).toEqual({ status: 'pending', attempts: 1 });
    expect(fakes.scheduler.pending().map((m) => m.dedupeId)).toEqual([expect.stringMatching(/^fake-local:report:.+:2026-10-05:h1$/)]);
    await fakes.scheduler.runDue();
    expect((await getJob(deps.db, jobId))?.status).toBe('done');
    expect(sends()).toBe(1);
    expect((await sweep()).weeklyReportsRequeued).toBe(0);
  });

  it('does not re-enqueue after local Tuesday 00:00', async () => {
    rig = createJobTestRig(getDb(), jobs, { start: new Date('2026-10-06T03:59:00.000Z') });
    const { deps, clock } = rig;
    const { jobId } = await setUpFailedReport(deps);
    clock.advance({ minutes: 1 });
    expect((await sweep()).weeklyReportsRequeued).toBe(0);
    expect((await getJob(deps.db, jobId))?.status).toBe('failed');
  });

  it('does not re-enqueue a report that already ran 3 times', async () => {
    rig = createJobTestRig(getDb(), jobs, { start: MONDAY_AFTERNOON });
    const { deps } = rig;
    const { jobId, reportId } = await setUpFailedReport(deps);
    await getDb().query(`update weekly_reports set attempts = 3 where id = $1`, [reportId]);
    expect((await sweep()).weeklyReportsRequeued).toBe(0);
    expect((await getJob(deps.db, jobId))?.status).toBe('failed');
  });
});

describe('sweeper: notifications', () => {
  async function reserveNewLead(deps: Deps, at: Date): Promise<string> {
    const db = getDb();
    const { accountId } = await seedActiveAccount(db, at);
    const leadId = await seedLead(db, { accountId, now: at });
    const key = NotificationKeys.initial(leadId, 0);
    const row = await db.tx((tx) =>
      reserveInTx(tx, {
        kind: 'new_lead',
        dedupeKey: key,
        accountId,
        leadId,
        predicates: NotificationPredicates.initial({ accountId, leadId }),
        now: at,
      }),
    );
    expect(row?.status).toBe('sending');
    return key;
  }

  function registerNewLeadRenderer(): void {
    notifications.register('new_lead', async (_deps, row) => ({
      predicates: NotificationPredicates.initial({ accountId: row.accountId ?? '', leadId: row.leadId ?? '' }),
      render: () => ({ to: ['owner@example.com'], subject: 'New lead', html: '<p>lead</p>', text: 'lead' }),
    }));
  }

  it('resumes a lost send at doubling intervals until Resend recovers, sending exactly once', async () => {
    const { deps, fakes, clock } = rig;
    registerNewLeadRenderer();
    const t0 = deps.clock.now();
    const key = await reserveNewLead(deps, t0);
    // Resend fails the first three resumed sends.
    fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error', times: 3 });
    const resumes = async (): Promise<number> => (await getNotification(deps.db, key))?.sweeperResumes ?? -1;

    let last = t0;
    for (const [done, spacingMinutes] of [10, 20, 40, 80].entries()) {
      clock.set(new Date(last.getTime() + spacingMinutes * 60_000));
      await sweep();
      expect(await resumes()).toBe(done);
      clock.advance({ seconds: 1 });
      await sweep();
      expect(await resumes()).toBe(done + 1);
      last = deps.clock.now();
    }
    expect(await getNotification(deps.db, key)).toMatchObject({ status: 'sent', sendAttempts: 4, sweeperResumes: 4 });
    expect(fakes.mailer.sent).toHaveLength(1);
    clock.advance({ hours: 5 });
    await sweep();
    expect(fakes.mailer.sent).toHaveLength(1);
  });

  it('caps the spacing at 2 hours', async () => {
    const { deps, fakes, clock } = rig;
    registerNewLeadRenderer();
    const t0 = deps.clock.now();
    const key = await reserveNewLead(deps, t0);
    await deps.db.query(`update notifications_sent set sweeper_resumes = 5 where dedupe_key = $1`, [key]);
    fakes.mailer.injectFailure({ kind: 'transient', code: 'rate_limit_exceeded', times: 1 });
    clock.set(new Date(t0.getTime() + 120 * 60_000));
    await sweep();
    expect((await getNotification(deps.db, key))?.sweeperResumes).toBe(5);
    clock.set(new Date(t0.getTime() + 120 * 60_000 + 1000));
    await sweep();
    expect((await getNotification(deps.db, key))?.sweeperResumes).toBe(6);
  });

  it('fails a reservation first made 23 hours ago, with one alert and no email', async () => {
    const { deps, fakes, clock } = rig;
    registerNewLeadRenderer();
    const t0 = deps.clock.now();
    const expired = await reserveNewLead(deps, t0);
    const fresh = await reserveNewLead(deps, new Date(t0.getTime() + 60_000));
    clock.set(new Date(t0.getTime() + 23 * 3_600_000));
    const summary = await sweep();
    expect(summary).toMatchObject({ notificationsExpired: 1, notificationsResumed: 1 });
    expect((await getNotification(deps.db, expired))?.status).toBe('failed');
    expect((await getNotification(deps.db, fresh))?.status).toBe('sent');
    expect(alerts.filter((a) => a.code === 'notification_expired')).toHaveLength(1);
    expect(fakes.mailer.sent).toHaveLength(1);
    await sweep();
    expect(alerts.filter((a) => a.code === 'notification_expired')).toHaveLength(1);
  });

  it('marks a magic-link reservation failed (it cannot be re-rendered)', async () => {
    const { deps, fakes, clock } = rig;
    const t0 = deps.clock.now();
    await deps.db.tx((tx) => reserveInTx(tx, { kind: 'magic_link', dedupeKey: 'magic:intent-1', accountId: null, now: t0 }));
    clock.advance({ minutes: 11 });
    await sweep();
    expect((await getNotification(deps.db, 'magic:intent-1'))?.status).toBe('failed');
    expect(fakes.mailer.sent).toEqual([]);
  });

  it('leaves a reservation whose kind has no renderer for a later sweep', async () => {
    const { deps, clock } = rig;
    const t0 = deps.clock.now();
    const key = await reserveNewLead(deps, t0);
    clock.advance({ minutes: 11 });
    await sweep();
    expect(await getNotification(deps.db, key)).toMatchObject({ status: 'sending', sweeperResumes: 0 });
  });

  it('does not resume a reservation whose predicates no longer hold (the lead was dismissed)', async () => {
    const { deps, fakes, clock } = rig;
    registerNewLeadRenderer();
    const t0 = deps.clock.now();
    const key = await reserveNewLead(deps, t0);
    await deps.db.query(`update leads set dismissed_at = $1`, [t0]);
    clock.advance({ minutes: 11 });
    await sweep();
    expect((await getNotification(deps.db, key))?.status).toBe('failed');
    expect(fakes.mailer.sent).toEqual([]);
  });

  it('keeps going when one resume fails transiently', async () => {
    const { deps, fakes, clock } = rig;
    registerNewLeadRenderer();
    await reserveNewLead(deps, deps.clock.now());
    fakes.mailer.injectFailure({ kind: 'transient', code: 'rate_limit_exceeded' });
    clock.advance({ minutes: 11 });
    const summary = await sweep();
    expect(summary.errors).toBe(1);
    expect(alerts).toEqual([]);
  });
});
