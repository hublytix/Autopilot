import 'server-only';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { PermanentError } from '@/server/domain/errors';
import { ACTION_TOKEN_PURPOSES, type ActionTokenPurpose } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { sha256Hex } from './keys';

// Action tokens (D-45, PLAN §10.2): `apt_` + base64url(32 random bytes), one per email button. Only
// sha256(token) is stored, with its purpose, lead, draft and notification key; tokens expire after 7
// days. They are minted when a notification is reserved and committed before the email is sent
// (PLAN §8.4 step 3). A token is accepted only for its purpose, unexpired, unrevoked, and while its
// account is neither disconnected nor pending purge. The routes that use them arrive in M3.

export const ACTION_TOKEN_PREFIX = 'apt_';
export const ACTION_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 32;
/** 32 bytes in base64url without padding is 43 characters. */
const TOKEN_FORMAT = /^apt_[A-Za-z0-9_-]{43}$/;

export type MintedTokens = Partial<Record<ActionTokenPurpose, string>>;

export interface MintActionTokensInput {
  accountId: string;
  leadId?: string | null | undefined;
  draftId?: string | null | undefined;
  /** The `notifications_sent.dedupe_key` of the email the buttons go into. */
  notificationKey: string;
  purposes: readonly ActionTokenPurpose[];
  /** `$now`. */
  now: Date;
}

export function generateActionToken(): string {
  return `${ACTION_TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

export function isActionTokenFormat(token: string): boolean {
  return TOKEN_FORMAT.test(token);
}

export function hashActionToken(token: string): string {
  return sha256Hex(token);
}

/** Mints one token per purpose inside `tx`, storing only the hashes. Returns the raw tokens for the email. */
export async function mintActionTokens(tx: Db, input: MintActionTokensInput): Promise<MintedTokens> {
  const tokens: MintedTokens = {};
  const expiresAt = new Date(input.now.getTime() + ACTION_TOKEN_TTL_MS);
  for (const purpose of new Set(input.purposes)) {
    const token = generateActionToken();
    await tx.query(
      `insert into action_tokens (token_hash, account_id, lead_id, draft_id, notification_key, purpose, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [hashActionToken(token), input.accountId, input.leadId ?? null, input.draftId ?? null, input.notificationKey, purpose, expiresAt],
    );
    tokens[purpose] = token;
  }
  return tokens;
}

export interface RevokeTokensInput {
  notificationKey?: string | undefined;
  leadId?: string | undefined;
  accountId?: string | undefined;
  /** Exactly these raw tokens (e.g. the ones just minted for a send that will not go out). */
  tokens?: readonly string[] | undefined;
  /** Raw tokens to keep valid. */
  except?: readonly string[] | undefined;
  /** `$now`. */
  now: Date;
}

export class RevokeFilterRequiredError extends PermanentError<'action_token_revoke_filter_required'> {
  override readonly name: string = 'RevokeFilterRequiredError';

  constructor() {
    super('action_token_revoke_filter_required');
  }
}

/** Revokes the matching unrevoked tokens (all filters given must match). Returns how many. */
export async function revokeTokens(tx: Db, input: RevokeTokensInput): Promise<number> {
  if (input.notificationKey === undefined && input.leadId === undefined && input.accountId === undefined && input.tokens === undefined) {
    throw new RevokeFilterRequiredError();
  }
  if (input.tokens !== undefined && input.tokens.length === 0) return 0;
  const params: unknown[] = [input.now];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = ['revoked_at is null'];
  if (input.notificationKey !== undefined) where.push(`notification_key = ${bind(input.notificationKey)}`);
  if (input.leadId !== undefined) where.push(`lead_id = ${bind(input.leadId)}`);
  if (input.accountId !== undefined) where.push(`account_id = ${bind(input.accountId)}`);
  if (input.tokens !== undefined) where.push(`token_hash = any(${bind(input.tokens.map(hashActionToken))}::text[])`);
  if (input.except !== undefined && input.except.length > 0) {
    where.push(`token_hash <> all(${bind(input.except.map(hashActionToken))}::text[])`);
  }
  const rows = await tx.query(`update action_tokens set revoked_at = $1 where ${where.join(' and ')} returning id`, params);
  return rows.length;
}

export interface VerifiedActionToken {
  id: string;
  accountId: string;
  leadId: string | null;
  draftId: string | null;
  notificationKey: string | null;
  purpose: ActionTokenPurpose;
  expiresAt: Date;
  firstUsedAt: Date | null;
  useCount: number;
}

export type ActionTokenRejection = 'malformed' | 'unknown' | 'wrong_purpose' | 'expired' | 'revoked' | 'account_unavailable';

export type VerifyActionTokenResult = { ok: true; token: VerifiedActionToken } | { ok: false; reason: ActionTokenRejection };

const tokenRowSchema = z.object({
  id: z.string(),
  account_id: z.string(),
  lead_id: z.string().nullable(),
  draft_id: z.string().nullable(),
  notification_key: z.string().nullable(),
  purpose: z.enum(ACTION_TOKEN_PURPOSES),
  expires_at: z.date(),
  first_used_at: z.date().nullable(),
  use_count: z.number(),
  revoked_at: z.date().nullable(),
  account_state: z.string(),
  purge_after: z.date().nullable(),
});

/**
 * Looks a token up by its hash and checks purpose, expiry, revocation and the account (not
 * disconnected, no purge pending). Records nothing: the routes count uses (M3).
 */
export async function verifyActionToken(db: Db, token: string, purpose: ActionTokenPurpose, now: Date): Promise<VerifyActionTokenResult> {
  if (!isActionTokenFormat(token)) return { ok: false, reason: 'malformed' };
  const raw = await db.maybeOne(
    `select t.id, t.account_id, t.lead_id, t.draft_id, t.notification_key, t.purpose, t.expires_at, t.first_used_at,
            t.use_count, t.revoked_at, a.processing_state as account_state, a.purge_after
       from action_tokens t join accounts a on a.id = t.account_id
      where t.token_hash = $1`,
    [hashActionToken(token)],
  );
  if (raw === null) return { ok: false, reason: 'unknown' };
  const row = tokenRowSchema.parse(raw);
  if (row.purpose !== purpose) return { ok: false, reason: 'wrong_purpose' };
  if (row.revoked_at !== null) return { ok: false, reason: 'revoked' };
  if (row.expires_at.getTime() <= now.getTime()) return { ok: false, reason: 'expired' };
  if (row.account_state === 'disconnected' || row.purge_after !== null) return { ok: false, reason: 'account_unavailable' };
  return {
    ok: true,
    token: {
      id: row.id,
      accountId: row.account_id,
      leadId: row.lead_id,
      draftId: row.draft_id,
      notificationKey: row.notification_key,
      purpose: row.purpose,
      expiresAt: row.expires_at,
      firstUsedAt: row.first_used_at,
      useCount: row.use_count,
    },
  };
}
