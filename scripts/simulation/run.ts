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
import { CRON_POLL_PATH, handleCronPoll } from '@/server/http/cron-poll';
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

/** The poll cron as Vercel Cron calls it: `GET /api/cron/poll` with `Authorization: Bearer CRON_SECRET`. */
function cronPollRequest(env: Env): Request {
  return new Request(`${env.APP_URL}${CRON_POLL_PATH}`, { headers: { authorization: `Bearer ${env.CRON_SECRET}` } });
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
    const env = parseEnv({ APP_MODE: 'fake' });

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

    // Every lead the run creates is noted once, with the trigger that found it (PLAN §13).
    const seenLeads = new Set<string>();
    const noteNewLeads = async (): Promise<void> => {
      const rows = await db.query<{ id: string; intake_trigger: string; is_test: boolean }>(
        `select id, intake_trigger, is_test from public.leads order by received_at, submitted_at, hubspot_contact_id nulls last`,
      );
      for (const row of rows) {
        if (seenLeads.has(row.id)) continue;
        seenLeads.add(row.id);
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
    const dispatch = async (delivery: FakeDelivery): Promise<{ status: number; headers: Headers }> => {
      const result = await bridge.dispatch(delivery);
      const row = await jobRow(delivery.jobId);
      record(
        'job',
        `job.${delivery.kind}`,
        { lead: null, retried: delivery.retried, httpStatus: result.status, jobStatus: row?.status ?? null },
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

    // PLAN §8.1 periodic triggers. The weekly-report due-check (M6) and the daily run (M7) have no
    // handler yet: their ticks are recorded so the timeline already shows the full schedule.
    const crons: CronSeries[] = [
      {
        name: 'cron.poll',
        next: EVERY_5_MINUTES,
        run: async () => {
          const response = await handleCronPoll(cronPollRequest(env), deps, {
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
        run: async () => {
          record('tick', 'cron.weekly_report', { handler: 'none_until_m6' });
        },
      },
      {
        name: 'cron.daily',
        next: DAILY_0317_UTC,
        run: async () => {
          record('tick', 'cron.daily', { handler: 'none_until_m7' });
        },
      },
    ];
    const travel = new TimeTravel({ clock, scheduler: fakes.scheduler, crons, afterStep: noteNewLeads });
    const scenario: ScenarioState = { accountId: null, ownerEmail: null, onboardingCompletedAt: null };

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

    const { leads, refById } = await readLeads(db, declared);
    for (const { index, leadId } of leadLinks) {
      const entry = timeline[index];
      if (entry?.detail !== undefined) entry.detail = { ...entry.detail, lead: refById.get(leadId) ?? null };
    }
    const emails = await summariseEmails(fakes.mailer.sent, refById, options.outboxDir);

    const summary: SimulationSummary = {
      scenario: SCENARIO,
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
