// Runs the simulation (PLAN §13, D-39): fakes, PGlite in memory, a FakeClock from Tue 2026-10-06
// 09:00 America/New_York. Never reads the wall clock and never calls a live service.
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DateTime, Settings } from 'luxon';
import { z } from 'zod';
import { createFakeDeps } from '@/server/adapters/fake';
import { FakeClock } from '@/server/adapters/fake/clock';
import { outboxFileBase, type FakeSentMail } from '@/server/adapters/fake/mailer';
import type { FakeDelivery, FakeFailureCallback } from '@/server/adapters/fake/scheduler';
import { migrate } from '@/server/db/migrate';
import { createPgliteDb, type PgliteDb } from '@/server/db/pglite';
import { parseEnv, type Env } from '@/server/env';
import { CRON_DAILY_PATH, handleCronDaily } from '@/server/http/cron-daily';
import { CRON_POLL_PATH, handleCronPoll } from '@/server/http/cron-poll';
import { CRON_WEEKLY_REPORT_PATH, handleCronWeeklyReport } from '@/server/http/cron-weekly-report';
import { createSchedulerBridge } from '@/server/jobs/bridge';
import { createJobHandlerRegistries } from '@/server/jobs/handlers';
import type { Deps } from '@/server/ports';
import { DAILY_0317_UTC, EVERY_5_MINUTES, HOURLY, TimeTravel, type CronSeries } from './engine';
import { summaryLeadRows } from './leads';
import { STAGES } from './stages';
import type {
  CheckResult,
  Detail,
  EmailSummary,
  LeadSummary,
  ScenarioState,
  Simulation,
  SimulationSummary,
  Stage,
  StageSummary,
  TimelineEntry,
} from './types';

export const SCENARIO = 'brightside-plumbing-week';
/** Tue 2026-10-06 09:00 in America/New_York (EDT, UTC-4). */
export const SIMULATION_START = new Date('2026-10-06T13:00:00.000Z');
export const SUMMARY_FILE = 'summary.json';

/** Files a previous run left in the outbox directory. */
const OUTBOX_FILE = /^(?:\d{3}-[A-Za-z0-9_-]+\.(?:html|txt)|summary\.json)$/;

export interface RunOptions {
  /** Where emails (`NNN-<kind>-<lead>.html/.txt`) and summary.json go. */
  outboxDir: string;
  /** SIMULATE_SYSTEM_TIME, recorded in the summary. */
  systemTime?: string | null | undefined;
  /** A migrated, empty PGlite (tests pass the harness dump); default a new in-memory one, migrated here. */
  db?: PgliteDb | undefined;
  stages?: readonly Stage[] | undefined;
  /** The scenario's name in summary.json (default SCENARIO); a variant names itself (e.g. the daily-cap run). */
  scenario?: string | undefined;
  /** Fake-mode variables a variant changes (e.g. `MAX_DRAFTED_LEADS_PER_DAY`); only documented fake values. */
  env?: Readonly<Record<string, string>> | undefined;
}

async function clearOutbox(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const name of await readdir(dir)) {
    if (OUTBOX_FILE.test(name)) await rm(path.join(dir, name), { force: true });
  }
}

async function openDb(given: PgliteDb | undefined): Promise<{ db: PgliteDb; owned: boolean }> {
  if (given !== undefined) return { db: given, owned: false };
  const db = createPgliteDb();
  await migrate(db);
  return { db, owned: true };
}

function iso(date: Date): string {
  return date.toISOString();
}

/** The key a scenario declares a lead by: its contact and submission time. */
function declaredLeadKey(contactId: string, submittedAt: Date): string {
  return `${contactId}|${submittedAt.toISOString()}`;
}

function refNumber(ref: string): number {
  return Number(ref.slice(1));
}

/**
 * The leads, labelled: a lead the scenario declared keeps its ref (`L5` is submission #5); any
 * other lead gets the next free `L{n}` in the stable order (submitted_at, contact, form). The
 * onboarding test lead is left out (leads.ts). Returned in ref order, with the map from lead id to ref.
 */
