import 'server-only';
import { z } from 'zod';
import { LOGIN_INTENT_PURPOSES, type LoginIntentPurpose } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { sha256Hex } from '@/server/security/keys';

// Server-side login intents (PLAN §5, D-22): one row per magic link, keyed by sha256 of the
// Supabase hashed token (the token itself is never stored), holding what the link is for
// (`login` or `onboarding`), the account, where to land and its 1-hour validity. POST
// /auth/confirm consumes it with one compare-and-set, so a link works once and only within the hour.

/** A magic link is valid for 1 hour (D-22), measured on the Clock. */
export const LOGIN_LINK_TTL_MS = 60 * 60 * 1000;

/** `login_intents.token_hash_sha256` for a Supabase hashed token. */
export function loginIntentKey(hashedToken: string): string {
  return sha256Hex(hashedToken);
}

export interface NewLoginIntent {
  /** loginIntentKey(hashedToken). */
  readonly key: string;
  readonly purpose: LoginIntentPurpose;
  /** Null only for an admin login. */
  readonly accountId: string | null;
  /** An allow-listed app path (safeNextPath). */
  readonly next: string;
  readonly now: Date;
}

export async function insertLoginIntent(db: Db, intent: NewLoginIntent): Promise<void> {
  await db.query(
    `insert into login_intents (token_hash_sha256, purpose, account_id, next, expires_at, created_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [intent.key, intent.purpose, intent.accountId, intent.next, new Date(intent.now.getTime() + LOGIN_LINK_TTL_MS), intent.now],
  );
}

export interface ConsumedLoginIntent {
  readonly purpose: LoginIntentPurpose;
  readonly accountId: string | null;
  readonly next: string | null;
}

const consumedRow = z.object({ purpose: z.enum(LOGIN_INTENT_PURPOSES), account_id: z.string().nullable(), next: z.string().nullable() });

/** Marks the intent used if it is unexpired and unused (one compare-and-set); null otherwise. */
export async function consumeLoginIntent(db: Db, input: { key: string; now: Date }): Promise<ConsumedLoginIntent | null> {
  const raw = await db.maybeOne(
    `update login_intents set consumed_at = $2
      where token_hash_sha256 = $1 and consumed_at is null and expires_at > $2
      returning purpose, account_id, next`,
    [input.key, input.now],
  );
  if (raw === null) return null;
  const row = consumedRow.parse(raw);
  return { purpose: row.purpose, accountId: row.account_id, next: row.next };
}
