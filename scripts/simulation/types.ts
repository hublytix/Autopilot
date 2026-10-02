// Shapes of the simulation (PLAN §13, D-39, D-50). The run is a list of stages; each milestone
// appends its stages (steps that drive the fakes and the app) and the checks it enables.
import type { FakeClock } from '@/server/adapters/fake/clock';
import type { FakeAdapters } from '@/server/adapters/fake';
import type { PgliteDb } from '@/server/db/pglite';
import type { Deps } from '@/server/ports';
import type { CookieJar } from '@/server/security/cookies';
import type { TimeTravel } from './engine';

export type Milestone = 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'M6' | 'M7' | 'M8';

/** A JSON value small enough to read in summary.json. */
export type DetailValue = string | number | boolean | null | readonly string[];
export type Detail = Readonly<Record<string, DetailValue>>;

/**
 * One step, tick, intake trigger or job delivery, at the simulated time it happened.
 * - `step`: something the scenario did (an install, an owner action, a form submission);
 * - `tick`: a periodic trigger (PLAN §8.1) and what it did;
 * - `intake`: a webhook delivery, and every lead created (with the trigger that found it);
 * - `job`: one delivery of a job to runJob (as QStash would call /api/jobs/run) or a failure callback.
 */
export interface TimelineEntry {
  /** ISO-8601 UTC, from the FakeClock. */
  at: string;
  /** The same instant in the portal's time zone, for reading (`ccc yyyy-LL-dd HH:mm:ss`). */
  local: string;
  stage: string;
  kind: 'step' | 'tick' | 'intake' | 'job';
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
 * summary.json differ from run to run. `ref` is a stable label: the scenario's own number for the
 * submissions it declares (`L5` is submission #5, whenever it arrives), then `L{n}` for any other
 * lead in the order (submitted_at, hubspot_contact_id, form_id). Emails and timeline entries name
 * their lead by the same ref. The onboarding test lead is never listed (PLAN §13), so `isTest` is
 * always false here.
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
  /**
   * The Monday report's `weekly_reports.metrics` (M6), with each waiting lead's id replaced by its
   * ref (`L2`) so the summary stays the same from run to run; null when the scenario has no Monday.
   */
  weeklyReport: unknown;
  checks: CheckResult[];
  ok: boolean;
}

/** What the stages share about the scenario's account (set by the seed / onboarding stage). */
export interface ScenarioState {
  accountId: string | null;
  /** The bound owner's login email. */
  ownerEmail: string | null;
  /** When onboarding completed: the intake floors (PLAN §13 "floors equal the onboarding-complete time"). */
  onboardingCompletedAt: Date | null;
  /** The owner's browser (the session cookie set by /auth/confirm); later stages open the dashboard with it. */
  ownerJar: CookieJar | null;
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
  /** Time travel: `travel.at(time, name, fn)` schedules an external event, `travel.advanceTo(t)` runs everything up to t. */
  readonly travel: TimeTravel;
  readonly scenario: ScenarioState;
  /** The local time `iso` (e.g. `2026-10-06T10:00`) in the portal's time zone, as an instant. */
  local(iso: string): Date;
  /** Names the lead a scenario submission will create (`L1` for #1): by its contact and submission time. */
  declareLead(ref: string, lead: { contactId: string; submittedAt: Date }): void;
  /** Records a timeline entry at the current simulated time. */
  record(kind: TimelineEntry['kind'], name: string, detail?: Detail): void;
  /** The timeline so far (lead refs are filled in only at the end of the run). */
  entries(): readonly TimelineEntry[];
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
