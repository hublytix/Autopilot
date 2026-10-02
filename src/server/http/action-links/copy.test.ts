import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDb } from '../../../../test/db/harness';
import { createJobRegistry } from '@/server/jobs';
import { createJobTestRig, TEST_START, type JobTestRig } from '@/server/jobs/testing';
import { generateActionToken } from '@/server/security/action-tokens';
import { clickStateOf, SAMPLE_REPLY, seedSendableLead } from '@/server/services/action-links/testing';
import { ACTION_LINK_MESSAGES, copyPageState, handleBeacon } from '.';

// GET /a/{token}/copy (PLAN §7.4): the page state the Server Component renders.

const APP = 'http://localhost:3000';
describe('GET /a/{token}/copy', () => {
  const getDb = useTestDb();
  let rig: JobTestRig;

  beforeEach(() => {
    rig = createJobTestRig(getDb(), createJobRegistry(), { start: TEST_START });
  });

  const headersFor = (ip = '203.0.113.7'): Headers => new Headers({ 'x-real-ip': ip });

  describe('copy page state', () => {
    it('shows the recipient, subject, message and BCC address, and records nothing by itself', async () => {
      const lead = await seedSendableLead(getDb(), { now: TEST_START, sentAt: TEST_START, bcc: '1234567@bcc.hubspot.com' });
      const state = await copyPageState(rig.deps, lead.sendToken, headersFor());
      if (state.type !== 'copy') throw new Error(`unexpected ${state.type}`);
      expect(state.view).toMatchObject({
        recipient: SAMPLE_REPLY.recipient,
        recipientValid: true,
        subject: SAMPLE_REPLY.subject,
        body: SAMPLE_REPLY.body,
        bcc: '1234567@bcc.hubspot.com',
        mailtoFits: true,
      });
      expect(state.view.beaconNonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(state.beaconPath).toBe(`/a/${lead.sendToken}/beacon`);
      expect(state.mailtoPath).toBe(`/a/${lead.sendToken}/send?via=mailto`);
      expect(state.neverSends).toContain('never sends email for you');
      expect((await clickStateOf(getDb(), lead)).firstSendClickedAt).toBeNull();

      // The page's beacon counts the click.
      const beacon = new Request(`${APP}/a/${lead.sendToken}/beacon`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: APP, 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148', 'x-real-ip': '203.0.113.7' },
        body: JSON.stringify({ n: state.view.beaconNonce }),
      });
      expect((await handleBeacon(beacon, rig.deps, lead.sendToken)).status).toBe(204);
      expect((await clickStateOf(getDb(), lead)).firstSendClickedAt).toEqual(TEST_START);
    });

    it('flags an unusual recipient and offers no mail-app link for it', async () => {
      const lead = await seedSendableLead(getDb(), { now: TEST_START, recipient: 'jane@example.com, evil@example.net' });
      const state = await copyPageState(rig.deps, lead.sendToken, headersFor());
      if (state.type !== 'copy') throw new Error(`unexpected ${state.type}`);
      expect(state.view.recipientValid).toBe(false);
      expect(state.view.recipient).toBe('jane@example.com, evil@example.net');
      expect(state.mailtoPath).toBeNull();
    });

    it('handles a lead without an address', async () => {
      const lead = await seedSendableLead(getDb(), { now: TEST_START, recipient: null });
      const state = await copyPageState(rig.deps, lead.sendToken, headersFor());
      if (state.type !== 'copy') throw new Error(`unexpected ${state.type}`);
      expect(state.view).toMatchObject({ recipient: null, recipientValid: false, mailtoFits: false });
    });

    it('offers no mail-app link when the mailto: URL would be too long', async () => {
      const lead = await seedSendableLead(getDb(), { now: TEST_START, body: 'word '.repeat(600) });
      const state = await copyPageState(rig.deps, lead.sendToken, headersFor());
      if (state.type !== 'copy') throw new Error(`unexpected ${state.type}`);
      expect(state.view.mailtoFits).toBe(false);
      expect(state.mailtoPath).toBeNull();
    });

    it('shows "This draft has expired" once the content is purged', async () => {
      const lead = await seedSendableLead(getDb(), { now: TEST_START });
      await getDb().query(`update drafts set subject = null, body = null, purged_at = $2 where id = $1`, [lead.draftId, TEST_START]);
      expect(await copyPageState(rig.deps, lead.sendToken, headersFor())).toEqual({ type: 'message', message: ACTION_LINK_MESSAGES.expired });
    });

    it('shows the neutral page for an unusable token and for an edit token', async () => {
      const lead = await seedSendableLead(getDb(), { now: TEST_START });
      for (const token of [generateActionToken(), 'apt_short', lead.editToken]) {
        expect(await copyPageState(rig.deps, token, headersFor())).toEqual({ type: 'message', message: ACTION_LINK_MESSAGES.invalid });
      }
    });

    it('shares the /a/* per-token rate limit', async () => {
      const lead = await seedSendableLead(getDb(), { now: TEST_START });
      for (let i = 0; i < 20; i++) {
        expect((await copyPageState(rig.deps, lead.sendToken, headersFor(`198.51.100.${i}`))).type).toBe('copy');
      }
      expect(await copyPageState(rig.deps, lead.sendToken, headersFor('198.51.100.99'))).toEqual({ type: 'message', message: ACTION_LINK_MESSAGES.rateLimited });
    });
  });
});
