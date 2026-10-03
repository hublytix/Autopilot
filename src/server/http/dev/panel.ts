import 'server-only';
import { DEV_ACTION_PATH, DEV_EMAIL_PATH, FAKE_CHECKOUT_BASE_PATH, type DevPanelContext } from './context';

// The /dev panel's read model (fake mode only; PLAN §4, §7.6, D-29): the fake clock, the job queue,
// the accounts with their subscriptions (each linked to its fake Razorpay checkout), the fake
// HubSpot portal (HubSpot's data, the system of record: it keeps what Autopilot deletes, D-82),
// the dev outbox, and the result of the last action, read from the query by our own codes only.

export const DEV_ACTIONS = [
  'submit_lead',
  'log_send',
  'log_reply',
  'revoke_token',
  'opt_out',
  'advance',
  'run_jobs',
  'run_daily',
  'deliver_razorpay',
  'reset',
] as const;
export type DevAction = (typeof DEV_ACTIONS)[number];

export const DEV_ERRORS = [
  'invalid_input',
  'unknown_form',
  'field_not_on_form',
  'contact_exists',
  'no_such_contact',
  'confirm_reset',
  'refused',
  'failed',
] as const;
export type DevError = (typeof DEV_ERRORS)[number];

export const ADVANCE_UNITS = ['minutes', 'hours', 'days'] as const;
export type AdvanceUnit = (typeof ADVANCE_UNITS)[number];
export const UNIT_MS: Readonly<Record<AdvanceUnit, number>> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };

export interface DevResult {
  readonly tone: 'success' | 'info' | 'error';
  readonly text: string;
}

export interface DevSubscription {
  readonly id: string;
  readonly status: string;
  /** /dev/fake-checkout/{id}: the fake Razorpay page for it. */
  readonly checkoutPath: string;
  /** A checkout the owner started and has not completed (`created`). */
  readonly open: boolean;
}

export interface DevAccount {
  readonly id: string;
  readonly portalId: string | null;
  readonly processingState: string;
  readonly connection: string | null;
  readonly owned: boolean;
  readonly paused: boolean;
  readonly trialEndsAt: string | null;
  readonly subscriptions: readonly DevSubscription[];
}

export interface DevForm {
  readonly id: string;
  readonly name: string;
  readonly fields: readonly string[];
}

export interface DevContact {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly company: string;
  readonly optedOut: boolean;
  readonly createdAt: string;
}

export interface DevOutboxRow {
  readonly id: string;
  readonly createdAt: string;
  readonly to: string;
  readonly subject: string;
  readonly kind: string;
  readonly path: string;
}

export interface DevPanelView {
  readonly now: string;
  readonly offset: string | null;
  readonly tickerRunning: boolean;
  readonly queue: { readonly total: number; readonly next: readonly { readonly kind: string; readonly runAt: string }[] };
  readonly jobs: readonly { readonly status: string; readonly count: number }[];
  readonly accounts: readonly DevAccount[];
  readonly portal: {
    readonly portalId: string;
    readonly hubDomain: string | null;
    readonly installed: boolean;
    readonly refreshRevoked: boolean;
    readonly ownerMailbox: string;
    readonly loggingMode: string;
    readonly forms: readonly DevForm[];
    readonly contacts: readonly DevContact[];
    readonly contactCount: number;
  };
  readonly outbox: readonly DevOutboxRow[];
  readonly result: DevResult | null;
  readonly actionPath: string;
}

const MAX_CONTACTS = 50;
const MAX_OUTBOX = 50;
const MAX_QUEUE = 10;

