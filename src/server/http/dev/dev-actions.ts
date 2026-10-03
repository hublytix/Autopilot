import 'server-only';
import { z } from 'zod';
import { errorCode } from '@/server/domain/errors';
import { runSweeper } from '@/server/jobs/sweeper';
import { log } from '@/server/obs/log';
import type { SessionCookie } from '@/server/ports';
import { withSetCookies } from '@/server/security/cookies';
import { isSameOriginRequest } from '@/server/security/same-origin';
import { runDailyCron } from '@/server/services/daily';
import { runPollCron } from '@/server/services/intake';
import { scheduleWeeklyReports } from '@/server/services/reports/schedule';
import { readBoundedBody } from '../bounded-body';
import { runRetentionGuard } from '../cron-poll';
import { handleHubSpotWebhook } from '../hubspot-webhook';
import { DEV_PANEL_PATH, NO_STORE_HEADERS, type DevPanelContext } from './context';
import { deliverQueuedWebhooks } from './fake-checkout';
import { devNotFound, devPlainResponse } from './guard';
import { ADVANCE_UNITS, DEV_ACTIONS, UNIT_MS, type DevAction, type DevError } from './panel';
import { resetFakeState } from './reset';

// POST /dev/actions (fake mode only; 404 otherwise; same-origin; PLAN §4, §7.6, D-29): the /dev
// panel's buttons. Each plays a part the real world plays in live mode — a lead submitting a form,
// the owner's mailbox logging a send, the lead's reply, HubSpot revoking the app, a contact opting
// out, time passing, the crons and QStash delivering due jobs, Razorpay delivering its events — and
// then 303s back to /dev with a result code (never the input). Everything goes through the real
// entry points: HubSpot's webhook through handleHubSpotWebhook, jobs through the FakeScheduler's
// dispatcher, Razorpay's events through the real webhook handler.

const MAX_FORM_BYTES = 16 * 1024;

type Form = (name: string) => string | undefined;

/** The posted form (urlencoded or multipart, as a browser sends it); null when absent, too big or odd. */
async function readForm(req: Request): Promise<Form | null> {
  const contentType = req.headers.get('content-type') ?? '';
  const type = contentType.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded' && type !== 'multipart/form-data') return null;
  // Read with a hard limit (a chunked body has no Content-Length to refuse early).
  const body = await readBoundedBody(req, MAX_FORM_BYTES);
  if (!body.ok) return null;
  let entries: [string, string][];
  if (type === 'application/x-www-form-urlencoded') {
    entries = [...new URLSearchParams(new TextDecoder('utf-8').decode(body.bytes))];
  } else {
    try {
      const parsed = await new Response(new Uint8Array(body.bytes), { headers: { 'content-type': contentType } }).formData();
      entries = [...parsed].flatMap(([name, value]) => (typeof value === 'string' ? [[name, value] as [string, string]] : []));
    } catch {
      return null;
    }
  }
  const counts = new Map<string, number>();
  for (const [name] of entries) counts.set(name, (counts.get(name) ?? 0) + 1);
  const values = new Map(entries);
  // A field sent twice is ambiguous: read as absent, so the schema refuses it.
  return (name) => ((counts.get(name) ?? 0) === 1 ? values.get(name) : undefined);
}

type Outcome = { query: Record<string, string>; cookies?: readonly SessionCookie[] };

const fail = (error: DevError): Outcome => ({ query: { error } });

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value === undefined || value === '' ? undefined : value));
const email = z.string().trim().toLowerCase().pipe(z.email().max(254));

const submitSchema = z.object({
  form: z.string().min(1).max(100),
  email,
  firstName: optionalText(100),
  lastName: optionalText(100),
  company: optionalText(200),
  message: optionalText(5000),
  contact: z.enum(['new', 'existing', 'any']),
});

