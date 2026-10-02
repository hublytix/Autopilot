import 'server-only';
import { PermanentError } from '@/server/domain/errors';
import type { Db } from '@/server/db';

// `audit_log` writes (PLAN §5: `meta jsonb (allow-listed keys)`, law 4). The table has no retention
// and a privacy deletion does not touch it, so meta may hold only ids, codes, counts and instants:
// never content, addresses, tokens, or anything derived from them (an HMAC of an email is still a
// pseudonymous identifier of the lead, D-31). Keys outside AUDIT_META_KEYS, and string values that
// do not look like an id, a code or an ISO instant, are refused before anything is written.

export const AUDIT_META_KEYS = ['formId', 'submittedAt'] as const;
export type AuditMetaKey = (typeof AUDIT_META_KEYS)[number];
export type AuditMeta = Partial<Record<AuditMetaKey, string | number | boolean | null>>;

export type AuditLevel = 'info' | 'warn' | 'error';

// Ids (HubSpot ids, uuids), snake_case codes and ISO instants: no '@', spaces or free text.
const SAFE_STRING = /^[A-Za-z0-9:._+-]{0,200}$/;

export class AuditMetaRefusedError extends PermanentError<'audit_meta_refused'> {
  override readonly name: string = 'AuditMetaRefusedError';

  constructor() {
    super('audit_meta_refused');
  }
}

/** Throws unless every key is allow-listed and every value is a scalar of a safe shape. */
export function assertAuditMeta(meta: Readonly<Record<string, unknown>>): AuditMeta {
  for (const [key, value] of Object.entries(meta)) {
    if (!(AUDIT_META_KEYS as readonly string[]).includes(key)) throw new AuditMetaRefusedError();
    const safe =
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && SAFE_STRING.test(value));
    if (!safe) throw new AuditMetaRefusedError();
  }
  return meta as AuditMeta;
}

export interface AuditEntry {
  accountId: string | null;
  actor: 'system' | 'owner' | 'admin';
  /** A dotted code, e.g. `intake.contact_not_found`. */
  action: string;
  level: AuditLevel;
  meta: AuditMeta;
}

/**
 * Inserts the entry unless one with the same account, action and the values of `sameKeys` exists.
 * Returns true when a row was written.
 */
export async function insertAuditOnce(db: Db, entry: AuditEntry, sameKeys: readonly AuditMetaKey[]): Promise<boolean> {
  const meta = assertAuditMeta(entry.meta);
  const params: unknown[] = [entry.accountId, entry.actor, entry.action, entry.level, meta];
  const same = sameKeys.map((key) => {
    params.push(key, meta[key] === undefined || meta[key] === null ? null : String(meta[key]));
    return `a.meta ->> $${params.length - 1}::text is not distinct from $${params.length}::text`;
  });
  const rows = await db.query(
    `insert into audit_log (account_id, actor, action, level, meta)
     select $1::uuid, $2::text, $3::text, $4::text, $5::jsonb
      where not exists (
        select 1 from audit_log a
         where a.account_id is not distinct from $1::uuid and a.action = $3::text ${same.map((clause) => `and ${clause}`).join(' ')})
     returning id`,
    params,
  );
  return rows.length === 1;
}
