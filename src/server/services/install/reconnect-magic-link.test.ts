import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleConfirmPost } from '@/server/http/auth/confirm';
import { createJobRegistry } from '@/server/jobs/registry';
import { createJobTestRig, seedAccount, type JobTestRig } from '@/server/jobs/testing';
import { CookieJar } from '@/server/security/cookies';
import { seedOwner } from '@/server/services/accounts/testing';
import { resolveOwner } from '@/server/services/auth/owner-scope';
import { confirmPostRequest, deliveredMagicLinks, lastMagicLink } from '@/server/services/auth/testing';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import { RECONNECT_NEXT, sendReconnectMagicLink } from './reconnect-magic-link';

const getDb = setUpTestDb();
let rig: JobTestRig;

const OWNER = 'Owner@Brightside-Plumbing.example';

beforeEach(() => {
  rig = createJobTestRig(getDb(), createJobRegistry());
  for (const method of ['info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('branch (d): the owner reinstalls without a session', () => {
  it('emails the owner a sign-in link that lands on /dashboard?reconnect=1', async () => {
    const accountId = await seedAccount(getDb(), { now: rig.clock.now() });
    const { userId } = await rig.fakes.auth.createUser(OWNER);
    await seedOwner(getDb(), accountId, OWNER, userId);

    await expect(sendReconnectMagicLink(rig.deps, { accountId })).resolves.toBe(true);
    const link = lastMagicLink(rig.fakes);
    expect(link.to).toEqual([OWNER.toLowerCase()]);
    expect(link.subject).toContain('reconnecting HubSpot');
    expect(link.text).toContain('Nothing has changed yet');
    expect(await getDb().query(`select purpose, account_id, next from login_intents`)).toEqual([{ purpose: 'login', account_id: accountId, next: RECONNECT_NEXT }]);

    const jar = new CookieJar();
    const res = await handleConfirmPost(confirmPostRequest(rig.deps.env.APP_URL, { tokenHash: link.tokenHash, type: link.type }), rig.deps);
    jar.storeFrom(res);
    expect(res.headers.get('location')).toBe(`${rig.deps.env.APP_URL}/dashboard?reconnect=1`);
    expect(await resolveOwner(rig.deps, jar.request(`${rig.deps.env.APP_URL}/dashboard`))).toEqual({ accountId, userId });
  });

  it('sends nothing for an account without a bound owner', async () => {
    const accountId = await seedAccount(getDb(), { now: rig.clock.now() });
    await expect(sendReconnectMagicLink(rig.deps, { accountId })).resolves.toBe(false);
    expect(rig.fakes.mailer.sent).toEqual([]);
  });

  it("shares /login's per-email limit: at most 3 links per 15 minutes", async () => {
    const accountId = await seedAccount(getDb(), { now: rig.clock.now() });
    const { userId } = await rig.fakes.auth.createUser(OWNER);
    await seedOwner(getDb(), accountId, OWNER, userId);
    const sent: boolean[] = [];
    for (let i = 0; i < 5; i += 1) sent.push(await sendReconnectMagicLink(rig.deps, { accountId }));
    expect(deliveredMagicLinks(rig.fakes)).toHaveLength(3);
    expect(sent).toEqual([true, true, true, false, false]);
  });
});
