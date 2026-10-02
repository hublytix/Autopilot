import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDb } from '../../../../test/db/harness';
import { BCC_ADDRESS, checkIdOf, checkOf, createInboxRig, inboxJobs, start, TEST_ADDRESS } from '../../../../test/inbox/support';
import { insertJob, publishJobs, type JobRow } from '@/server/jobs';
import { createJobRegistry } from '@/server/jobs';
import { getJob } from '@/server/jobs/rows';
import { createJobTestRig, TEST_START, type JobTestRig } from '@/server/jobs/testing';
import { generateActionToken, revokeTokens } from '@/server/security/action-tokens';
import { seedSendableLead, type SeedSendableLeadInput, type SendableLead } from '@/server/services/action-links/testing';
import { DISMISS_RESULT_ALERTS, dismissPageState, dismissResultAlert, dismissResultPath, submitDismissForm } from './dismiss';
import { editPageState } from './edit';
import { ACTION_LINK_MESSAGES } from './messages';

// /a/{token}/dismiss route tests (PLAN §7.4, §12 route tests with real Requests; D-26, D-45): GET
// never dismisses; the same-origin POST dismisses once (dismissed_at, stop_reason, the lead's jobs
// cancelled) and a second POST changes nothing.

const APP = 'http://localhost:3000';
const DAY = 86_400_000;
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const SCANNER = 'Mozilla/5.0 (compatible; Barracuda Sentinel (EE))';

interface RequestOptions {
  ip?: string;
  ua?: string;
  origin?: string | null;
  secFetchSite?: string;
}

function request(token: string, method: 'GET' | 'POST', options: RequestOptions = {}): Request {
  const headers: Record<string, string> = { 'x-real-ip': options.ip ?? '203.0.113.7', 'user-agent': options.ua ?? DESKTOP };
  if (method === 'POST' && options.origin !== null) headers.origin = options.origin ?? APP;
  if (options.secFetchSite !== undefined) headers['sec-fetch-site'] = options.secFetchSite;
  return new Request(`${APP}/a/${token}/dismiss`, method === 'POST' ? { method, headers, body: new URLSearchParams({ token }) } : { method, headers });
}

interface LeadState {
  dismissed_at: Date | null;
  stop_reason: string | null;
  use_count: number;
  first_used_at: Date | null;
}

