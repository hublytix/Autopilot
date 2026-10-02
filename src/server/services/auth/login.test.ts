import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJobRegistry } from '@/server/jobs/registry';
import { createJobTestRig, type JobTestRig } from '@/server/jobs/testing';
import { seedOwner } from '@/server/services/accounts/testing';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import { LOGIN_LATENCY_FLOOR_MS, requestLoginLink, type LoginInput, type LoginResult } from './login';
import { deliveredMagicLinks, seedPendingInstall } from './testing';

const getDb = setUpTestDb();
let rig: JobTestRig;

const OWNER = 'owner@brightside-plumbing.example';
const ADMIN = 'fake-only-admin@example.com';
const noSleep = async (): Promise<void> => undefined;

/** /login without the floor, then waits for the work the action hands to after(). */
async function login(input: LoginInput): Promise<LoginResult> {
  const deferred: Promise<void>[] = [];
  const result = await requestLoginLink(rig.deps, input, { sleep: noSleep, defer: (work) => deferred.push(work) });
  await Promise.all(deferred);
  return result;
}

beforeEach(() => {
  rig = createJobTestRig(getDb(), createJobRegistry());
  for (const method of ['info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function intents() {
  return getDb().query<{ purpose: string; account_id: string | null; next: string; expires_at: Date; created_at: Date }>(
    `select purpose, account_id, next, expires_at, created_at from login_intents order by created_at`,
  );
}

async function boundOwner(email = OWNER): Promise<{ accountId: string; userId: string }> {
  const { accountId } = await seedPendingInstall(rig.deps);
  const { userId } = await rig.fakes.auth.createUser(email);
  await seedOwner(getDb(), accountId, email, userId);
  return { accountId, userId };
}

describe('/login sends a link only to someone who may sign in', () => {
  it('(a) a bound owner gets a login link to /dashboard, valid for 1 hour, with Reply-To', async () => {
    const { accountId } = await boundOwner();
    const result = await login({ email: '  Owner@Brightside-Plumbing.example ', ip: '203.0.113.1' });
    expect(result).toEqual({ type: 'neutral' });
    const links = deliveredMagicLinks(rig.fakes);
    expect(links).toHaveLength(1);
    expect(links[0]?.to).toEqual([OWNER]);
    expect(links[0]?.replyTo).toBe(rig.deps.env.EMAIL_REPLY_TO);
    expect(links[0]?.url.startsWith(`${rig.deps.env.APP_URL}/auth/confirm#th=`)).toBe(true);
    expect(links[0]?.text).toContain('expires in 1 hour');
    expect(links[0]?.text).toContain("If you didn't ask for this email, you can ignore it");
    const now = rig.clock.now();
    expect(await intents()).toEqual([{ purpose: 'login', account_id: accountId, next: '/dashboard', expires_at: new Date(now.getTime() + 3_600_000), created_at: now }]);
  });

  it('(b) an unexpired pending owner email gets an onboarding link for that account', async () => {
    const { accountId } = await seedPendingInstall(rig.deps);
    await getDb().query(`update accounts set pending_owner_email = $2, pending_owner_expires_at = $3 where id = $1`, [
      accountId,
      'pending@brightside-plumbing.example',
      new Date(rig.clock.now().getTime() + 3_600_000),
    ]);
    await login({ email: 'pending@brightside-plumbing.example', ip: '203.0.113.2' });
    expect(deliveredMagicLinks(rig.fakes).map((link) => link.to)).toEqual([['pending@brightside-plumbing.example']]);
    expect(await intents()).toMatchObject([{ purpose: 'onboarding', account_id: accountId, next: '/onboarding/brief' }]);
    // The auth user exists (created here if the email step's user was missing).
    expect(await rig.fakes.auth.findUserByEmail('pending@brightside-plumbing.example')).not.toBeNull();
  });

  it('an expired pending owner email gets nothing', async () => {
    const { accountId } = await seedPendingInstall(rig.deps);
    await getDb().query(`update accounts set pending_owner_email = $2, pending_owner_expires_at = $3 where id = $1`, [
      accountId,
      'late@brightside-plumbing.example',
      rig.clock.now(),
    ]);
    await login({ email: 'late@brightside-plumbing.example', ip: '203.0.113.3' });
    expect(deliveredMagicLinks(rig.fakes)).toEqual([]);
    expect(await intents()).toEqual([]);
  });

  it('(c) an ADMIN_EMAILS address gets a login link to /admin (its auth user is created first)', async () => {
    await login({ email: ADMIN.toUpperCase(), ip: '203.0.113.4' });
    expect(deliveredMagicLinks(rig.fakes).map((link) => link.to)).toEqual([[ADMIN]]);
    expect(await intents()).toMatchObject([{ purpose: 'login', account_id: null, next: '/admin' }]);
  });

  it('anyone else gets nothing: no email, no intent, no auth user', async () => {
    await login({ email: 'stranger@example.com', ip: '203.0.113.5' });
    expect(deliveredMagicLinks(rig.fakes)).toEqual([]);
    expect(await intents()).toEqual([]);
    expect(rig.fakes.auth.users()).toEqual([]);
  });

  it('an invalid address gets the same neutral answer', async () => {
    await expect(login({ email: 'not-an-email', ip: '203.0.113.6' })).resolves.toEqual({ type: 'neutral' });
    await expect(login({ email: null, ip: '203.0.113.6' })).resolves.toEqual({ type: 'neutral' });
    expect(rig.fakes.mailer.sent).toEqual([]);
  });

  it('a failing send still answers neutrally', async () => {
    await boundOwner();
    rig.fakes.mailer.injectFailure({ kind: 'permanent', code: 'validation_error' });
    await expect(login({ email: OWNER, ip: '203.0.113.7' })).resolves.toEqual({ type: 'neutral' });
  });
});

describe('/login latency floor', () => {
  it('answers at ~800 ms, whether or not the address has an account', async () => {
    vi.useFakeTimers();
    await boundOwner();
    for (const email of [OWNER, 'nobody@example.com', 'bad']) {
      let settled = false;
      const deferred: Promise<void>[] = [];
      const pending = requestLoginLink(rig.deps, { email, ip: `198.51.100.${email.length}` }, { defer: (work) => deferred.push(work) }).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(LOGIN_LATENCY_FLOOR_MS - 1);
      expect(settled, email).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(settled, email).toBe(true);
      await Promise.all(deferred);
    }
    expect(LOGIN_LATENCY_FLOOR_MS).toBe(800);
  });

  it('answers at the floor even when generating and emailing the link takes 5 s; the link still goes out', async () => {
    vi.useFakeTimers();
    await boundOwner();
    const slow = async (): Promise<void> => {
      await new Promise<void>((resolve) => setTimeout(resolve, 2_500));
    };
    const generateLink = rig.fakes.auth.generateLink.bind(rig.fakes.auth);
    vi.spyOn(rig.fakes.auth, 'generateLink').mockImplementation(async (...args) => {
      await slow();
      return generateLink(...args);
    });
    const send = rig.fakes.mailer.send.bind(rig.fakes.mailer);
    vi.spyOn(rig.fakes.mailer, 'send').mockImplementation(async (...args) => {
      await slow();
      return send(...args);
    });

    let settled = false;
    const deferred: Promise<void>[] = [];
    const pending = requestLoginLink(rig.deps, { email: OWNER, ip: '198.51.100.77' }, { defer: (work) => deferred.push(work) }).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(LOGIN_LATENCY_FLOOR_MS);
    await pending;
    expect(settled).toBe(true);
    expect(deferred).toHaveLength(1);
    // The answer is out; the link is still being made.
    expect(deliveredMagicLinks(rig.fakes)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all(deferred);
    expect(deliveredMagicLinks(rig.fakes)).toHaveLength(1);
  });
});

describe('/login rate limits', () => {
  it('sends at most 3 links per email per 15 minutes (still neutral after that)', async () => {
    await boundOwner();
    for (let i = 0; i < 5; i += 1) {
      await expect(login({ email: OWNER, ip: `192.0.2.${i}` })).resolves.toEqual({ type: 'neutral' });
    }
    expect(deliveredMagicLinks(rig.fakes)).toHaveLength(3);
    rig.clock.advance({ minutes: 15 });
    await login({ email: OWNER, ip: '192.0.2.9' });
    expect(deliveredMagicLinks(rig.fakes)).toHaveLength(4);
  });

  it('accepts at most 5 requests per IP per 15 minutes', async () => {
    const owners = ['o1@example.com', 'o2@example.com', 'o3@example.com', 'o4@example.com', 'o5@example.com', 'o6@example.com'];
    for (const email of owners) await boundOwner(email);
    for (const email of owners) await login({ email, ip: '203.0.113.99' });
    expect(deliveredMagicLinks(rig.fakes).map((link) => link.to[0])).toEqual(owners.slice(0, 5));
  });

  it('stores only HMACs of the IP and the email', async () => {
    await login({ email: OWNER, ip: '203.0.113.42' });
    const keys = await getDb().query<{ key_hash: string }>(`select key_hash from rate_limits`);
    expect(keys.length).toBeGreaterThan(0);
    for (const { key_hash } of keys) expect(key_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