function parse<T extends z.ZodType>(schema: T, form: Form, names: readonly string[]): z.infer<T> | null {
  const parsed = schema.safeParse(Object.fromEntries(names.map((name) => [name, form(name)])));
  return parsed.success ? parsed.data : null;
}

async function submitLead(ctx: DevPanelContext, form: Form): Promise<Outcome> {
  const input = parse(submitSchema, form, ['form', 'email', 'firstName', 'lastName', 'company', 'message', 'contact']);
  if (input === null) return fail('invalid_input');
  const { hubspot } = ctx.fakes;
  const portalForm = hubspot.snapshot().forms.find((f) => f.id === input.form && !f.archived);
  if (portalForm === undefined) return fail('unknown_form');
  const fields = new Set(portalForm.fields.map((f) => f.name));
  const given = { firstname: input.firstName, lastname: input.lastName, company: input.company, message: input.message };
  if (!fields.has('email') || Object.entries(given).some(([name, value]) => value !== undefined && !fields.has(name))) return fail('field_not_on_form');
  const exists = hubspot.contactIdByEmail(input.email) !== null;
  if (input.contact === 'new' && exists) return fail('contact_exists');
  if (input.contact === 'existing' && !exists) return fail('no_such_contact');

  const result = hubspot.submitForm({
    formId: portalForm.id,
    email: input.email,
    firstName: input.firstName,
    lastName: input.lastName,
    company: input.company,
    message: input.message,
    at: ctx.deps.clock.now(),
  });
  // HubSpot fires `object.creation` for a contact the submission created, and only to an installed app.
  if (!result.createdContact || result.contactId === null || !hubspot.isInstalled()) return { query: { webhook: '0' } };
  const env = ctx.deps.env;
  const signed = hubspot.signedWebhook([{ subscriptionType: 'object.creation', objectId: result.contactId }], { uri: env.HUBSPOT_WEBHOOK_TARGET_URL });
  const response = await handleHubSpotWebhook(
    new Request(env.HUBSPOT_WEBHOOK_TARGET_URL, { method: 'POST', headers: signed.headers, body: signed.body }),
    ctx.deps,
  );
  if (response.status !== 200) log.warn('dev panel webhook not accepted', { event: 'dev.panel_webhook_refused', httpStatus: response.status });
  return { query: { webhook: response.status === 200 ? '1' : '0' } };
}

async function logSend(ctx: DevPanelContext, form: Form): Promise<Outcome> {
  const to = parse(z.object({ to: email }), form, ['to']);
  if (to === null) return fail('invalid_input');
  const id = ctx.fakes.hubspot.logOwnerSend({ to: to.to, at: ctx.deps.clock.now() });
  return { query: { logged: id === null ? '0' : '1' } };
}

async function logReply(ctx: DevPanelContext, form: Form): Promise<Outcome> {
  const from = parse(z.object({ from: email }), form, ['from']);
  if (from === null) return fail('invalid_input');
  const id = ctx.fakes.hubspot.logLeadReply({ from: from.from, at: ctx.deps.clock.now() });
  return { query: { logged: id === null ? '0' : '1' } };
}

async function optOut(ctx: DevPanelContext, form: Form): Promise<Outcome> {
  const input = parse(z.object({ email }), form, ['email']);
  if (input === null) return fail('invalid_input');
  const contactId = ctx.fakes.hubspot.contactIdByEmail(input.email);
  if (contactId === null) return fail('no_such_contact');
  ctx.fakes.hubspot.optOut(contactId);
  return { query: {} };
}

async function advance(ctx: DevPanelContext, form: Form): Promise<Outcome> {
  const input = parse(z.object({ amount: z.coerce.number().int().min(1).max(999), unit: z.enum(ADVANCE_UNITS) }), form, ['amount', 'unit']);
  if (input === null) return fail('invalid_input');
  await ctx.clock.advance(input.amount * UNIT_MS[input.unit]);
  return { query: {} };
}

