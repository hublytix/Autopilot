import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDb } from './harness';

// Row-level rules the schema enforces beyond status value lists (PLAN §5, D-46).

const NOW = new Date('2026-10-06T13:00:00.000Z');

describe('settings constraints', () => {
  const getDb = useTestDb();
  let accountId: string;

  beforeEach(async () => {
    const account = await getDb().one<{ id: string }>(
      `insert into public.accounts
         (hubspot_portal_id, processing_state_changed_at, trial_started_at, trial_ends_at, last_install_at, created_at)
       values ('9001', $1, $1, $1, $1, $1) returning id`,
      [NOW],
    );
    accountId = account.id;
  });

  async function insertSettings(notify: string[], verified: string[], savedAt: Date | null): Promise<unknown> {
    return getDb()
      .query('insert into public.settings (account_id, notify_emails, notify_emails_verified, preferences_saved_at) values ($1, $2, $3, $4)', [
        accountId,
        notify,
        verified,
        savedAt,
      ])
      .then(
        () => null,
        (error: unknown) => error,
      );
  }

  it.each<[string, string[], string[], Date | null]>([
    ['no addresses before preferences are saved', [], [], null],
    ['one address, unverified', ['owner@example.com'], [], NOW],
    ['three addresses, two verified', ['a@example.com', 'b@example.com', 'c@example.com'], ['a@example.com', 'c@example.com'], NOW],
  ])('accepts %s', async (_name, notify, verified, savedAt) => {
    expect(await insertSettings(notify, verified, savedAt)).toBeNull();
  });

  it.each<[string, string[], string[], Date | null, string]>([
    ['no address once preferences are saved (1–3)', [], [], NOW, 'settings_notify_emails_count_check'],
    ['four addresses', ['a@x.example', 'b@x.example', 'c@x.example', 'd@x.example'], [], NOW, 'settings_notify_emails_count_check'],
    ['four addresses even before saving', ['a@x.example', 'b@x.example', 'c@x.example', 'd@x.example'], [], null, 'settings_notify_emails_count_check'],
    ['a verified address that is not listed (D-46)', ['owner@example.com'], ['other@example.com'], NOW, 'settings_verified_subset_check'],
  ])('refuses %s', async (_name, notify, verified, savedAt, constraint) => {
    expect(await insertSettings(notify, verified, savedAt)).toMatchObject({ code: 'db_error', sqlstate: '23514', constraint });
  });

  it('refuses removing a listed address while it stays verified', async () => {
    expect(await insertSettings(['a@example.com', 'b@example.com'], ['b@example.com'], NOW)).toBeNull();
    const error = await getDb()
      .query(`update public.settings set notify_emails = '{a@example.com}' where account_id = $1`, [accountId])
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toMatchObject({ sqlstate: '23514', constraint: 'settings_verified_subset_check' });
  });
});

describe('drafts purge shape (PLAN §9.10 step 2)', () => {
  const getDb = useTestDb();

  it('empties flags at purge: flags is NOT NULL, so `flags = null` fails and `flags = \'{}\'` works', async () => {
    const db = getDb();
    const account = await db.one<{ id: string }>(
      `insert into public.accounts
         (hubspot_portal_id, processing_state_changed_at, trial_started_at, trial_ends_at, last_install_at, created_at)
       values ('9002', $1, $1, $1, $1, $1) returning id`,
      [NOW],
    );
    const lead = await db.one<{ id: string }>(
      `insert into public.leads (account_id, hubspot_contact_id, form_id, submitted_at, intake_trigger, received_at)
       values ($1, '501', 'form-1', $2, 'cron', $2) returning id`,
      [account.id, NOW],
    );
    await db.query(
      `insert into public.drafts (lead_id, account_id, kind, subject, body, flags, purge_at) values ($1, $2, 'initial', 'S', 'B', '{urgent}', $3)`,
      [lead.id, account.id, NOW],
    );
    const nulled = await db.query(`update public.drafts set flags = null where lead_id = $1`, [lead.id]).then(
      () => null,
      (error: unknown) => error,
    );
    expect(nulled).toMatchObject({ sqlstate: '23502', column: 'flags' });
    await db.query(`update public.drafts set subject = null, body = null, flags = '{}', purged_at = $2 where lead_id = $1`, [lead.id, NOW]);
    expect(await db.query('select subject, body, flags from public.drafts')).toEqual([{ subject: null, body: null, flags: [] }]);
  });
});
