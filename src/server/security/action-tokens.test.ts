import { describe, expect, it } from 'vitest';
import { seedAccount, seedLead } from '@/server/jobs/testing';
import { useTestDb as setUpTestDb } from '../../../test/db/harness';
import {
  ACTION_TOKEN_TTL_MS,
  generateActionToken,
  hashActionToken,
  isActionTokenFormat,
  mintActionTokens,
  RevokeFilterRequiredError,
  revokeTokens,
  verifyActionToken,
} from './action-tokens';

const getDb = setUpTestDb();
const NOW = new Date('2026-10-06T14:00:00.000Z');

async function setUp() {
  const db = getDb();
  const accountId = await seedAccount(db, { now: NOW });
  const leadId = await seedLead(db, { accountId, now: NOW });
  const tokens = await db.tx((tx) =>
    mintActionTokens(tx, { accountId, leadId, notificationKey: `notify:${leadId}:initial:r0`, purposes: ['send', 'edit', 'dismiss'], now: NOW }),
  );
  return { db, accountId, leadId, tokens };
}

describe('action tokens', () => {
  it('are apt_ + base64url of 32 random bytes', () => {
    const a = generateActionToken();
    const b = generateActionToken();
    expect(a).toMatch(/^apt_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a.slice(4), 'base64url')).toHaveLength(32);
    expect(a).not.toBe(b);
    expect(isActionTokenFormat(a)).toBe(true);
    expect(isActionTokenFormat(`${a}x`)).toBe(false);
    expect(isActionTokenFormat('apt_short')).toBe(false);
  });

  it('stores only the sha256 hash, with purpose, lead, notification key and a 7-day expiry', async () => {
    const { db, leadId, tokens } = await setUp();
    const rows = await db.query<Record<string, unknown>>(
      `select token_hash, purpose, lead_id, notification_key, expires_at, use_count, revoked_at from action_tokens order by purpose`,
    );
    expect(rows).toHaveLength(3);
    const stored = JSON.stringify(rows);
    for (const token of Object.values(tokens)) expect(stored).not.toContain(token);
    expect(rows.map((r) => r.token_hash).sort()).toEqual(Object.values(tokens).map(hashActionToken).sort());
    expect(rows[0]).toMatchObject({
      purpose: 'dismiss',
      lead_id: leadId,
      notification_key: `notify:${leadId}:initial:r0`,
      expires_at: new Date(NOW.getTime() + ACTION_TOKEN_TTL_MS),
      use_count: 0,
      revoked_at: null,
    });
  });

  it('verify accepts the right purpose until expiry', async () => {
    const { db, tokens, accountId, leadId } = await setUp();
    const result = await verifyActionToken(db, tokens.send ?? '', 'send', NOW);
    expect(result).toMatchObject({ ok: true, token: { accountId, leadId, purpose: 'send', useCount: 0 } });
    expect(await verifyActionToken(db, tokens.send ?? '', 'edit', NOW)).toEqual({ ok: false, reason: 'wrong_purpose' });
    expect(await verifyActionToken(db, tokens.send ?? '', 'send', new Date(NOW.getTime() + ACTION_TOKEN_TTL_MS))).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(await verifyActionToken(db, generateActionToken(), 'send', NOW)).toEqual({ ok: false, reason: 'unknown' });
    expect(await verifyActionToken(db, 'apt_../../etc', 'send', NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('verify refuses revoked tokens and accounts that are disconnected or pending purge', async () => {
    const { db, tokens, accountId } = await setUp();
    await db.query(`update accounts set purge_after = $2 where id = $1`, [accountId, new Date(NOW.getTime() + 30 * 86_400_000)]);
    expect(await verifyActionToken(db, tokens.edit ?? '', 'edit', NOW)).toEqual({ ok: false, reason: 'account_unavailable' });
    await db.query(`update accounts set purge_after = null, processing_state = 'disconnected' where id = $1`, [accountId]);
    expect(await verifyActionToken(db, tokens.edit ?? '', 'edit', NOW)).toEqual({ ok: false, reason: 'account_unavailable' });
    await db.query(`update accounts set processing_state = 'active' where id = $1`, [accountId]);
    expect((await verifyActionToken(db, tokens.edit ?? '', 'edit', NOW)).ok).toBe(true);
    await db.tx((tx) => revokeTokens(tx, { tokens: [tokens.edit ?? ''], now: NOW }));
    expect(await verifyActionToken(db, tokens.edit ?? '', 'edit', NOW)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('revokes by notification key, lead or account, keeping the exceptions', async () => {
    const { db, tokens, leadId, accountId } = await setUp();
    const count = await db.tx((tx) => revokeTokens(tx, { notificationKey: `notify:${leadId}:initial:r0`, except: [tokens.send ?? ''], now: NOW }));
    expect(count).toBe(2);
    expect((await verifyActionToken(db, tokens.send ?? '', 'send', NOW)).ok).toBe(true);
    expect(await db.tx((tx) => revokeTokens(tx, { leadId, now: NOW }))).toBe(1);
    expect(await db.tx((tx) => revokeTokens(tx, { accountId, now: NOW }))).toBe(0);
    expect(await db.tx((tx) => revokeTokens(tx, { tokens: [], now: NOW }))).toBe(0);
  });

  it('refuses a revoke without any filter', async () => {
    const { db } = await setUp();
    await expect(db.tx((tx) => revokeTokens(tx, { now: NOW }))).rejects.toBeInstanceOf(RevokeFilterRequiredError);
  });
});