/** QStash and the crons, now: due jobs, the poll cron (states, polls, sweeper, retention guard), the weekly-report check, then what they queued. */
export async function runDueJobsNow(ctx: DevPanelContext): Promise<number> {
  const { deps } = ctx;
  let delivered = await ctx.fakes.scheduler.runDue(deps.clock.now());
  await runPollCron(deps, { sweep: (d) => runSweeper(d), retentionGuard: runRetentionGuard });
  await scheduleWeeklyReports(deps);
  delivered += await ctx.fakes.scheduler.runDue(deps.clock.now());
  return delivered;
}

async function runJobs(ctx: DevPanelContext): Promise<Outcome> {
  return { query: { count: String(await runDueJobsNow(ctx)) } };
}

async function runDaily(ctx: DevPanelContext): Promise<Outcome> {
  await runDailyCron(ctx.deps);
  return { query: { count: String(await ctx.fakes.scheduler.runDue(ctx.deps.clock.now())) } };
}

async function deliverRazorpay(ctx: DevPanelContext): Promise<Outcome> {
  // Razorpay's own clock first (a trial ending, a renewal), then everything queued.
  ctx.fakes.billing.sync();
  const { delivered, failed } = await deliverQueuedWebhooks({ deps: ctx.deps, billing: ctx.fakes.billing });
  return { query: { count: String(delivered), failed: String(failed) } };
}

async function reset(ctx: DevPanelContext, form: Form, req: Request): Promise<Outcome> {
  if (form('confirm') !== 'yes') return fail('confirm_reset');
  return { query: {}, cookies: await resetFakeState(ctx, req) };
}

async function simple(run: () => void): Promise<Outcome> {
  run();
  return { query: {} };
}

const RUNNERS: Readonly<Record<DevAction, (ctx: DevPanelContext, form: Form, req: Request) => Promise<Outcome>>> = {
  submit_lead: submitLead,
  log_send: logSend,
  log_reply: logReply,
  revoke_token: (ctx) => simple(() => ctx.fakes.hubspot.revokeToken()),
  opt_out: optOut,
  advance,
  run_jobs: runJobs,
  run_daily: runDaily,
  deliver_razorpay: deliverRazorpay,
  reset,
};

function backTo(action: DevAction | null, outcome: Outcome): Response {
  const query = new URLSearchParams(outcome.query.error === undefined && action !== null ? { done: action, ...outcome.query } : outcome.query);
  const response = new Response(null, { status: 303, headers: { Location: `${DEV_PANEL_PATH}?${query.toString()}#result`, ...NO_STORE_HEADERS } });
  return withSetCookies(response, outcome.cookies ?? []);
}

/** POST /dev/actions. */
export async function handleDevAction(req: Request, ctx: DevPanelContext | null): Promise<Response> {
  if (ctx === null) return devNotFound();
  if (req.method !== 'POST') return devPlainResponse(405, 'Method not allowed', { Allow: 'POST' });
  if (!isSameOriginRequest(req, ctx.deps.env.APP_URL)) return devPlainResponse(403, 'Forbidden');
  const form = await readForm(req);
  if (form === null) return backTo(null, fail('invalid_input'));
  const action = DEV_ACTIONS.find((name) => name === form('action'));
  if (action === undefined) return devPlainResponse(400, 'Unknown action');
  try {
    const outcome = await RUNNERS[action](ctx, form, req);
    log.info('dev panel action', { event: 'dev.panel_action', reason: action, code: outcome.query.error });
    return backTo(action, outcome);
  } catch (error) {
    log.warn('dev panel action failed', { event: 'dev.panel_action_failed', reason: action, code: errorCode(error) });
    return backTo(action, fail(action === 'submit_lead' || action === 'opt_out' ? 'refused' : 'failed'));
  }
}

/** Any other method: 404 outside fake mode, else 405. */
export function handleDevActionOtherMethod(ctx: DevPanelContext | null): Response {
  if (ctx === null) return devNotFound();
  return devPlainResponse(405, 'Method not allowed', { Allow: 'POST' });
}
