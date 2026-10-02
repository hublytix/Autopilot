import 'server-only';
import { z } from 'zod';
import type { Db } from '@/server/db';
import { timingSafeEqualHex } from '@/server/security/keys';

// The inbox-check skip (PLAN §9.2 step 1, D-14): a submission from the owner's test address is never
// a lead. It is skipped when HMAC(lower(email)) equals the `test_address_hmac` of an inbox check on
// the account with `check.created_at − 1 h ≤ submittedAt < check.created_at + 24 h`. The window is
// tested against submittedAt, not $now, so the skip never lapses for that submission, and the HMAC
// is kept after `test_address` is cleared. Checks of every status count.

export const TEST_ADDRESS_WINDOW_BEFORE_MS = 60 * 60 * 1000;
export const TEST_ADDRESS_WINDOW_AFTER_MS = 24 * 60 * 60 * 1000;

export interface InboxCheckWindow {
  readonly addressHmac: string;
  readonly createdAt: Date;
}

const checkSchema = z.object({ test_address_hmac: z.string(), created_at: z.date() });

export async function loadInboxCheckWindows(db: Db, accountId: string): Promise<InboxCheckWindow[]> {
  const rows = await db.query(`select test_address_hmac, created_at from inbox_checks where account_id = $1`, [accountId]);
  return rows.map((raw) => {
    const row = checkSchema.parse(raw);
    return { addressHmac: row.test_address_hmac, createdAt: row.created_at };
  });
}

/** True when a submission with this email HMAC, made at `submittedAt`, is an inbox-check test. */
export function isTestAddressSubmission(windows: readonly InboxCheckWindow[], emailHmac: string, submittedAt: Date): boolean {
  const at = submittedAt.getTime();
  return windows.some(
    (check) =>
      at >= check.createdAt.getTime() - TEST_ADDRESS_WINDOW_BEFORE_MS &&
      at < check.createdAt.getTime() + TEST_ADDRESS_WINDOW_AFTER_MS &&
      timingSafeEqualHex(check.addressHmac, emailHmac),
  );
}
