import 'server-only';
import { errorCode } from '@/server/domain/errors';
import type { Db } from '@/server/db';
import { log } from '@/server/obs/log';
import type { SessionCookie } from '@/server/ports';
import type { DevPanelContext } from './context';

// "Reset fake state" on the /dev panel (fake mode only): back to a fresh fake-mode start without a
// restart. The persisted fakes (portal, subscriptions, auth users) go back to how a new container
// starts them, the fake scheduler's queue and Razorpay's undelivered events are dropped, the clock
// returns to real time, and every table is emptied (public, auth and fake: dev outbox, fake.state),
// except the migration ledger. The fakes are restored BEFORE the truncate: a snapshot write that
// was already on its way then lands before the truncate and is removed with the rest, and any
// later write stores the starting state. The caller's own session cookie is cleared too.

/** Every table in every non-system schema, the migration ledger (fake._migrations) excepted. */
export async function truncateAllTables(db: Db): Promise<void> {
  const tables = await db.query<{ name: string }>(
    `select format('%I.%I', n.nspname, c.relname) as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p')
        and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_%'
        and not (n.nspname = 'fake' and c.relname = '_migrations')
      order by n.nspname, c.relname`,
  );
  if (tables.length === 0) return;
  await db.exec(`truncate table ${tables.map((table) => table.name).join(', ')} restart identity cascade`);
}

/** Resets everything; returns the cookies that sign the caller out. */
export async function resetFakeState(ctx: DevPanelContext, req: Request): Promise<readonly SessionCookie[]> {
  const start = await ctx.startingState();
  let cookies: readonly SessionCookie[] = [];
  try {
    cookies = await ctx.deps.auth.signOut(req);
  } catch (error) {
    log.warn('dev reset: sign-out failed', { event: 'dev.reset_signout_failed', code: errorCode(error) });
  }
  const { hubspot, billing, auth, scheduler } = ctx.fakes;
  hubspot.restore(start.hubspot);
  billing.restore(start.billing);
  billing.takeWebhooks();
  auth.restore(start.auth);
  for (const message of scheduler.pending()) await scheduler.cancel(message.messageId);
  if (ctx.clock.reset !== null) await ctx.clock.reset();
  await truncateAllTables(ctx.deps.db);
  log.info('dev reset', { event: 'dev.reset' });
  return cookies;
}