async function readLeads(
  db: PgliteDb,
  declared: ReadonlyMap<string, string>,
): Promise<{ leads: LeadSummary[]; refById: ReadonlyMap<string, string> }> {
  const rows = await summaryLeadRows(db);
  const used = new Set(declared.values());
  const refById = new Map<string, string>();
  let next = 1;
  for (const row of rows) {
    let ref = row.hubspot_contact_id === null ? undefined : declared.get(declaredLeadKey(row.hubspot_contact_id, row.submitted_at));
    if (ref === undefined) {
      while (used.has(`L${next}`)) next += 1;
      ref = `L${next}`;
      used.add(ref);
    }
    refById.set(row.id, ref);
  }
  const leads = rows
    .map((row) => ({
      ref: refById.get(row.id) ?? '',
      hubspotContactId: row.hubspot_contact_id,
      formId: row.form_id,
      submittedAt: iso(row.submitted_at),
      intakeTrigger: row.intake_trigger,
      isTest: row.is_test,
      classification: row.classification,
      processingState: row.processing_state,
      stopReason: row.stop_reason,
    }))
    .sort((a, b) => refNumber(a.ref) - refNumber(b.ref));
  return { leads, refById };
}

/**
 * Email summaries that name leads by ref, not by id; the outbox files are renamed to match, so
 * the directory is as reproducible as summary.json.
 */
async function summariseEmails(
  sent: readonly FakeSentMail[],
  refById: ReadonlyMap<string, string>,
  outboxDir: string,
): Promise<EmailSummary[]> {
  const emails: EmailSummary[] = [];
  for (const mail of sent) {
    const lead = mail.lead === undefined ? null : (refById.get(mail.lead) ?? mail.lead);
    const file = outboxFileBase({ seq: mail.seq, kind: mail.kind, lead: lead ?? undefined });
    const written = outboxFileBase(mail);
    if (file !== written) {
      for (const extension of ['html', 'txt']) {
        await rename(path.join(outboxDir, `${written}.${extension}`), path.join(outboxDir, `${file}.${extension}`));
      }
    }
    emails.push({ seq: mail.seq, at: iso(mail.sentAt), kind: mail.kind, lead, to: [...mail.to], subject: mail.subject, file });
  }
  return emails;
}

const pollSummarySchema = z.object({
  ok: z.boolean(),
  status: z.string().optional(),
  accounts: z.number().optional(),
  pollable: z.number().optional(),
  polled: z.number().optional(),
  leadsCreated: z.number().optional(),
  stateChanges: z.number().optional(),
  pollErrors: z.number().optional(),
  code: z.string().optional(),
});

const weeklyReportSummarySchema = z.object({
  ok: z.boolean(),
  accounts: z.number().optional(),
  due: z.number().optional(),
  created: z.number().optional(),
  existing: z.number().optional(),
  published: z.number().optional(),
  publishFailed: z.number().optional(),
  errors: z.number().optional(),
  code: z.string().optional(),
});

const countOf = z.number().int().nonnegative();
// Counts only. The webhook_events prune goes by `recorded_at`, bound from the Clock like every
// logical column (D-82), so its count is as deterministic as the others (the 2030 run must produce
// the same summary).
const dailySummarySchema = z.object({
  ok: z.boolean(),
  status: z.string().optional(),
  code: z.string().optional(),
  errors: z.number().optional(),
  retention: z
    .object({
      leadMessagesDeleted: countOf,
      draftsPurged: countOf,
      inboxChecksClosed: countOf,
      testAddressesCleared: countOf,
      loginIntentsDeleted: countOf,
      actionTokensDeleted: countOf,
      webhookEventsDeleted: countOf,
    })
    .nullable()
    .optional(),
  tombstones: z.object({ checked: countOf, resolved: countOf, cancelled: countOf, open: countOf, failed: countOf }).nullable().optional(),
  jobs: z.object({ accounts: countOf, created: countOf, existing: countOf, published: countOf }).nullable().optional(),
});

