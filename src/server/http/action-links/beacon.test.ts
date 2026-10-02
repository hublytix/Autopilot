import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDb } from '../../../../test/db/harness';
import { createJobRegistry } from '@/server/jobs';
import { createJobTestRig, TEST_START, type JobTestRig } from '@/server/jobs/testing';
import { hashActionToken, revokeTokens } from '@/server/security/action-tokens';
import { issueBeacon } from '@/server/services/action-links';
import { clickStateOf, seedSendableLead, type SendableLead } from '@/server/services/action-links/testing';
import { handleBeacon } from '.';

// POST /a/{token}/beacon (D-26): a nonce issued with a page counts once as the owner's click.

const APP = 'http://localhost:3000';
const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

describe('POST /a/{token}/beacon', () => {
  const getDb = useTestDb();
  let rig: JobTestRig;
  let lead: SendableLead;

  beforeEach(async () => {
    rig = createJobTestRig(getDb(), createJobRegistry(), { start: TEST_START });
    // Sent just now: only the beacon can count a click.
    lead = await seedSendableLead(getDb(), { now: TEST_START, sentAt: TEST_START });
  });

  async function tokenId(token: string): Promise<string> {
    return (await getDb().one<{ id: string }>(`select id from action_tokens where token_hash = $1`, [hashActionToken(token)])).id;
  }

  interface BeaconOptions {
    origin?: string | null;
    fetchSite?: string;
    ua?: string;
    body?: string;
    ip?: string;
  }

  async function post(token: string, nonce: string, options: BeaconOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': options.ua ?? PHONE, 'x-real-ip': options.ip ?? '203.0.113.7' };
    if (options.origin !== null) headers.origin = options.origin ?? APP;
    if (options.fetchSite !== undefined) headers['sec-fetch-site'] = options.fetchSite;
    const req = new Request(`${APP}/a/${token}/beacon`, { method: 'POST', headers, body: options.body ?? JSON.stringify({ n: nonce }) });
    return handleBeacon(req, rig.deps, token);
  }

  describe('POST /a/{token}/beacon', () => {
    it('records the click once for a nonce issued with the page', async () => {
      const nonce = await issueBeacon(rig.deps, await tokenId(lead.sendToken));
      rig.clock.advance(2_000);
      const res = await post(lead.sendToken, nonce);
      expect(res.status).toBe(204);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(await clickStateOf(getDb(), lead)).toEqual({ firstSendClickedAt: rig.clock.now(), useCount: 1, firstUsedAt: rig.clock.now() });

      // The nonce is single use.
      expect((await post(lead.sendToken, nonce)).status).toBe(404);
      expect((await clickStateOf(getDb(), lead)).useCount).toBe(1);
    });

    it('accepts Sec-Fetch-Site: same-origin when the browser sends no Origin', async () => {
      const nonce = await issueBeacon(rig.deps, await tokenId(lead.sendToken));
      expect((await post(lead.sendToken, nonce, { origin: null, fetchSite: 'same-origin' })).status).toBe(204);
    });

    it('refuses a cross-origin or opaque-origin post without using the nonce up', async () => {
      const nonce = await issueBeacon(rig.deps, await tokenId(lead.sendToken));
      expect((await post(lead.sendToken, nonce, { origin: 'https://evil.example' })).status).toBe(403);
      expect((await post(lead.sendToken, nonce, { origin: 'null' })).status).toBe(403);
      expect((await post(lead.sendToken, nonce, { origin: null })).status).toBe(403);
      expect((await clickStateOf(getDb(), lead)).firstSendClickedAt).toBeNull();
      expect((await post(lead.sendToken, nonce)).status).toBe(204);
    });

    it('refuses a nonce issued for another token, an unknown nonce and an expired one', async () => {
      const other = await seedSendableLead(getDb(), { now: TEST_START });
      const foreign = await issueBeacon(rig.deps, await tokenId(other.sendToken));
      expect((await post(lead.sendToken, foreign)).status).toBe(404);
      expect((await post(lead.sendToken, 'AAAAAAAAAAAAAAAAAAAAAA')).status).toBe(404);

      const stale = await issueBeacon(rig.deps, await tokenId(lead.sendToken));
      rig.clock.advance({ minutes: 15 });
      expect((await post(lead.sendToken, stale)).status).toBe(404);
      expect((await clickStateOf(getDb(), lead)).firstSendClickedAt).toBeNull();
    });

    it('accepts but does not record a beacon from a scanner user agent', async () => {
      const nonce = await issueBeacon(rig.deps, await tokenId(lead.sendToken));
      const res = await post(lead.sendToken, nonce, { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/138.0.0.0 Safari/537.36' });
      expect(res.status).toBe(204);
      expect((await clickStateOf(getDb(), lead)).firstSendClickedAt).toBeNull();
    });

    it("counts the edit page's beacon (M4) as the owner opening the link", async () => {
      const nonce = await issueBeacon(rig.deps, await tokenId(lead.editToken));
      expect((await post(lead.editToken, nonce)).status).toBe(204);
      expect((await clickStateOf(getDb(), lead)).firstSendClickedAt).toEqual(TEST_START);
      const edit = await getDb().one<{ use_count: number }>(`select use_count from action_tokens where token_hash = $1`, [hashActionToken(lead.editToken)]);
      expect(edit.use_count).toBe(1);
    });

    it('refuses a dismiss token and a revoked token', async () => {
      const dismissNonce = await issueBeacon(rig.deps, await tokenId(lead.dismissToken));
      expect((await post(lead.dismissToken, dismissNonce)).status).toBe(404);

      const nonce = await issueBeacon(rig.deps, await tokenId(lead.sendToken));
      await revokeTokens(getDb(), { tokens: [lead.sendToken], now: TEST_START });
      expect((await post(lead.sendToken, nonce)).status).toBe(404);
      expect((await clickStateOf(getDb(), lead)).firstSendClickedAt).toBeNull();
    });

    it('refuses malformed and oversized bodies', async () => {
      const nonce = await issueBeacon(rig.deps, await tokenId(lead.sendToken));
      expect((await post(lead.sendToken, nonce, { body: 'not json' })).status).toBe(400);
      expect((await post(lead.sendToken, nonce, { body: JSON.stringify({ n: 1 }) })).status).toBe(400);
      expect((await post(lead.sendToken, nonce, { body: JSON.stringify({ n: nonce, extra: true }) })).status).toBe(400);
      expect((await post(lead.sendToken, nonce, { body: JSON.stringify({ n: 'x'.repeat(2000) }) })).status).toBe(413);
      // None of these used the nonce.
      expect((await post(lead.sendToken, nonce)).status).toBe(204);
    });

    it('shares the /a/* per-token rate limit', async () => {
      for (let i = 0; i < 20; i++) {
        expect((await post(lead.sendToken, 'AAAAAAAAAAAAAAAAAAAAAA', { ip: `198.51.100.${i}` })).status).toBe(404);
      }
      const limited = await post(lead.sendToken, 'AAAAAAAAAAAAAAAAAAAAAA', { ip: '198.51.100.99' });
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBe('60');
    });
  });
});
