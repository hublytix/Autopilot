// Shapes of the simulation (PLAN §13, D-39, D-50). The run is a list of stages; each milestone
// appends its stages (steps that drive the fakes and the app) and the checks it enables.
import type { FakeClock } from '@/server/adapters/fake/clock';
import type { FakeAdapters } from '@/server/adapters/fake';
import type { PgliteDb } from '@/server/db/pglite';
import type { Deps } from '@/server/ports';

export type Milestone = 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'M6' | 'M7' | 'M8';

/** A JSON value small enough to read in summary.json. */
export type DetailValue = string | number | boolean | null | readonly string[];
export type Detail = Readonly<Record<string, DetailValue>>;

/** One step, tick or intake trigger, at the simulated time it happened. */
export interface TimelineEntry {
  /** ISO-8601 UTC, from the FakeClock. */
  at: string;
  /** The same instant in the portal's time zone, for reading (`ccc yyyy-LL-dd HH:mm:ss`). */
  local: string;
  stage: string;
  kind: 'step' | 'tick' | 'intake';
  name: string;
  detail?: Detail;
}

export interface CheckResult {
  id: string;
  stage: string;
  ok: boolean;
  /** What was expected and what happened, without content (no message text, no tokens). */
  detail?: string;
}

export interface EmailSummary {
  seq: number;
  at: string;
  kind: string;
  /** The lead's `ref` when the email's `lead` tag names a lead id; the tag as given otherwise. */
  lead: string | null;
  to: string[];
  subject: string;
  /** `NNN-<kind>[-<lead ref>]`: the .html and .txt files in the outbox directory (renamed from the lead id). */
  file: string;
}

/**
 * A lead as summary.json shows it. No database ids: leads.id is gen_random_uuid(), so it would make
 * summary.json differ from run to run. `ref` is a stable label (`L1`, `L2`, …) in the order
 * (submitted_at, hubspot_contact_id, form_id, is_test); emails name their lead by the same ref.
 */
export interface LeadSummary {
  ref: string;
  hubspotContactId: string | null;
  formId: string | null;
  submittedAt: string;
  intakeTrigger: string;
  isTest: boolean;
  classification: string | null;
  processingState: string;
  stopReason: string | null;
}

export interface StageSummary {
  id: string;
  milestone: Milestone;
  steps: number;
  checks: number;
}

export interface SimulationSummary {
  scenario: string;
  /**
   * SIMULATE_SYSTEM_TIME as given (e.g. `2030`), recorded only: the simulation never reads the wall
   * clock, so its output must not depend on it (PLAN §13 "repeated with the system time set to 2030").
   */
  systemTime: string | null;
  clock: { start: string; end: string };
  stages: StageSummary[];
  timeline: TimelineEntry[];
  emails: EmailSummary[];
  leads: LeadSummary[];
  /** The Monday report's metrics once M6 enables it. */
  weeklyReport: unknown;
  checks: CheckResult[];
  ok: boolean;
}

/** What every stage works with. */
export interface Simulation {
  readonly clock: FakeClock;
  readonly db: PgliteDb;
  readonly deps: Deps;
  readonly fakes: FakeAdapters & { readonly clock: FakeClock };
  /** The portal's IANA time zone (the fixture's `America/New_York`). */
  readonly timeZone: string;
  readonly outboxDir: string;
  /** Records a timeline entry at the current simulated time. */
  record(kind: TimelineEntry['kind'], name: string, detail?: Detail): void;
  /** Records a check result; any failed check makes the run fail (exit 1). */
  check(id: string, ok: boolean, detail?: string): void;
  /** Set by the stage that produces the Monday report (M6). */
  setWeeklyReport(report: unknown): void;
}

export interface Stage {
  /** Short id, e.g. `boot`, `pre-run`, `day-0`. */
  id: string;
  /** The milestone that added this stage (D-50: CI runs the stages and checks enabled so far). */
  milestone: Milestone;
  run(sim: Simulation): Promise<void>;
}
