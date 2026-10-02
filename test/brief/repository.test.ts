import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@/server/adapters/fake/clock';
import { seedAccount } from '@/server/jobs/testing';
import type { BriefDraft } from '@/server/ports/llm';
import { createOwnerScopeForTest, type OwnerScope } from '@/server/services/auth';
import {
  getBriefVersion,
  getLatestBrief,
  hasOwnerSavedBrief,
  insertGeneratedVersion,
  listBriefVersions,
  saveOwnerBrief,
} from '@/server/services/brief/repository';
import { EMPTY_BRIEF } from '@/server/services/brief/schema';
import { useTestDb as setUpTestDb } from '../db/harness';

// Brief versions and the editor state (brief §5.3, PLAN §5, §6.1, §7.5): owner saves, generated
// versions, numbering, history and what the editor opens with. Owner-scoped reads never cross accounts.

const getDb = setUpTestDb();
const START = new Date('2026-10-06T13:00:00.000Z');
const BOOKING = 'https://cal.example.com/brightside/visit';

let clock: FakeClock;
let deps: { db: ReturnType<typeof getDb>; clock: FakeClock };
let accountId: string;
let scope: OwnerScope;

beforeEach(async () => {
  clock = new FakeClock(START);
  deps = { db: getDb(), clock };
  accountId = await seedAccount(getDb(), { now: START, processingState: 'onboarding' });
  scope = createOwnerScopeForTest(accountId, randomUUID());
});

function brief(overrides: Partial<BriefDraft> = {}): BriefDraft {
  return {
    company_name: 'Brightside Plumbing',
    one_line: 'Family-run plumbers in Riverton.',
    services: ['Emergency repairs'],
    who_we_serve: 'Homeowners',
    booking_link: BOOKING,
    tone: { style: 'friendly', note: '' },
    sign_off_name: 'Dana Whitfield',
    allow_pricing: false,
    never_promise: [],
    faqs: [],
    ...overrides,
  };
}

function ownerForm(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...brief(), booking_link_choice: 'link', booking_link: BOOKING, booking_link_confirmed: true, ...overrides };
}

async function generated(overrides: Partial<BriefDraft> = {}): Promise<number> {
  return getDb().tx((tx) => insertGeneratedVersion(tx, { accountId, brief: brief(overrides), sourceUrl: 'https://brightside-plumbing.example/', now: clock.now() }));
}

