import 'server-only';
import { z } from 'zod';
import { BOOKING_LINK_CHOICES, BRIEF_JOB_STATUSES, BRIEF_SOURCES, type BookingLinkChoice, type BriefJobStatus, type BriefSource } from '@/server/domain/types';
import type { Db } from '@/server/db';
import type { Deps } from '@/server/ports';
import type { BriefDraft } from '@/server/ports/llm';
import type { OwnerScope } from '@/server/services/auth';
import { bookingLinkHost } from './booking-link';
import { BRIEF_JOBS_PER_DAY, BRIEF_RATE_WINDOW_MS } from './limits';
import { briefFieldIssues, EMPTY_BRIEF, OwnerBriefInputSchema, StoredBriefSchema, type BriefFieldIssue } from './schema';

// Briefs and their versions (brief §5.3, PLAN §5, §6.1, §7.5).
// - `brief_versions` keeps every version: `generated` (from a brief_generate job, booking link not
//   confirmed) and `owner` (saved from the editor). Version numbers are per account, 1, 2, 3, …,
//   allocated by `briefs.version`, which is the highest number handed out so far.
// - `briefs.brief`, `booking_link_choice` and `booking_link_confirmed` are the brief in force: the
//   owner's latest save. A generated version never replaces it, so regenerating cannot change
//   what drafts use until the owner saves again. `booking_link_choice = 'unset'` means no save yet.
// - `briefs.source_url` is the website the owner last asked to generate from.
// Owner-facing functions take the OwnerScope first and read only that account's rows.

export interface BriefVersionView {
  version: number;
  source: BriefSource;
  brief: BriefDraft;
  sourceUrl: string | null;
  bookingLinkChoice: BookingLinkChoice;
  bookingLinkConfirmed: boolean;
  /** The booking link's host for the confirmation step (ASCII; null without a usable link). */
  bookingLinkHost: string | null;
  createdAt: Date;
}

