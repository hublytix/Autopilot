import 'server-only';

// The admin area (PLAN §7.5, brief §5.12): a read-only overview with no content, and the audit row
// every view writes. Access is requireAdmin (ADMIN_EMAILS; everyone else gets a 404). Import from here.
export { ADMIN_VIEW_ACTION, recordAdminView } from './audit';
export { ADMIN_PORTALS_LIMIT, ADMIN_RECENT_FAILED_JOBS, loadAdminOverview, STUCK_SENDING_AFTER_MS } from './overview';
export type { AdminOverview, AdminPortalRow, AiWindow, CodeCount, FailedJobRow } from './overview';
