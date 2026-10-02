import 'server-only';
import { z } from 'zod';
import { insertJob, publishJobs } from '@/server/jobs/outbox';
import type { JobRow } from '@/server/jobs/types';
import type { Deps } from '@/server/ports';
import { accountLocalDate } from '@/server/services/accounts';

// The daily cron's fan-out (PLAN §7.3, §8.2): one `account_daily` job per account still in the
// database (a purge deletes the row), keyed `daily:{acct}:{localDate}` with the account's local date
// (UTC when its timezone is unknown), so a second run of the cron on the same local day inserts
// nothing. All rows go in one transaction; they are published after it commits (the outbox, PLAN
// §8.3: a failed publish is left to the sweeper).

export function accountDailyDedupeKey(accountId: string, localDate: string): string {
  return `daily:${accountId}:${localDate}`;
}

export interface ScheduleDailySummary {
  readonly accounts: number;
  /** Jobs inserted by this run. */
  readonly created: number;
  /** Already scheduled for this local date. */
  readonly existing: number;
  readonly published: number;
  readonly publishFailed: number;
}

const accountSchema = z.object({ id: z.string(), timezone: z.string().nullable() });

export async function scheduleAccountDailyJobs(deps: Deps): Promise<ScheduleDailySummary> {
  const now = deps.clock.now();
  const rows = await deps.db.tx(async (tx) => {
    const accounts = (await tx.query(`select id, timezone from accounts order by created_at, id`)).map((raw) => accountSchema.parse(raw));
    const inserted: (JobRow | null)[] = [];
    for (const account of accounts) {
      inserted.push(
        await insertJob(tx, {
          kind: 'account_daily',
          accountId: account.id,
          dedupeKey: accountDailyDedupeKey(account.id, accountLocalDate(now, account.timezone)),
          runAt: now,
          now,
        }),
      );
    }
    return { accounts: accounts.length, inserted };
  });
  const publish = await publishJobs(deps, rows.inserted);
  const created = rows.inserted.filter((row) => row !== null).length;
  return {
    accounts: rows.accounts,
    created,
    existing: rows.accounts - created,
    published: publish.published.length,
    publishFailed: publish.failed.length,
  };
}