export interface BriefJobView {
  id: string;
  /** `queued`/`running` only while its scheduled job can still run; a job lost without its failure path reads `failed`. */
  status: BriefJobStatus;
  /** Machine-readable, e.g. `llm_refusal` or `site_robots_disallowed`. */
  errorCode: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface BriefEditorState {
  /** The newest version of either source. */
  latest: BriefVersionView | null;
  /** The owner's newest save: the brief in force. */
  saved: BriefVersionView | null;
  /** The newest generation request. */
  job: BriefJobView | null;
  sourceUrl: string | null;
  /**
   * What the editor opens with: the newest version, unless the newest generation failed after it
   * (then the saved brief, or the empty form on a first run, PLAN §9.7).
   */
  form: { brief: BriefDraft; origin: 'generated' | 'owner' | 'empty'; version: number | null };
  generation: { inProgress: boolean; remainingToday: number };
}

const versionRow = z.object({
  version: z.number().int(),
  source: z.enum(BRIEF_SOURCES),
  brief: z.unknown(),
  source_url: z.string().nullable(),
  booking_link_choice: z.enum(BOOKING_LINK_CHOICES),
  booking_link_confirmed: z.boolean(),
  created_at: z.date(),
});

const jobRow = z.object({
  id: z.string(),
  status: z.enum(BRIEF_JOB_STATUSES),
  error_code: z.string().nullable(),
  created_at: z.date(),
  finished_at: z.date().nullable(),
  job_live: z.boolean(),
});

const VERSION_COLUMNS = 'version, source, brief, source_url, booking_link_choice, booking_link_confirmed, created_at';

function toVersionView(raw: unknown): BriefVersionView | null {
  const row = versionRow.parse(raw);
  const brief = StoredBriefSchema.safeParse(row.brief);
  if (!brief.success) return null;
  return {
    version: row.version,
    source: row.source,
    brief: brief.data,
    sourceUrl: row.source_url,
    bookingLinkChoice: row.booking_link_choice,
    bookingLinkConfirmed: row.booking_link_confirmed,
    bookingLinkHost: bookingLinkHost(brief.data.booking_link),
    createdAt: row.created_at,
  };
}

/** SQL: the brief_generate job of brief job `b` can still run (scheduled or running). */
export const BRIEF_JOB_LIVE_SQL = `exists (
  select 1 from scheduled_jobs j
   where j.dedupe_key = 'brief:' || b.account_id || ':' || b.id and j.status in ('scheduled', 'running'))`;

/** The newest brief job of an account (any caller; the owner view goes through getLatestBrief). */
export async function latestBriefJob(db: Db, accountId: string): Promise<BriefJobView | null> {
  const raw = await db.maybeOne(
    `select b.id, b.status, b.error_code, b.created_at, b.finished_at, ${BRIEF_JOB_LIVE_SQL} as job_live
       from brief_jobs b where b.account_id = $1
      order by b.created_at desc, b.id desc limit 1`,
    [accountId],
  );
  if (raw === null) return null;
  const row = jobRow.parse(raw);
  const pending = row.status === 'queued' || row.status === 'running';
  return {
    id: row.id,
    status: pending && !row.job_live ? 'failed' : row.status,
    errorCode: pending && !row.job_live ? (row.error_code ?? 'job_lost') : row.error_code,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

/** Generations left in the rolling day and whether one is running (D-36). */
export async function briefGenerationAllowance(db: Db, accountId: string, now: Date): Promise<{ inProgress: boolean; remainingToday: number }> {
  const row = await db.one<{ recent: number; in_progress: boolean }>(
    `select (select count(*)::int from brief_jobs where account_id = $1 and created_at > $2) as recent,
            exists (select 1 from brief_jobs b where b.account_id = $1 and b.status in ('queued', 'running') and ${BRIEF_JOB_LIVE_SQL}) as in_progress`,
    [accountId, new Date(now.getTime() - BRIEF_RATE_WINDOW_MS)],
  );
  return { inProgress: row.in_progress, remainingToday: Math.max(0, BRIEF_JOBS_PER_DAY - row.recent) };
}

/** Whether the account has an owner-saved brief with a booking-link decision (the onboarding gate, PLAN §6.1). */
export async function hasOwnerSavedBrief(db: Db, accountId: string): Promise<boolean> {
  const row = await db.maybeOne(
    `select 1 from brief_versions where account_id = $1 and source = 'owner' and booking_link_choice <> 'unset' limit 1`,
    [accountId],
  );
  return row !== null;
}

/** The brief editor's state for the owner's account. */
export async function getLatestBrief(scope: OwnerScope, deps: Pick<Deps, 'db' | 'clock'>): Promise<BriefEditorState> {
  const { db } = deps;
  const accountId = scope.accountId;
  const latestRaw = await db.maybeOne(`select ${VERSION_COLUMNS} from brief_versions where account_id = $1 order by version desc limit 1`, [accountId]);
  const savedRaw = await db.maybeOne(
    `select ${VERSION_COLUMNS} from brief_versions where account_id = $1 and source = 'owner' order by version desc limit 1`,
    [accountId],
  );
  const briefRow = await db.maybeOne<{ source_url: string | null }>(`select source_url from briefs where account_id = $1`, [accountId]);
  const latest = latestRaw === null ? null : toVersionView(latestRaw);
  const saved = savedRaw === null ? null : toVersionView(savedRaw);
  const job = await latestBriefJob(db, accountId);
  const generation = await briefGenerationAllowance(db, accountId, deps.clock.now());

  // A generation that failed after the newest version leaves the editor on the saved brief, or empty.
  const failedSinceLatest = job !== null && job.status === 'failed' && (latest === null || job.createdAt.getTime() > latest.createdAt.getTime());
  const start = failedSinceLatest ? saved : latest;
  const form: BriefEditorState['form'] =
    start === null ? { brief: EMPTY_BRIEF, origin: 'empty', version: null } : { brief: start.brief, origin: start.source, version: start.version };
  return { latest, saved, job, sourceUrl: briefRow?.source_url ?? null, form, generation };
}

export interface BriefVersionSummary {
  version: number;
  source: BriefSource;
  createdAt: Date;
}

/** The version history, newest first. */
export async function listBriefVersions(scope: OwnerScope, deps: Pick<Deps, 'db'>, options: { limit?: number } = {}): Promise<BriefVersionSummary[]> {
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 200);
  const rows = await deps.db.query<{ version: number; source: BriefSource; created_at: Date }>(
    `select version, source, created_at from brief_versions where account_id = $1 order by version desc limit $2`,
    [scope.accountId, limit],
  );
  return rows.map((row) => ({ version: row.version, source: row.source, createdAt: row.created_at }));
}

/** One version of the owner's brief, or null. */
export async function getBriefVersion(scope: OwnerScope, deps: Pick<Deps, 'db'>, version: number): Promise<BriefVersionView | null> {
  if (!Number.isInteger(version) || version < 1) return null;
  const raw = await deps.db.maybeOne(`select ${VERSION_COLUMNS} from brief_versions where account_id = $1 and version = $2`, [scope.accountId, version]);
  return raw === null ? null : toVersionView(raw);
}

export type SaveOwnerBriefResult = { ok: true; version: BriefVersionView } | { ok: false; issues: BriefFieldIssue[] };

/**
 * Saves the owner's brief (brief §5.3, PLAN §7.5): validates it, then in one statement makes it the
 * brief in force and appends it to the history as the next `owner` version.
 */
export async function saveOwnerBrief(scope: OwnerScope, deps: Pick<Deps, 'db' | 'clock'>, input: unknown): Promise<SaveOwnerBriefResult> {
  const parsed = OwnerBriefInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: briefFieldIssues(parsed.error) };
  const { brief, bookingLinkChoice, bookingLinkConfirmed } = parsed.data;
  const now = deps.clock.now();
  const raw = await deps.db.one(
    `with b as (
       insert into briefs (account_id, brief, booking_link_choice, booking_link_confirmed, version, updated_at)
       values ($1, $2::jsonb, $3, $4, 1, $5)
       on conflict (account_id) do update
         set brief = excluded.brief, booking_link_choice = excluded.booking_link_choice,
             booking_link_confirmed = excluded.booking_link_confirmed, version = briefs.version + 1, updated_at = excluded.updated_at
       returning id, version, source_url
     )
     insert into brief_versions (brief_id, account_id, version, source, brief, source_url, booking_link_choice, booking_link_confirmed, created_at)
     select b.id, $1, b.version, 'owner', $2::jsonb, b.source_url, $3, $4, $5 from b
     returning ${VERSION_COLUMNS}`,
    [scope.accountId, brief, bookingLinkChoice, bookingLinkConfirmed, now],
  );
  const version = toVersionView(raw);
  if (version === null) throw new Error('brief_version_unreadable');
  return { ok: true, version };
}

/**
 * Appends a generated version (inside the job's transaction). The brief in force is untouched; the
 * booking link, if any, waits for the owner's confirmation.
 */
export async function insertGeneratedVersion(tx: Db, input: { accountId: string; brief: BriefDraft; sourceUrl: string; now: Date }): Promise<number> {
  const row = await tx.one<{ version: number }>(
    `with b as (
       insert into briefs (account_id, version, source_url) values ($1, 1, $3)
       on conflict (account_id) do update set version = briefs.version + 1
       returning id, version
     )
     insert into brief_versions (brief_id, account_id, version, source, brief, source_url, booking_link_choice, booking_link_confirmed, created_at)
     select b.id, $1, b.version, 'generated', $2::jsonb, $3, $4, false, $5 from b
     returning version`,
    [input.accountId, input.brief, input.sourceUrl, input.brief.booking_link === null ? 'unset' : 'link', input.now],
  );
  return row.version;
}
