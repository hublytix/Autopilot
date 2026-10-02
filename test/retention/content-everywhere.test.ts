import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@/server/db';
import { runRetentionGuard } from '@/server/http/cron-poll';
import { createJobHandlerRegistries } from '@/server/jobs/handlers';
import { createJobTestRig, seedAccount, seedSettings, type JobTestRig } from '@/server/jobs/testing';
import { seedInstalledConnection, seedOwner, seedSelectedForm } from '@/server/services/accounts/testing';
import { seedBrief } from '@/server/services/drafting/testing';
import type { Sleep } from '@/server/services/hubspot';
import { pollPortal } from '@/server/services/intake';
import { useTestDb as setUpTestDb } from '../db/harness';

// Law 4 / D-49 (PLAN §9.10 step 8, review #19): lead content never outlives 30 d + 1 h ANYWHERE, not
// just in the two content tables. A lead goes through the real pipeline (a form submission on the
// fake portal → the poll → lead_process: classification, the draft, the owner's email, the
// follow-up schedule → the follow-ups as they come due), then the retention guard runs once its
// purge time has passed, and every table of `public` and `fake` is scanned for the lead's text,
// name, company, address and the drafts as they were stored. A table that copied any of it (job
// payloads, notification rows, AI call logs, webhook events, audit meta…) fails this test.

const getDb = setUpTestDb();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const SUBMISSION = {
  email: 'Zanele.Mokoena@kwela-joinery.example',
  firstName: 'Zanele',
  lastName: 'Mokoena',
  company: 'Kwela Joinery',
  message: 'Our workshop doors keep sticking in the damp; could you quote for rehanging all four of them next week?',
} as const;

let rig: JobTestRig;
let sleep: Sleep;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  const box: { rig?: JobTestRig } = {};
  sleep = async (ms) => {
    box.rig?.clock.advance(ms);
  };
  rig = createJobTestRig(getDb(), createJobHandlerRegistries({ limiterSleep: sleep }).jobs);
  box.rig = rig;
  for (const method of ['info', 'warn', 'error', 'log'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Every `schema.table` whose rows contain any needle (case-insensitive). */
async function tablesHolding(db: Db, needles: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  const tables = await db.query<{ table_schema: string; table_name: string }>(
    `select table_schema, table_name from information_schema.tables
      where table_schema in ('public', 'fake') and table_type = 'BASE TABLE' order by table_schema, table_name`,
  );
  for (const { table_schema: schema, table_name: table } of tables) {
    const rows = await db.query<{ row: string }>(`select row_to_json(t)::text as row from ${schema}."${table}" t`);
    const text = rows.map((r) => r.row.toLowerCase()).join('\n');
    if (needles.some((needle) => text.includes(needle.toLowerCase()))) found.push(`${schema}.${table}`);
  }
  return found;
}

describe('no lead content anywhere after 30 days + 1 hour (law 4, D-49)', () => {
  it('a lead drafted, emailed and followed up through the real pipeline leaves none of its text in any table once retention has run', async () => {
    const db = getDb();
    const hubspot = rig.fakes.hubspot;
    const now = rig.clock.now();
    const accountId = await seedAccount(db, { now });
    await seedSettings(db, { accountId, now });
    await seedOwner(db, accountId);
    await seedInstalledConnection(rig.deps, hubspot, { accountId, now });
    const formId = hubspot.formIdByName('Contact us');
    await seedSelectedForm(db, { accountId, formId, floor: now });
    await seedBrief(db, accountId);
    rig.clock.advance(MINUTE);

    const submittedAt = rig.clock.now();
    hubspot.submitForm({ formId, ...SUBMISSION, at: submittedAt, newContact: true });
    expect(await pollPortal(rig.deps, accountId, 'cron', { sleep })).toMatchObject({ status: 'polled', counts: { leadsCreated: 1 } });
    rig.clock.advance({ seconds: 5 });
    await rig.fakes.scheduler.runDue();

    const lead = await db.one<{ id: string; processing_state: string }>(`select id, processing_state from leads where account_id = $1`, [accountId]);
    expect(lead.processing_state).toBe('notified');
    expect(rig.fakes.mailer.sent.map((mail) => mail.kind)).toContain('new_lead');

    // Let the follow-ups come due (each drafts and stores more content), a day at a time.
    for (let day = 1; day <= 6; day += 1) {
      rig.clock.set(new Date(submittedAt.getTime() + day * DAY));
      await rig.fakes.scheduler.runDue();
    }
    const drafts = await db.query<{ subject: string | null; body: string | null }>(`select subject, body from drafts where lead_id = $1 and body is not null`, [lead.id]);
    expect(drafts.length).toBeGreaterThanOrEqual(2);
    const needles: string[] = [SUBMISSION.email, SUBMISSION.message.slice(0, 60), `${SUBMISSION.firstName} ${SUBMISSION.lastName}`, SUBMISSION.lastName, SUBMISSION.company];
    for (const draft of drafts) {
      if (draft.subject !== null && draft.subject.length >= 12) needles.push(draft.subject);
      if (draft.body !== null) needles.push(draft.body.slice(0, 80));
    }
    // The needles are really stored before the purge (so the scan below can find a copy).
    expect(await tablesHolding(db, needles)).toEqual(expect.arrayContaining(['public.drafts', 'public.lead_messages']));

    // 30 days + 1 hour after the submission: the retention guard (the poll cron's) has run.
    rig.clock.set(new Date(submittedAt.getTime() + 30 * DAY + 60 * MINUTE));
    await rig.fakes.scheduler.runDue();
    expect(await runRetentionGuard(rig.deps)).toMatchObject({ ran: true, leadMessagesDeleted: 1 });
    expect(await tablesHolding(db, needles)).toEqual([]);
  });
});