describe('saveOwnerBrief', () => {
  it('saves the first brief as version 1 (source owner) and makes it the brief in force', async () => {
    const result = await saveOwnerBrief(scope, deps, ownerForm());
    expect(result).toMatchObject({ ok: true, version: { version: 1, source: 'owner', bookingLinkChoice: 'link', bookingLinkConfirmed: true, bookingLinkHost: 'cal.example.com' } });
    const row = await getDb().one(`select brief, booking_link_choice, booking_link_confirmed, version from briefs where account_id = $1`, [accountId]);
    expect(row).toEqual({ brief: brief(), booking_link_choice: 'link', booking_link_confirmed: true, version: 1 });
    expect(await hasOwnerSavedBrief(getDb(), accountId)).toBe(true);
  });

  it('numbers versions across both sources and never lets a generated version replace the brief in force', async () => {
    expect(await generated()).toBe(1);
    clock.advance(60_000);
    await saveOwnerBrief(scope, deps, ownerForm({ company_name: 'Brightside Plumbing Co.' }));
    clock.advance(60_000);
    expect(await generated({ company_name: 'Regenerated' })).toBe(3);
    clock.advance(60_000);
    await saveOwnerBrief(scope, deps, ownerForm({ booking_link_choice: 'none', booking_link: null, booking_link_confirmed: false }));

    expect((await listBriefVersions(scope, deps)).map((v) => [v.version, v.source])).toEqual([
      [4, 'owner'],
      [3, 'generated'],
      [2, 'owner'],
      [1, 'generated'],
    ]);
    const inForce = await getDb().one<{ brief: BriefDraft; booking_link_choice: string; version: number }>(
      `select brief, booking_link_choice, version from briefs where account_id = $1`,
      [accountId],
    );
    expect(inForce).toMatchObject({ booking_link_choice: 'none', version: 4, brief: { booking_link: null, company_name: 'Brightside Plumbing' } });
    expect((await getBriefVersion(scope, deps, 3))?.brief.company_name).toBe('Regenerated');
  });

  it('keeps the brief in force while only generated versions arrive', async () => {
    await saveOwnerBrief(scope, deps, ownerForm({ company_name: 'Saved name' }));
    await generated({ company_name: 'Generated name' });
    const row = await getDb().one<{ brief: BriefDraft }>(`select brief from briefs where account_id = $1`, [accountId]);
    expect(row.brief.company_name).toBe('Saved name');
  });

  it('refuses an invalid form with field codes and writes nothing', async () => {
    const result = await saveOwnerBrief(scope, deps, ownerForm({ booking_link: 'http://cal.example.com/x', company_name: '', faqs: [{ q: 'Q?', a: '' }] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual(
      expect.arrayContaining([
        { path: 'company_name', code: 'required' },
        { path: 'faqs.0.a', code: 'required' },
      ]),
    );
    expect(await getDb().query(`select id from brief_versions`)).toEqual([]);
    expect(await hasOwnerSavedBrief(getDb(), accountId)).toBe(false);
  });

  it('refuses a link the owner has not confirmed, and the "unset" choice', async () => {
    const unconfirmed = await saveOwnerBrief(scope, deps, ownerForm({ booking_link_confirmed: false }));
    expect(unconfirmed).toEqual({ ok: false, issues: [{ path: 'booking_link_confirmed', code: 'booking_link_not_confirmed' }] });
    const unset = await saveOwnerBrief(scope, deps, ownerForm({ booking_link_choice: 'unset' }));
    expect(unset).toMatchObject({ ok: false, issues: [{ path: 'booking_link_choice', code: 'booking_link_choice_required' }] });
  });
});

describe('getLatestBrief', () => {
  it('starts empty, with the full daily allowance', async () => {
    expect(await getLatestBrief(scope, deps)).toEqual({
      latest: null,
      saved: null,
      job: null,
      sourceUrl: null,
      form: { brief: EMPTY_BRIEF, origin: 'empty', version: null },
      generation: { inProgress: false, remainingToday: 5 },
    });
  });

  it('opens the newest generated version until the owner saves, then the newest version of either source', async () => {
    await generated();
    expect((await getLatestBrief(scope, deps)).form).toMatchObject({ origin: 'generated', version: 1 });
    clock.advance(1000);
    await saveOwnerBrief(scope, deps, ownerForm({ one_line: 'Edited.' }));
    const state = await getLatestBrief(scope, deps);
    expect(state.form).toMatchObject({ origin: 'owner', version: 2, brief: { one_line: 'Edited.' } });
    expect(state.saved?.version).toBe(2);
  });

  it('falls back to the saved brief when a later regeneration failed', async () => {
    await saveOwnerBrief(scope, deps, ownerForm());
    clock.advance(60_000);
    await getDb().query(`insert into brief_jobs (account_id, status, attempts, error_code, created_at, finished_at) values ($1, 'failed', 1, 'llm_refusal', $2, $2)`, [
      accountId,
      clock.now(),
    ]);
    const state = await getLatestBrief(scope, deps);
    expect(state.job).toMatchObject({ status: 'failed', errorCode: 'llm_refusal' });
    expect(state.form).toMatchObject({ origin: 'owner', version: 1 });
    expect(state.generation.remainingToday).toBe(4);
  });

  it('never shows another account’s brief', async () => {
    await saveOwnerBrief(scope, deps, ownerForm());
    const other = createOwnerScopeForTest(await seedAccount(getDb(), { now: START }), randomUUID());
    expect((await getLatestBrief(other, deps)).latest).toBeNull();
    expect(await listBriefVersions(other, deps)).toEqual([]);
    expect(await getBriefVersion(other, deps, 1)).toBeNull();
  });
});
