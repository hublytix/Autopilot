import 'server-only';
import type { Db } from '@/server/db';
import { insertAudit } from '@/server/services/audit';

// Every /admin page view is audited (PLAN §7.5 "views audited", brief §5.12): one `audit_log` row per
// view, actor `admin`, action `admin.view`, no account, and which admin looked: `meta.adminUserId`,
// the auth user id (D-82). Never the admin's address or anything the page showed (law 4).
// `audit_log.at` is the audit-only column (D-28).

export const ADMIN_VIEW_ACTION = 'admin.view';

export async function recordAdminView(db: Db, adminUserId: string): Promise<void> {
  await insertAudit(db, { accountId: null, actor: 'admin', action: ADMIN_VIEW_ACTION, level: 'info', meta: { adminUserId } });
}
