import 'server-only';

// Owner action-link route handlers and page state (PLAN §7.4): /a/{token}/send, /a/{token}/beacon
// and the /a/{token}/copy page.
export { handleBeacon } from './beacon';
export { copyPageState } from './copy';
export type { CopyPageState } from './copy';
export { ACTION_LINK_MESSAGES, neverSendsLine } from './messages';
export type { PageMessage } from './messages';
export { handleSendLink } from './send';