/** A cron route as Vercel Cron calls it: `GET` with `Authorization: Bearer CRON_SECRET`. */
function cronRequest(env: Env, routePath: string): Request {
  return new Request(`${env.APP_URL}${routePath}`, { headers: { authorization: `Bearer ${env.CRON_SECRET}` } });
}

/** Runs every stage in order and writes summary.json. Resolves with the summary; `ok` says whether every check passed. */
export async function runSimulation(options: RunOptions): Promise<SimulationSummary> {
  const stages = options.stages ?? STAGES;
  await clearOutbox(options.outboxDir);

  const clock = new FakeClock(SIMULATION_START);
  const previousLuxonNow = Settings.now;
  Settings.now = () => clock.nowMs();
  const { db, owned } = await openDb(options.db);

  try {
    // Documented fake values only: the simulation is hermetic, whatever this shell exports.
    const env = parseEnv({ ...options.env, APP_MODE: 'fake' });

    const timeline: TimelineEntry[] = [];
    const checks: CheckResult[] = [];
    const stageSummaries: StageSummary[] = [];
    /** Timeline entries that name a lead, filled with its ref once every lead is known. */
    const leadLinks: { index: number; leadId: string }[] = [];
    const declared = new Map<string, string>();
    let weeklyReport: unknown = null;
    let currentStage = '';
    let timeZone = 'UTC';

    const record = (kind: TimelineEntry['kind'], name: string, detail?: Detail, leadId?: string | null): void => {
      const now = clock.now();
      timeline.push({
        at: iso(now),
        local: DateTime.fromJSDate(now, { zone: timeZone }).toFormat('ccc yyyy-LL-dd HH:mm:ss'),
        stage: currentStage,
        kind,
        name,
        ...(detail !== undefined ? { detail } : {}),
      });
      if (leadId !== undefined && leadId !== null) leadLinks.push({ index: timeline.length - 1, leadId });
    };

    // Every lead the run creates is noted once, with the trigger that found it (PLAN §13). Its
    // declared key is kept, so a lead a later purge deleted (the disconnect variant) still has its ref.
    const seenLeads = new Map<string, string | null>();
    const noteNewLeads = async (): Promise<void> => {
      const rows = await db.query<{ id: string; intake_trigger: string; is_test: boolean; hubspot_contact_id: string | null; submitted_at: Date }>(
        `select id, intake_trigger, is_test, hubspot_contact_id, submitted_at from public.leads order by received_at, submitted_at, hubspot_contact_id nulls last`,
      );
      for (const row of rows) {
        if (seenLeads.has(row.id)) continue;
        seenLeads.set(row.id, row.hubspot_contact_id === null ? null : declaredLeadKey(row.hubspot_contact_id, row.submitted_at));
        // The inbox check's test lead is in no list (PLAN §13): it is noted without a ref.
        if (row.is_test) record('intake', 'test_lead.created', { trigger: row.intake_trigger });
        else record('intake', 'lead.created', { lead: null, trigger: row.intake_trigger, isTest: false }, row.id);
      }
    };

    // The fake QStash delivers to runJob through the same bridge fake mode uses (/api/jobs/run and
    // /api/jobs/failed without HTTP); each delivery and failure callback is recorded.
    const box: { deps?: Deps | undefined } = {};
    // Every registered handler; the ones that call HubSpot wait for the per-portal limiter's next
    // window on the FakeClock (as the poll cron's sleep does below), never on the wall clock.
    const registries = createJobHandlerRegistries({
      limiterSleep: async (ms) => {
        clock.advance(ms);
      },
    });
    const bridge = createSchedulerBridge(() => {
      if (box.deps === undefined) throw new Error('simulation_not_ready');
      return box.deps;
    }, registries.jobs);
    const jobRow = (jobId: string) =>
      db.maybeOne<{ status: string; lead_id: string | null }>('select status, lead_id from public.scheduled_jobs where id = $1', [jobId]);
    // The account_daily job (M7) reads HubSpot for the leads whose follow-ups are over; its timeline
    // entry says how many leads it read in full and how many emails went out meanwhile (none expected).
    const signalsChecked = async (): Promise<Map<string, number>> =>
      new Map(
        (await db.query<{ id: string; at: Date | null }>('select id, signals_checked_at as at from public.leads')).map((row) => [row.id, row.at?.getTime() ?? 0]),
      );
    const dispatch = async (delivery: FakeDelivery): Promise<{ status: number; headers: Headers }> => {
      const daily = delivery.kind === 'account_daily';
      const emailsBefore = fakes.mailer.sent.length;
      const checkedBefore = daily ? await signalsChecked() : null;
      const result = await bridge.dispatch(delivery);
      const row = await jobRow(delivery.jobId);
      let extra: Detail = {};
      if (checkedBefore !== null) {
        const checkedAfter = await signalsChecked();
        const leadsRead = [...checkedAfter].filter(([id, at]) => at !== (checkedBefore.get(id) ?? 0)).length;
        extra = { leadsRead, emailsSent: fakes.mailer.sent.length - emailsBefore };
      }
      record(
        'job',
        `job.${delivery.kind}`,
        { lead: null, retried: delivery.retried, httpStatus: result.status, jobStatus: row?.status ?? null, ...extra },
        row?.lead_id ?? null,
      );
      await noteNewLeads();
      return result;
    };
    const onJobFailure = async (failure: FakeFailureCallback): Promise<void> => {
      await bridge.onFailure(failure);
      const row = await jobRow(failure.jobId);
      record('job', `job.${failure.kind}.failure_callback`, { lead: null, retried: failure.retried, jobStatus: row?.status ?? null }, row?.lead_id ?? null);
    };

    const { deps, fakes } = createFakeDeps({
      env,
      db,
      clock,
      mailSink: { kind: 'directory', dir: options.outboxDir },
      dispatch,
      onJobFailure,
      elapse: (ms) => {
        clock.advance(ms);
      },
    });
    box.deps = deps;
    timeZone = fakes.hubspot.portal.timeZone;

    // PLAN §8.1 periodic triggers, each through its real route handler.
    const crons: CronSeries[] = [
      {
        name: 'cron.poll',
        next: EVERY_5_MINUTES,
        run: async () => {
          const response = await handleCronPoll(cronRequest(env, CRON_POLL_PATH), deps, {
            sleep: async (ms) => {
              clock.advance(ms);
            },
          });
          const body = pollSummarySchema.parse(await response.json());
          record('tick', 'cron.poll', {
            httpStatus: response.status,
            status: body.status ?? body.code ?? null,
            accounts: body.accounts ?? null,
            polled: body.polled ?? null,
            leadsCreated: body.leadsCreated ?? null,
            stateChanges: body.stateChanges ?? null,
            pollErrors: body.pollErrors ?? null,
          });
          await noteNewLeads();
        },
      },
      {
        name: 'cron.weekly_report',
        next: HOURLY,
        // The hourly Monday-report due-check (PLAN §8.1, D-17): creates the report and its job once
        // the account's Monday 08:00 has come (the job runs after its stagger, through the scheduler).
        run: async () => {
          const response = await handleCronWeeklyReport(cronRequest(env, CRON_WEEKLY_REPORT_PATH), deps);
          const body = weeklyReportSummarySchema.parse(await response.json());
          record('tick', 'cron.weekly_report', {
            httpStatus: response.status,
            status: body.code ?? null,
            accounts: body.accounts ?? null,
            due: body.due ?? null,
            created: body.created ?? null,
            existing: body.existing ?? null,
            published: body.published ?? null,
            errors: body.errors ?? null,
          });
        },
      },
      {
        name: 'cron.daily',
        next: DAILY_0317_UTC,
        // The daily maintenance (PLAN §7.3, §9.10, M7): retention and prunes, the billing-tombstone
        // reconcile, and one account_daily job per account (delivered right after, through the scheduler).
        run: async () => {
          const response = await handleCronDaily(cronRequest(env, CRON_DAILY_PATH), deps);
          const body = dailySummarySchema.parse(await response.json());
          record('tick', 'cron.daily', {
            httpStatus: response.status,
            status: body.status ?? body.code ?? null,
            errors: body.errors ?? null,
            leadMessagesDeleted: body.retention?.leadMessagesDeleted ?? null,
            draftsPurged: body.retention?.draftsPurged ?? null,
            loginIntentsDeleted: body.retention?.loginIntentsDeleted ?? null,
            actionTokensDeleted: body.retention?.actionTokensDeleted ?? null,
            tombstonesChecked: body.tombstones?.checked ?? null,
            tombstonesResolved: body.tombstones?.resolved ?? null,
            accounts: body.jobs?.accounts ?? null,
            jobsCreated: body.jobs?.created ?? null,
          });
        },
      },
    ];
    const travel = new TimeTravel({ clock, scheduler: fakes.scheduler, crons, afterStep: noteNewLeads });
    const scenario: ScenarioState = { accountId: null, ownerEmail: null, onboardingCompletedAt: null, ownerJar: null };

    const sim: Simulation = {
      clock,
      db,
      deps,
      fakes: { ...fakes, clock },
      timeZone,
      outboxDir: options.outboxDir,
      travel,
      scenario,
      local(text) {
        const time = DateTime.fromISO(text, { zone: timeZone });
        if (!time.isValid) throw new RangeError(`simulation: invalid local time ${text}`);
        return time.toJSDate();
      },
      declareLead(ref, lead) {
        if (!/^L[1-9]\d*$/.test(ref) || [...declared.values()].includes(ref)) throw new Error(`simulation: bad or repeated lead ref ${ref}`);
        declared.set(declaredLeadKey(lead.contactId, lead.submittedAt), ref);
      },
      record(kind, name, detail?: Detail) {
        record(kind, name, detail);
      },
      entries() {
        return timeline;
      },
      check(id, ok, detail) {
        checks.push({ id, stage: currentStage, ok, ...(detail !== undefined ? { detail } : {}) });
      },
      setWeeklyReport(report) {
        weeklyReport = report;
      },
    };

    for (const stage of stages) {
      currentStage = stage.id;
      const before = { steps: timeline.length, checks: checks.length };
      await stage.run(sim);
      stageSummaries.push({
        id: stage.id,
        milestone: stage.milestone,
        steps: timeline.length - before.steps,
        checks: checks.length - before.checks,
      });
    }

    const read = await readLeads(db, declared);
    const { leads } = read;
    // Leads gone by the end (purged with their account) keep the ref they were declared with.
    const refById = new Map(read.refById);
    for (const [id, key] of seenLeads) {
      const ref = key === null ? undefined : declared.get(key);
      if (!refById.has(id) && ref !== undefined) refById.set(id, ref);
    }
    for (const { index, leadId } of leadLinks) {
      const entry = timeline[index];
      if (entry?.detail !== undefined) entry.detail = { ...entry.detail, lead: refById.get(leadId) ?? null };
    }
    const emails = await summariseEmails(fakes.mailer.sent, refById, options.outboxDir);

    const summary: SimulationSummary = {
      scenario: options.scenario ?? SCENARIO,
      systemTime: options.systemTime ?? null,
      clock: { start: iso(SIMULATION_START), end: iso(clock.now()) },
      stages: stageSummaries,
      timeline,
      emails,
      leads,
      weeklyReport,
      checks,
      ok: checks.every((check) => check.ok),
    };
    await writeFile(path.join(options.outboxDir, SUMMARY_FILE), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    return summary;
  } finally {
    Settings.now = previousLuxonNow;
    if (owned) await db.close();
  }
}