describe('/a/{token}/dismiss', () => {
  const getDb = useTestDb();
  let rig: JobTestRig;

  beforeEach(() => {
    rig = createJobTestRig(getDb(), createJobRegistry(), { start: TEST_START });
  });

  async function seed(input: Partial<SeedSendableLeadInput> = {}): Promise<SendableLead> {
    return seedSendableLead(getDb(), { now: rig.clock.now(), ...input });
  }

  async function open(token: string, options: RequestOptions = {}) {
    return dismissPageState(rig.deps, token, request(token, 'GET', options).headers);
  }

  async function post(token: string, options: RequestOptions = {}) {
    return submitDismissForm(rig.deps, token, request(token, 'POST', options).headers);
  }

  async function stateOf(lead: SendableLead): Promise<LeadState> {
    return getDb().one<LeadState>(
      `select l.dismissed_at, l.stop_reason, t.use_count, t.first_used_at
         from leads l join action_tokens t on t.lead_id = l.id and t.purpose = 'dismiss'
        where l.id = $1`,
      [lead.leadId],
    );
  }

  async function job(kind: 'followup' | 'lead_process' | 'inbox_check', accountId: string, leadId: string | null, key: string): Promise<JobRow> {
    const now = rig.clock.now();
    const row = await getDb().tx((tx) => insertJob(tx, { kind, accountId, leadId, dedupeKey: key, runAt: new Date(now.getTime() + 2 * DAY), now }));
    if (row === null) throw new Error('job not inserted');
    await publishJobs(rig.deps, [row]);
    return (await getJob(getDb(), row.id)) ?? row;
  }

  const UNTOUCHED: LeadState = { dismissed_at: null, stop_reason: null, use_count: 0, first_used_at: null };

  it('GET shows the confirmation page and never dismisses, however often a scanner opens it', async () => {
    const lead = await seed();
    const followUp = await job('followup', lead.accountId, lead.leadId, `lead:${lead.leadId}:fu:1:s0`);
    for (let i = 0; i < 5; i += 1) expect(await open(lead.dismissToken, { ua: SCANNER })).toEqual({ type: 'confirm' });
    expect(await open(lead.dismissToken)).toEqual({ type: 'confirm' });
    expect(await stateOf(lead)).toEqual(UNTOUCHED);
    expect((await getJob(getDb(), followUp.id))?.status).toBe('scheduled');
    expect(rig.fakes.scheduler.cancelled).toEqual([]);
  });

  it("POST dismisses the lead once: dismissed_at, stop_reason 'dismissed', the token used up and the lead's jobs cancelled", async () => {
    const lead = await seed();
    const other = await seed();
    const fu1 = await job('followup', lead.accountId, lead.leadId, `lead:${lead.leadId}:fu:1:s0`);
    const fu2 = await job('followup', lead.accountId, lead.leadId, `lead:${lead.leadId}:fu:2:s0`);
    const otherFu = await job('followup', other.accountId, other.leadId, `lead:${other.leadId}:fu:1:s0`);

    expect(await post(lead.dismissToken)).toBe('dismissed');
    expect(await stateOf(lead)).toEqual({ dismissed_at: TEST_START, stop_reason: 'dismissed', use_count: 1, first_used_at: TEST_START });
    for (const row of [fu1, fu2]) {
      expect(await getJob(getDb(), row.id)).toMatchObject({ status: 'cancelled', cancelReason: 'dismissed' });
    }
    expect(new Set(rig.fakes.scheduler.cancelled)).toEqual(new Set([fu1.externalId, fu2.externalId]));
    expect((await getJob(getDb(), otherFu.id))?.status).toBe('scheduled');
    expect(await stateOf(other)).toEqual(UNTOUCHED);

    // The page now says it is done.
    expect(await open(lead.dismissToken)).toEqual({ type: 'dismissed' });
    expect(dismissResultPath(lead.dismissToken, 'dismissed')).toBe(`/a/${lead.dismissToken}/dismiss`);
  });

  it('a second POST shows the same result and changes nothing', async () => {
    const lead = await seed();
    expect(await post(lead.dismissToken)).toBe('dismissed');
    rig.clock.advance({ hours: 2 });
    const late = await job('followup', lead.accountId, lead.leadId, `lead:${lead.leadId}:fu:9:s0`);
    expect(await post(lead.dismissToken)).toBe('unchanged');
    expect(await stateOf(lead)).toEqual({ dismissed_at: TEST_START, stop_reason: 'dismissed', use_count: 1, first_used_at: TEST_START });
    expect((await getJob(getDb(), late.id))?.status).toBe('scheduled');
    expect(await open(lead.dismissToken)).toEqual({ type: 'dismissed' });
    expect(dismissResultPath(lead.dismissToken, 'unchanged')).toBe(`/a/${lead.dismissToken}/dismiss`);
  });

  it('dismisses exactly once when two POSTs race', async () => {
    const lead = await seed();
    const results = await Promise.all([post(lead.dismissToken), post(lead.dismissToken)]);
    expect(results.sort()).toEqual(['dismissed', 'unchanged']);
    expect(await stateOf(lead)).toMatchObject({ use_count: 1, stop_reason: 'dismissed' });
  });

  it('keeps an earlier stop reason and dismissal time', async () => {
    const lead = await seed();
    const earlier = new Date(TEST_START.getTime() - DAY);
    await getDb().query(`update leads set dismissed_at = $2, stop_reason = 'replied' where id = $1`, [lead.leadId, earlier]);
    expect(await open(lead.dismissToken)).toEqual({ type: 'dismissed' });
    expect(await post(lead.dismissToken)).toBe('unchanged');
    expect(await stateOf(lead)).toEqual({ dismissed_at: earlier, stop_reason: 'replied', use_count: 1, first_used_at: TEST_START });
  });

  it('only marks the inbox check test lead: its test stop reason stays and the check carries on', async () => {
    const lead = await seed({ isTest: true });
    await getDb().query(`update leads set stop_reason = 'test_lead' where id = $1`, [lead.leadId]);
    const check = await job('inbox_check', lead.accountId, null, `inbox:${lead.accountId}:check-1:1`);
    expect(await post(lead.dismissToken)).toBe('dismissed');
    expect(await stateOf(lead)).toEqual({ dismissed_at: TEST_START, stop_reason: 'test_lead', use_count: 1, first_used_at: TEST_START });
    expect((await getJob(getDb(), check.id))?.status).toBe('scheduled');
    expect(rig.fakes.scheduler.cancelled).toEqual([]);
  });

  it("the inbox check email's edit and dismiss buttons open working pages, and dismissing the test lead only marks it", async () => {
    const inbox = await createInboxRig(getDb());
    const checkId = checkIdOf(await start(inbox));
    const html = inbox.fakes.mailer.sent[0]?.html ?? '';
    const editToken = /\/a\/(apt_[A-Za-z0-9_-]{43})\/edit"/.exec(html)?.[1];
    const dismissToken = /\/a\/(apt_[A-Za-z0-9_-]{43})\/dismiss"/.exec(html)?.[1];
    if (editToken === undefined || dismissToken === undefined) throw new Error('edit or dismiss link missing from the inbox test email');
    const headers = request(dismissToken, 'GET').headers;

    const edit = await editPageState(inbox.deps, editToken, headers);
    expect(edit.type === 'edit' && { recipient: edit.view.recipient, bcc: edit.view.bcc }).toEqual({ recipient: TEST_ADDRESS, bcc: BCC_ADDRESS });
    expect(await dismissPageState(inbox.deps, dismissToken, headers)).toEqual({ type: 'confirm' });

    expect(await submitDismissForm(inbox.deps, dismissToken, request(dismissToken, 'POST').headers)).toBe('dismissed');
    const check = await checkOf(getDb(), checkId);
    const lead = await getDb().one<{ is_test: boolean; dismissed_at: Date | null; stop_reason: string | null }>(
      `select is_test, dismissed_at, stop_reason from leads where id = $1`,
      [check.test_lead_id],
    );
    expect(lead).toEqual({ is_test: true, dismissed_at: inbox.clock.now(), stop_reason: 'test_lead' });
    // The check carries on: still open, its job still scheduled.
    expect(check.status).toBe('open');
    expect((await inboxJobs(getDb())).map((row) => row.status)).toEqual(['scheduled']);
    expect(await dismissPageState(inbox.deps, dismissToken, headers)).toEqual({ type: 'dismissed' });
  });

  it('refuses a POST from another site, or without Origin and Sec-Fetch-Site, and changes nothing', async () => {
    const lead = await seed();
    expect(await post(lead.dismissToken, { origin: 'https://evil.example' })).toBe('refused');
    expect(await post(lead.dismissToken, { origin: null })).toBe('refused');
    expect(await post(lead.dismissToken, { origin: null, secFetchSite: 'cross-site' })).toBe('refused');
    expect(await stateOf(lead)).toEqual(UNTOUCHED);
    expect(dismissResultPath(lead.dismissToken, 'refused')).toBe(`/a/${lead.dismissToken}/dismiss?result=refused`);
    expect(dismissResultAlert('refused')).toBe(DISMISS_RESULT_ALERTS.refused);
    // Origin: null is vouched for by the browser's Sec-Fetch-Site (D-62).
    expect(await post(lead.dismissToken, { origin: 'null', secFetchSite: 'same-origin' })).toBe('dismissed');
  });

  it('explains only its own result codes', () => {
    expect(dismissResultAlert('failed')).toBe(DISMISS_RESULT_ALERTS.failed);
    for (const code of [undefined, '', 'constructor', 'toString', '__proto__', 'dismissed']) expect(dismissResultAlert(code)).toBeNull();
  });

  it('shows the neutral page for a token of another purpose, an unknown, revoked or expired token', async () => {
    const lead = await seed();
    const invalid = { type: 'message', message: ACTION_LINK_MESSAGES.invalid };
    for (const token of [lead.sendToken, lead.editToken, generateActionToken(), 'apt_short']) {
      expect(await open(token)).toEqual(invalid);
      expect(await post(token)).toBe('invalid');
    }
    expect(await stateOf(lead)).toEqual(UNTOUCHED);

    const revoked = await seed();
    await revokeTokens(getDb(), { tokens: [revoked.dismissToken], now: TEST_START });
    expect(await open(revoked.dismissToken)).toEqual(invalid);
    expect(await post(revoked.dismissToken)).toBe('invalid');

    rig.clock.advance({ days: 8 });
    expect(await open(lead.dismissToken)).toEqual(invalid);
    expect(await post(lead.dismissToken)).toBe('invalid');
    expect(await stateOf(lead)).toEqual(UNTOUCHED);
  });

  it('allows 20 requests a minute per token; a rate-limited POST changes nothing', async () => {
    const lead = await seed();
    for (let i = 0; i < 20; i += 1) expect(await open(lead.dismissToken)).toEqual({ type: 'confirm' });
    expect(await open(lead.dismissToken)).toEqual({ type: 'message', message: ACTION_LINK_MESSAGES.rateLimited });
    expect(await post(lead.dismissToken)).toBe('rate_limited');
    expect(await stateOf(lead)).toEqual(UNTOUCHED);
    rig.clock.advance({ minutes: 1 });
    expect(await post(lead.dismissToken)).toBe('dismissed');
  });
});
