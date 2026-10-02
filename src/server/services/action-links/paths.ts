import 'server-only';

// Same-origin paths of the action-link pages. A token is `apt_` + base64url, safe in a path segment.

export type ActionLinkAction = 'send' | 'copy' | 'edit' | 'dismiss' | 'beacon' | 'verify-notify';

/** `/a/{token}/{action}`. */
export function actionLinkPath(token: string, action: ActionLinkAction): string {
  return `/a/${encodeURIComponent(token)}/${action}`;
}
