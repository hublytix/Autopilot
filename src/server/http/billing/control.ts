import 'server-only';
import { errorCode } from '@/server/domain/errors';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { isSameOriginRequest } from '@/server/security/same-origin';
import { resolveOwner } from '@/server/services/auth/owner-scope';
import { BILLING_PATH, runBillingControl, type BillingControl, type BillingResultCode } from '@/server/services/billing';
import { escapeHtml, htmlPage } from '../auth/html';
import { PRIVATE_HEADERS } from '../auth/request';

// POST /api/billing/checkout, /api/billing/resume and /api/billing/cancel (PLAN §7.3: owner +
// origin). Same-origin only (a cross-site form can't start a checkout or cancel a subscription);
// the owner's verified session (the proxy redirects first; checked again here); then the shared
// body (services/billing/controls.ts) and a 303 to where it says. A checkout lands on our own
// /dashboard/billing/checkout page, never on Razorpay directly: CSP form-action 'self' also covers
// the redirects that follow a form POST (D-56), so the page sends the owner on with a plain link.

const LOGIN_PATH = '/login';

const FAILED: Readonly<Record<BillingControl, BillingResultCode>> = {
  checkout: 'checkout.unavailable',
  cancel: 'cancel.unavailable',
  resume: 'resume.unavailable',
};

function seeOther(appUrl: string, path: string): Response {
  return new Response(null, { status: 303, headers: { Location: `${appUrl}${path}`, ...PRIVATE_HEADERS } });
}

function crossOrigin(productName: string): Response {
  const body = `
<h1>Please try again</h1>
<div class="card"><p>This request didn't come from your ${escapeHtml(productName)} billing page, so nothing happened.</p>
<a class="button" href="${BILLING_PATH}">Go to billing</a></div>`;
  return new Response(htmlPage({ productName, title: 'Please try again', body }), {
    status: 403,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...PRIVATE_HEADERS },
  });
}

export async function handleBillingControl(req: Request, deps: Deps, control: BillingControl): Promise<Response> {
  if (!isSameOriginRequest(req, deps.env.APP_URL)) {
    log.warn('billing action refused: cross-origin', { event: 'billing.cross_origin', outcome: control });
    return crossOrigin(deps.env.PRODUCT_NAME);
  }
  const scope = await resolveOwner(deps, req);
  if (scope === null) return seeOther(deps.env.APP_URL, LOGIN_PATH);
  try {
    return seeOther(deps.env.APP_URL, await runBillingControl(deps, scope, control));
  } catch (error) {
    log.error('billing action failed', { event: 'billing.control_error', accountId: scope.accountId, outcome: control, code: errorCode(error) }, error);
    return seeOther(deps.env.APP_URL, `${BILLING_PATH}?result=${FAILED[control]}`);
  }
}

/** GET (or any other method) on a billing action: there is nothing to show; back to the page. */
export function handleBillingControlOtherMethod(deps: Deps): Response {
  return seeOther(deps.env.APP_URL, BILLING_PATH);
}
