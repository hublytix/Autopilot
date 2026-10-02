// Simulation stage 7, the `disconnect` variant (PLAN §9.1 step 5, §9.10, D-48, D-49, §15 M7), run
// on its own into its own outbox directory: the same boot, pre-run and Day 0 submissions (4 new_lead
// emails), then on Wed 10-07 the owner subscribes (authorised: `authenticated`) and at 10:00
// disconnects HubSpot from /dashboard/settings/disconnect with "Also cancel my subscription":
// the subscription is cancelled (nothing charged), the app is uninstalled and the refresh token
// revoked, processing stops at once (follow-ups cancelled, action links revoked), and the account's
// data is kept for 30 days in case the owner reconnects. Nothing is sent after it. The leads'
// content is purged at 30 days by the retention guard (Thu 11-05); the daily run after
// `purge_after` (Sat 11-07 03:17 UTC) purges the account: every row of it is gone, the tombstones
// (`portal_history`, `billing_tombstones`) remain, the owner's sign-in user is deleted, and no lead
// or draft text, name or address is left in any table.
import { runDisconnect, SETTINGS_PATH } from '@/server/actions/settings/controls';
import { disconnectPageView, settingsPageView } from '@/server/views/settings';
import { scheduleDay0Submissions } from './day0';
import { DAY0_SUBMISSIONS } from './day0-scenario';
import { bannerSummary, outboxKinds, ownerDashboard, ownerScopeOrFail, processingState, subscribeThroughCheckout, subscriptionStatuses } from './owner-billing';
import { shownLocal } from './status';
import type { Simulation, Stage } from './types';

export const DISCONNECT_SCENARIO = 'brightside-plumbing-disconnect';

const DISCONNECT_AT = '2026-10-07T10:00:00';
/** 30 days after the disconnect (Fri 11-06 09:00 EST, after the clocks went back on Nov 1). */
const PURGE_AFTER_ISO = '2026-11-06T14:00:00.000Z';
/** The first daily run after `purge_after`. */
const PURGE_RUN_ISO = '2026-11-07T03:17:00.000Z';
const OUTBOX_AT_DISCONNECT = 'magic_link,inbox_test,new_lead,new_lead,new_lead,new_lead';

/** Every table of `schema` and the column list `row_to_json` reads (ids, names, values: no type filter). */
async function tables(sim: Simulation, schema: string): Promise<string[]> {
  const rows = await sim.db.query<{ table_name: string }>(
    `select table_name from information_schema.tables where table_schema = $1 and table_type = 'BASE TABLE' order by table_name`,
    [schema],
  );
  return rows.map((row) => row.table_name);
}

/** Tables that still hold any of `needles` (case-insensitive), as `schema.table`. */
async function tablesHolding(sim: Simulation, needles: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const schema of ['public', 'fake']) {
    for (const table of await tables(sim, schema)) {
      const rows = await sim.db.query<{ row: string }>(`select row_to_json(t)::text as row from ${schema}."${table}" t`);
      const text = rows.map((r) => r.row.toLowerCase()).join('\n');
      if (needles.some((needle) => text.includes(needle.toLowerCase()))) found.push(`${schema}.${table}`);
    }
  }
  return found;
}

/** Tables with an `account_id` column that still have rows for the account. */
async function tablesWithAccountRows(sim: Simulation, accountId: string): Promise<string[]> {
  const rows = await sim.db.query<{ table_name: string }>(
    `select table_name from information_schema.columns where table_schema = 'public' and column_name = 'account_id' order by table_name`,
  );
  const left: string[] = [];
  for (const { table_name: table } of rows) {
    const count = await sim.db.one<{ n: number }>(`select count(*)::int as n from public."${table}" where account_id = $1`, [accountId]);
    if (count.n > 0) left.push(`${table}:${count.n}`);
  }
  return left;
}

