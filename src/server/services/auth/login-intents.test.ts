import { describe, expect, it } from 'vitest';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import { consumeLoginIntent, insertLoginIntent, LOGIN_LINK_TTL_MS, loginIntentKey } from './login-intents';

// The server-side half of D-22's "one hour, once": the intent's compare-and-set on PGlite, on its
// own. (Supabase's OTP expiry is configured separately and is longer than an hour in live mode, so
// this statement is what enforces the hour; the confirm tests' fake verify would hide it.)

const getDb = setUpTestDb();
const T = new Date('2000-01-03T09:00:00.000Z');

async function intent(hashedToken: string, now: Date = T): Promise<string> {
  const key = loginIntentKey(hashedToken);
  await insertLoginIntent(getDb(), { key, purpose: 'login', accountId: null, next: '/admin', now });
  return key;
}

describe('consumeLoginIntent', () => {
  it('consumes an intent at T + 1 h − 1 ms, once: a second consume gets nothing', async () => {
    const key = await intent('token-hash-just-in-time-aaaaaaaa');
    const at = new Date(T.getTime() + LOGIN_LINK_TTL_MS - 1);
    expect(await consumeLoginIntent(getDb(), { key, now: at })).toEqual({ purpose: 'login', accountId: null, next: '/admin' });
    expect(await consumeLoginIntent(getDb(), { key, now: at })).toBeNull();
    const row = await getDb().one<{ consumed_at: Date }>(`select consumed_at from login_intents where token_hash_sha256 = $1`, [key]);
    expect(row.consumed_at).toEqual(at);
  });

  it('refuses an intent at exactly T + 1 h and leaves it unconsumed', async () => {
    const key = await intent('token-hash-on-the-hour-bbbbbbbbbb');
    expect(await consumeLoginIntent(getDb(), { key, now: new Date(T.getTime() + LOGIN_LINK_TTL_MS) })).toBeNull();
    const row = await getDb().one<{ consumed_at: Date | null }>(`select consumed_at from login_intents where token_hash_sha256 = $1`, [key]);
    expect(row.consumed_at).toBeNull();
  });

  it('refuses a key it never stored', async () => {
    expect(await consumeLoginIntent(getDb(), { key: loginIntentKey('never-issued-cccccccccccccccc'), now: T })).toBeNull();
  });
});