/** `2026-10-06 14:00 UTC`: the panel shows instants in UTC, to the minute. */
export function formatInstant(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function formatOffset(ms: number | null): string | null {
  if (ms === null) return null;
  if (Math.abs(ms) < 60_000) return 'at real time';
  const total = Math.round(Math.abs(ms) / 60_000);
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  const parts = [days > 0 ? `${days} d` : '', hours > 0 ? `${hours} h` : '', minutes > 0 ? `${minutes} min` : ''].filter((p) => p !== '');
  return `${parts.join(' ')} ${ms > 0 ? 'ahead of' : 'behind'} real time`;
}

type Query = Readonly<Record<string, string | string[] | undefined>>;

function single(query: Query, name: string): string | null {
  const value = query[name];
  return typeof value === 'string' ? value : null;
}

/** A small count from the query, or null. */
function count(query: Query, name: string): number | null {
  const value = single(query, name);
  return value !== null && /^\d{1,5}$/.test(value) ? Number(value) : null;
}

const ERROR_TEXT: Readonly<Record<DevError, string>> = {
  invalid_input: 'Some fields were missing or not valid.',
  unknown_form: "That form isn't in the fake HubSpot portal.",
  field_not_on_form: 'That form has no field for one of the values you filled in (the newsletter form has an email field only).',
  contact_exists: 'A contact with that email already exists in HubSpot: choose "Existing contact".',
  no_such_contact: 'No contact with that email exists in HubSpot: choose "New contact", or pick one from the list.',
  confirm_reset: 'Tick the box to confirm the reset.',
  refused: 'Fake HubSpot refused the change.',
  failed: "That didn't work. The server log has the error code.",
};

/** The message for the last action's outcome, from our own codes in the query (never echoed input). */
export function devResult(query: Query): DevResult | null {
  const error = single(query, 'error');
  if (error !== null) {
    return (DEV_ERRORS as readonly string[]).includes(error) ? { tone: 'error', text: ERROR_TEXT[error as DevError] } : null;
  }
  const done = single(query, 'done');
  if (done === null || !(DEV_ACTIONS as readonly string[]).includes(done)) return null;
  const n = count(query, 'count') ?? 0;
  const logged = single(query, 'logged') === '1';
  switch (done as DevAction) {
    case 'submit_lead':
      return single(query, 'webhook') === '1'
        ? { tone: 'success', text: "Submitted. HubSpot's webhook for the new contact was delivered; the poll it queues reads the submission when the jobs run." }
        : { tone: 'success', text: 'Submitted. HubSpot sends no webhook here (an existing contact, or the app is not installed): the next poll finds the submission. Run due jobs to poll now.' };
    case 'log_send':
      return logged
        ? { tone: 'success', text: "Logged the owner's send in HubSpot." }
        : { tone: 'info', text: "Nothing was logged: the owner's mailbox doesn't log sends to HubSpot." };
    case 'log_reply':
      return logged
        ? { tone: 'success', text: "Logged the lead's reply in HubSpot." }
        : { tone: 'info', text: "Nothing was logged: the owner's mailbox doesn't log incoming email, or the sender isn't a HubSpot contact." };
    case 'revoke_token':
      return { tone: 'success', text: "Revoked HubSpot's refresh tokens. Autopilot notices at its next token refresh (access tokens last 30 minutes): advance the clock and run due jobs." };
    case 'opt_out':
      return { tone: 'success', text: 'The contact is opted out of email in HubSpot. Its next follow-up check stops its follow-ups.' };
    case 'advance':
      return { tone: 'success', text: 'The clock moved forward. The ticker delivers what is now due within 10 seconds, or run due jobs now.' };
    case 'run_jobs':
      return { tone: 'success', text: `Ran the poll and the weekly-report check, and made ${n} job ${n === 1 ? 'delivery' : 'deliveries'}.` };
    case 'run_daily':
      return { tone: 'success', text: `Ran the daily maintenance and made ${n} job ${n === 1 ? 'delivery' : 'deliveries'}.` };
    case 'deliver_razorpay': {
      const failed = count(query, 'failed') ?? 0;
      return { tone: failed > 0 ? 'error' : 'success', text: `Delivered ${n} Razorpay ${n === 1 ? 'event' : 'events'}${failed > 0 ? `; ${failed} not accepted` : ''}.` };
    }
    case 'reset':
      return { tone: 'success', text: 'Everything is back to the start: an empty database, the fixture HubSpot portal, no subscriptions, real time. You are signed out.' };
  }
}

interface AccountRow {
  id: string;
  hubspot_portal_id: string | null;
  processing_state: string;
  trial_ends_at: Date | null;
  owned: boolean;
  paused: boolean;
  connection_status: string | null;
}

interface SubscriptionRow {
  account_id: string;
  provider_subscription_id: string;
  status: string;
}

interface OutboxRow {
  id: string;
  created_at: Date;
  to: string[];
  subject: string;
  kind: string;
}

async function accounts(ctx: DevPanelContext): Promise<DevAccount[]> {
  const db = ctx.deps.db;
  const rows = await db.query<AccountRow>(
    `select a.id, a.hubspot_portal_id, a.processing_state, a.trial_ends_at, a.owner_user_id is not null as owned,
            a.paused_at is not null as paused, c.status as connection_status
       from accounts a left join hubspot_connections c on c.account_id = a.id
      order by a.created_at desc, a.id
      limit 20`,
  );
  const subs =
    rows.length === 0
      ? []
      : await db.query<SubscriptionRow>(
          `select account_id, provider_subscription_id, status from subscriptions
            where account_id = any($1::uuid[]) order by created_at desc, id`,
          [rows.map((row) => row.id)],
        );
  return rows.map((row) => ({
    id: row.id,
    portalId: row.hubspot_portal_id,
    processingState: row.processing_state,
    connection: row.connection_status,
    owned: row.owned,
    paused: row.paused,
    trialEndsAt: row.trial_ends_at === null ? null : formatInstant(row.trial_ends_at),
    subscriptions: subs
      .filter((sub) => sub.account_id === row.id)
      .map((sub) => ({
        id: sub.provider_subscription_id,
        status: sub.status,
        checkoutPath: `${FAKE_CHECKOUT_BASE_PATH}/${encodeURIComponent(sub.provider_subscription_id)}`,
        open: sub.status === 'created',
      })),
  }));
}

function portal(ctx: DevPanelContext): DevPanelView['portal'] {
  const state = ctx.fakes.hubspot.snapshot();
  const ownerMailbox = state.portal.installerEmail;
  const live = state.contacts.filter((c) => c.deletedAtMs === null && c.mergedIntoId === null);
  const contacts = [...live]
    .sort((a, b) => b.createdAtMs - a.createdAtMs || Number(b.id) - Number(a.id))
    .slice(0, MAX_CONTACTS)
    .map((c) => ({
      id: c.id,
      email: c.properties.email ?? '',
      name: [c.properties.firstname, c.properties.lastname].filter((part): part is string => typeof part === 'string' && part !== '').join(' '),
      company: c.properties.company ?? '',
      optedOut: c.properties.hs_email_optout === 'true',
      createdAt: formatInstant(new Date(c.createdAtMs)),
    }));
  return {
    portalId: state.portal.portalId,
    hubDomain: state.portal.hubDomain,
    installed: state.oauth.installed,
    refreshRevoked: state.oauth.refreshTokens.length > 0 && state.oauth.refreshTokens.every((t) => t.revoked),
    ownerMailbox,
    loggingMode: state.mailboxes[ownerMailbox] ?? 'none',
    forms: state.forms.filter((f) => !f.archived).map((f) => ({ id: f.id, name: f.name, fields: f.fields.filter((x) => !x.hidden).map((x) => x.name) })),
    contacts,
    contactCount: live.length,
  };
}

async function outbox(ctx: DevPanelContext): Promise<DevOutboxRow[]> {
  const rows = await ctx.deps.db.query<OutboxRow>(
    `select id, created_at, "to", subject, kind from fake.dev_outbox order by created_at desc, id desc limit ${MAX_OUTBOX}`,
  );
  return rows.map((row) => ({
    id: row.id,
    createdAt: formatInstant(row.created_at),
    to: row.to.join(', '),
    subject: row.subject,
    kind: row.kind,
    path: `${DEV_EMAIL_PATH}/${row.id}`,
  }));
}

/** The panel's view model; null outside fake mode (the page answers 404). */
export async function buildDevPanelView(ctx: DevPanelContext | null, query: Query): Promise<DevPanelView | null> {
  if (ctx === null) return null;
  const pending = ctx.fakes.scheduler.pending();
  const jobs = await ctx.deps.db.query<{ status: string; count: number }>(
    'select status, count(*)::int as count from scheduled_jobs group by status order by status',
  );
  return {
    now: formatInstant(ctx.deps.clock.now()),
    offset: formatOffset(ctx.clock.offsetMs),
    tickerRunning: ctx.tickerRunning,
    queue: { total: pending.length, next: pending.slice(0, MAX_QUEUE).map((m) => ({ kind: m.kind, runAt: formatInstant(m.runAt) })) },
    jobs,
    accounts: await accounts(ctx),
    portal: portal(ctx),
    outbox: await outbox(ctx),
    result: devResult(query),
    actionPath: DEV_ACTION_PATH,
  };
}
