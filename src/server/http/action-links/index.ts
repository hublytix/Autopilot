import 'server-only';

// Owner action-link route handlers and page state (PLAN §7.4): /a/{token}/send, /a/{token}/beacon
// and the /a/{token}/copy, /a/{token}/edit and /a/{token}/dismiss pages.
export { handleBeacon } from './beacon';
export { copyPageState } from './copy';
export type { CopyPageState } from './copy';
export { ACTION_LINK_MESSAGES, neverSendsLine } from './messages';
export type { PageMessage } from './messages';
export { handleSendLink } from './send';
export { EDIT_CROSS_ORIGIN_MESSAGE, EDIT_HINTS, EDIT_IDLE, EDIT_INPUT_ERRORS, editPageState, formFromSameOrigin, submitEditForm } from './edit';
export type { EditFieldErrors, EditFormRequest, EditFormState, EditHint, EditLimits, EditPageState, EditReadyView } from './edit';
export { DISMISS_RESULT_ALERTS, dismissPageState, dismissResultAlert, dismissResultPath, submitDismissForm } from './dismiss';
export type { DismissPageState, DismissSubmitResult } from './dismiss';
