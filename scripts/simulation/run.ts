// Runs the simulation (PLAN §13, D-39): fakes, PGlite in memory, a FakeClock from Tue 2026-10-06
// 09:00 America/New_York. Never reads the wall clock and never calls a live service.
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DateTime, Settings } from 'luxon';
import { createFakeDeps } from '@/server/adapters/fake';
import { FakeClock } from '@/server/adapters/fake/clock';
import { outboxFileBase, type FakeSentMail } from '@/server/adapters/fake/mailer';
import { migrate } from '@/server/db/migrate';
import { createPgliteDb, type PgliteDb } from '@/server/db/pglite';
import { parseEnv } from '@/server/env';
import { STAGES } from './stages';
import type {
  CheckResult,
  Detail,
  EmailSummary,
  LeadSummary,
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

/** The leads in stable order, labelled L1…Ln, and the map from lead id to label. */
async function readLeads(db: PgliteDb): Promise<{ leads: LeadSummary[]; refById: ReadonlyMap<string, string> }> {
  const rows = await db.query<{
    id: string;
    hubspot_contact_id: string | null;
    form_id: string | null;
    submitted_at: Date;
    intake_trigger: string;
    is_test: boolean;
    classification: string | null;
    processing_state: string;
    stop_reason: string | null;
  }>(
    `select id, hubspot_contact_id, form_id, submitted_at, intake_trigger, is_test, classification, processing_state, stop_reason
       from public.leads order by submitted_at, hubspot_contact_id nulls last, form_id nulls last, is_test`,
  );
  const refById = new Map(rows.map((row, index) => [row.id, `L${index + 1}`]));
  const leads = rows.map((row, index) => ({
    ref: `L${index + 1}`,
    hubspotContactId: row.hubspot_contact_id,
    formId: row.form_id,
    submittedAt: iso(row.submitted_at),
    intakeTrigger: row.intake_trigger,
    isTest: row.is_test,
    classification: row.classification,
    processingState: row.processing_state,
    stopReason: row.stop_reason,
  }));
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
    const { deps, fakes } = createFakeDeps({
      env,
      db,
      clock,
      mailSink: { kind: 'directory', dir: options.outboxDir },
      elapse: (ms) => {
        clock.advance(ms);
      },
    });
    const timeZone = fakes.hubspot.portal.timeZone;

    const timeline: TimelineEntry[] = [];
    const checks: CheckResult[] = [];
    const stageSummaries: StageSummary[] = [];
    let weeklyReport: unknown = null;
    let currentStage = '';

    const sim: Simulation = {
      clock,
      db,
      deps,
      fakes: { ...fakes, clock },
      timeZone,
      outboxDir: options.outboxDir,
      record(kind, name, detail?: Detail) {
        const now = clock.now();
        timeline.push({
          at: iso(now),
          local: DateTime.fromJSDate(now, { zone: timeZone }).toFormat('ccc yyyy-LL-dd HH:mm:ss'),
          stage: currentStage,
          kind,
          name,
          ...(detail !== undefined ? { detail } : {}),
        });
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

    const { leads, refById } = await readLeads(db);
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
