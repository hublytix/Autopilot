import 'server-only';

// /admin's read model (PLAN §3 views/, §7.5): audited on every call, no content.
export { adminPageView, formatUsd, formatUtc } from './admin';
export type { AdminPageView, AdminPortalView } from './admin';
