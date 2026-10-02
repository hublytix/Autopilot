import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getDeps } from '@/server/container';
import { LOGIN_PATH } from '@/server/http/auth/guards';
import { requestFromHeaders } from '@/server/http/auth/request';
import { clientIp } from '@/server/http/hubspot-install';
import type { Deps } from '@/server/ports';
import { resolveOwner, type OwnerScope } from '@/server/services/auth/owner-scope';

// What a Server Action body starts from (PLAN §3 actions/): the Deps, a Request carrying the
// caller's cookies and client-IP headers (services read sessions from a Request), and the client
// IP for rate limits. Owner-only actions call requireOwnerAction(), which redirects to /login
// without a bound owner's verified session. Server Actions already get Next's Origin check.

export interface ActionContext {
  readonly deps: Deps;
  readonly request: Request;
  /** For rate limits only (HMAC-ed before it is stored). */
  readonly ip: string;
}

export async function actionContext(): Promise<ActionContext> {
  const deps = await getDeps();
  const request = requestFromHeaders(deps.env.APP_URL, await headers());
  return { deps, request, ip: clientIp(request) };
}

/** The action context plus the caller's OwnerScope, or a redirect to /login. */
export async function requireOwnerAction(): Promise<ActionContext & { readonly scope: OwnerScope }> {
  const context = await actionContext();
  const scope = await resolveOwner(context.deps, context.request);
  if (scope === null) redirect(LOGIN_PATH);
  return { ...context, scope };
}