/**
 * The lead content the run created (lead text, names, addresses and the drafts as stored), to look
 * for after the 30-day retention and after the purge. The owner's address is not among them: it
 * legitimately lives in users/settings until the account itself is purged.
 */
async function leadContentNeedles(sim: Simulation): Promise<string[]> {
  const needles: string[] = [];
  for (const submission of DAY0_SUBMISSIONS) {
    needles.push(submission.email, `${submission.firstName} ${submission.lastName}`);
    if (submission.message !== undefined) needles.push(submission.message.slice(0, 60));
    if (submission.company !== undefined) needles.push(submission.company);
  }
  const drafts = await sim.db.query<{ subject: string | null; body: string | null }>(
    `select subject, body from public.drafts where account_id = $1 and body is not null`,
    [sim.scenario.accountId],
  );
  for (const draft of drafts) {
    if (draft.subject !== null && draft.subject.length >= 12) needles.push(draft.subject);
    if (draft.body !== null) needles.push(draft.body.slice(0, 80));
  }
  return needles;
}

async function runDisconnectVariant(sim: Simulation): Promise<void> {
  const accountId = sim.scenario.accountId;
  if (accountId === null) {
    sim.check('disconnect.account_exists', false, 'no account after the pre-run');
    return;
  }
  scheduleDay0Submissions(sim);
  await sim.travel.advanceTo(sim.local('2026-10-06T10:45:00'));
  sim.check('disconnect.day0_drafted_and_emailed', outboxKinds(sim).join(',') === OUTBOX_AT_DISCONNECT, outboxKinds(sim).join(','));

  sim.travel.at(sim.local('2026-10-07T09:30:00'), 'owner subscribes', async () => {
    const outcome = await subscribeThroughCheckout(sim, 'disconnect');
    sim.record('step', 'billing.subscribed_by_owner', { hops: outcome?.hops ?? [], delivered: outcome?.delivered ?? 0 });
  });

  let needles: string[] = [];
  sim.travel.at(sim.local(DISCONNECT_AT), 'owner disconnects HubSpot', async () => {
    needles = await leadContentNeedles(sim);
    const scope = await ownerScopeOrFail(sim, '/dashboard/settings/disconnect', 'disconnect.owner_signed_in');
    if (scope === null) return;
    const dialog = await disconnectPageView(scope, sim.deps);
    sim.check(
      'disconnect.dialog_offers_to_cancel_the_authenticated_subscription',
      dialog.connectionStatus === 'active' &&
        dialog.billing.type === 'cancellable' &&
        dialog.billing.status === 'authenticated' &&
        dialog.billing.firstPaymentOn === '20 Oct 2026' &&
        dialog.purgeOnIfNow === '6 Nov 2026',
      `${String(dialog.connectionStatus)}; billing ${dialog.billing.type}${'status' in dialog.billing ? ` ${dialog.billing.status}` : ''}; deleted on ${dialog.purgeOnIfNow}`,
    );
    const form = new FormData();
    form.set('cancel_billing', 'on');
    const next = await runDisconnect(sim.deps, scope, form, {
      sleep: async (ms) => {
        sim.clock.advance(ms);
      },
    });
    sim.record('step', 'hubspot.disconnected_by_owner', { next, cancelBilling: true });
    sim.check('disconnect.lands_on_settings_with_the_outcome', next === `${SETTINGS_PATH}?result=disconnected&billing=cancelled`, next);
  });
  await sim.travel.advanceTo(sim.local('2026-10-07T10:05:00'));

  // Processing stops at once; HubSpot is let go of; the subscription is cancelled.
  const account = await sim.db.one<{ processing_state: string; purge_after: Date | null; disconnected_at: Date | null }>(
    `select processing_state, purge_after, disconnected_at from public.accounts where id = $1`,
    [accountId],
  );
  const connection = await sim.db.one<{ status: string; status_reason: string | null; tokens: number }>(
    `select status, status_reason, (access_token_enc is not null)::int + (refresh_token_enc is not null)::int as tokens from public.hubspot_connections where account_id = $1`,
    [accountId],
  );
  const hubspot = sim.fakes.hubspot.snapshot();
  sim.check(
    'disconnect.processing_stops_and_data_kept_30_days',
    account.processing_state === 'disconnected' &&
      account.disconnected_at?.getTime() === sim.local(DISCONNECT_AT).getTime() &&
      account.purge_after?.toISOString() === PURGE_AFTER_ISO &&
      connection.status === 'disconnected' &&
      connection.status_reason === 'owner_disconnected' &&
      connection.tokens === 0,
    `${account.processing_state}, purge_after ${account.purge_after?.toISOString() ?? 'none'}, connection ${connection.status} (${String(connection.status_reason)}), tokens ${connection.tokens}`,
  );
  sim.check(
    'disconnect.app_uninstalled_and_refresh_token_revoked',
    !sim.fakes.hubspot.isInstalled() && hubspot.oauth.refreshTokens.length > 0 && hubspot.oauth.refreshTokens.every((token) => token.revoked),
    `installed ${String(sim.fakes.hubspot.isInstalled())}, refresh tokens revoked ${hubspot.oauth.refreshTokens.filter((t) => t.revoked).length}/${hubspot.oauth.refreshTokens.length}`,
  );
  const statuses = await subscriptionStatuses(sim);
  sim.check('disconnect.subscription_cancelled_nothing_charged', statuses.join(',') === 'cancelled', statuses.join(','));
  const jobs = await sim.db.query<{ status: string; n: number }>(
    `select status, count(*)::int as n from public.scheduled_jobs where account_id = $1 and kind = 'followup' group by status order by status`,
    [accountId],
  );
  const stops = await sim.db.query<{ stop_reason: string | null }>(
    `select stop_reason from public.leads where account_id = $1 and not is_test and processing_state = 'notified' order by submitted_at`,
    [accountId],
  );
  const tokens = await sim.db.one<{ live: number }>(`select count(*)::int as live from public.action_tokens where account_id = $1 and revoked_at is null`, [accountId]);
  sim.check(
    'disconnect.follow_ups_cancelled_and_links_revoked',
    jobs.map((row) => `${row.status}:${row.n}`).join(',') === 'cancelled:8' && stops.length === 4 && stops.every((row) => row.stop_reason === 'account_inactive') && tokens.live === 0,
    `follow-up jobs ${jobs.map((row) => `${row.status}:${row.n}`).join(',')}; stops ${stops.map((row) => String(row.stop_reason)).join(',')}; live action tokens ${tokens.live}`,
  );
  const view = await ownerDashboard(sim, 'disconnect.dashboard');
  const settingsScope = await ownerScopeOrFail(sim, SETTINGS_PATH, 'disconnect.settings');
  const settings = settingsScope === null ? null : await settingsPageView(settingsScope, sim.deps);
  sim.check(
    'disconnect.dashboard_and_settings_say_reconnect_within_30_days',
    view !== null &&
      view.status.state === 'disconnected' &&
      bannerSummary(view) === 'reconnect:30' &&
      settings?.connection.status === 'disconnected' &&
      settings.connection.purgeOn === '6 Nov 2026' &&
      settings.connection.daysLeft === 30,
    `${view?.status.state ?? 'none'}: ${bannerSummary(view)}; settings ${settings?.connection.status ?? 'none'} until ${settings?.connection.purgeOn ?? 'none'}`,
  );

  // Nothing is drafted or sent after the disconnect (Thursday's and Sunday's follow-ups, Monday's report).
  await sim.travel.advanceTo(sim.local('2026-10-13T12:00:00'));
  sim.check('disconnect.nothing_sent_after_the_disconnect', outboxKinds(sim).join(',') === OUTBOX_AT_DISCONNECT, outboxKinds(sim).join(','));

  // Day 30 (Thu 11-05): the leads' content goes with the retention guard, before the account itself.
  await sim.travel.advanceTo(sim.local('2026-11-05T12:00:00'));
  const content = await sim.db.one<{ messages: number; drafts: number }>(
    `select (select count(*)::int from public.lead_messages where account_id = $1) as messages,
            (select count(*)::int from public.drafts where account_id = $1 and (body is not null or subject is not null)) as drafts`,
    [accountId],
  );
  sim.check('disconnect.lead_content_purged_at_30_days', content.messages === 0 && content.drafts === 0, `messages ${content.messages}, drafts ${content.drafts}`);
  // Not just the two content tables: no copy of the leads' text, names, addresses or drafts in any
  // table of public or fake while the account (and every account-scoped row) still exists (law 4, D-49).
  const holdingBeforePurge = await tablesHolding(sim, needles);
  sim.check(
    'disconnect.no_lead_content_anywhere_after_30_days_before_purge',
    needles.length > 20 && holdingBeforePurge.length === 0,
    `${needles.length} needles; found in ${holdingBeforePurge.join(', ') || 'no table'}`,
  );
  sim.check('disconnect.account_kept_until_purge_after', (await processingState(sim)) === 'disconnected', String(await processingState(sim)));

  // The first daily run after purge_after purges the account.
  await sim.travel.advanceTo(sim.local('2026-11-06T23:00:00'));
  const purgeJob = sim.entries().filter((entry) => entry.name === 'job.account_daily' && entry.at === PURGE_RUN_ISO);
  const gone = await sim.db.maybeOne<{ id: string }>(`select id from public.accounts where id = $1`, [accountId]);
  sim.check(
    'disconnect.account_purged_by_the_first_daily_run_after_30_days',
    gone === null && purgeJob.length === 1,
    `account ${gone === null ? 'gone' : 'still there'}; account_daily at ${PURGE_RUN_ISO}: ${purgeJob.length}`,
  );
  const left = await tablesWithAccountRows(sim, accountId);
  sim.check('disconnect.no_row_left_for_the_account', left.length === 0, left.join(', ') || 'none');
  const history = await sim.db.query<{ portal_id: string }>(`select hubspot_portal_id as portal_id from public.portal_history`);
  const tombstones = await sim.db.query<{ last_status: string; resolved: boolean }>(
    `select last_status, resolved_at is not null as resolved from public.billing_tombstones`,
  );
  sim.check(
    'disconnect.tombstones_remain',
    history.map((row) => row.portal_id).join(',') === sim.fakes.hubspot.portal.portalId &&
      tombstones.length === 1 &&
      tombstones[0]?.last_status === 'cancelled' &&
      tombstones[0].resolved,
    `portal_history [${history.map((row) => row.portal_id).join(',')}]; billing_tombstones [${tombstones.map((row) => `${row.last_status}${row.resolved ? ' resolved' : ''}`).join(',')}]`,
  );
  const owner = sim.scenario.ownerEmail;
  const authUsers = sim.fakes.auth.users().filter((user) => user.email === owner);
  sim.check('disconnect.owner_sign_in_user_deleted', authUsers.length === 0, `${authUsers.length} auth user(s) with the owner's address`);
  const afterPurge = owner === null ? needles : [...needles, owner];
  const holding = await tablesHolding(sim, afterPurge);
  sim.check(
    'disconnect.no_lead_or_draft_content_anywhere',
    needles.length > 20 && holding.length === 0,
    `${afterPurge.length} needles; found in ${holding.join(', ') || 'no table'}`,
  );
  sim.check('disconnect.outbox_unchanged_since_the_disconnect', outboxKinds(sim).join(',') === OUTBOX_AT_DISCONNECT, outboxKinds(sim).join(','));
  sim.record('step', 'account.purged', { at: PURGE_RUN_ISO, local: shownLocal(sim, new Date(PURGE_RUN_ISO)) });
}

export const DISCONNECT_VARIANT_STAGES: readonly Stage[] = [{ id: 'disconnect-purge', milestone: 'M7', run: runDisconnectVariant }];
