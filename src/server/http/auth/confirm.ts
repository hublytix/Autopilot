import 'server-only';
import { errorCode } from '@/server/domain/errors';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { withSetCookies } from '@/server/security/cookies';
import { generateNonce, NONCE_HEADER } from '@/server/security/csp';
import { confirmMagicLink, type ConfirmOutcome } from '@/server/services/auth/confirm';
import { isSameOriginRequest } from '@/server/security/same-origin';
import { clientIp } from '../hubspot-install';
import { escapeHtml, htmlPage } from './html';
import { PRIVATE_HEADERS } from './request';

// /auth/confirm (PLAN §7.2, D-22, SB-EMAIL-PREFETCH).
// GET never touches the token: it renders a "Sign in" button and a nonce'd script that copies `th`
// and `type` from the URL fragment (which never reaches a server) into a same-origin POST form and
// clears the fragment. A link scanner that fetches the page, or even runs it, signs nobody in:
// only a tap on the button posts. Without JavaScript the page explains what to do.
// POST (same-origin, rate-limited) verifies, consumes the login intent, binds an onboarding owner
// and lands on the intent's allow-listed `next` with the session cookies; anything else lands on
// /auth/error with a reason code. Responses are never cached and send no Referer to other sites.

export const AUTH_ERROR_PATH = '/auth/error';
/** Form bodies are two short fields; anything bigger is refused unread. */
const MAX_BODY_BYTES = 4096;

export type AuthErrorReason = 'link' | 'already_owner' | 'setup' | 'unavailable';

function errorLocation(appUrl: string, reason: AuthErrorReason): string {
  return `${appUrl}${AUTH_ERROR_PATH}?reason=${reason}`;
}

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, ...PRIVATE_HEADERS } });
}

function html(status: number, body: string, extra: Readonly<Record<string, string>> = {}): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...PRIVATE_HEADERS, ...extra } });
}

// Runs in the browser. Reads the fragment, removes it from the address bar and history, and fills
// the form; the user still has to tap the button.
const CONFIRM_SCRIPT = `(function(){
var params=new URLSearchParams(location.hash.slice(1));
var th=params.get('th');var type=params.get('type');
if(location.hash&&history.replaceState){history.replaceState(null,'',location.pathname+location.search);}
var status=document.getElementById('status');
if(th&&type){document.getElementById('th').value=th;document.getElementById('type').value=type;var b=document.getElementById('submit');b.disabled=false;b.focus();}
else{status.textContent='This link is incomplete. Open the newest sign-in email and tap its button again, or ask for a new link.';}
})();`;

/** GET /auth/confirm. Uses the proxy's nonce (request header), or its own when there is no proxy. */
export function handleConfirmGet(req: Request, deps: Deps): Response {
  const proxyNonce = req.headers.get(NONCE_HEADER);
  const nonce = proxyNonce !== null && /^[A-Za-z0-9+/=_-]{16,128}$/.test(proxyNonce) ? proxyNonce : generateNonce();
  const productName = deps.env.PRODUCT_NAME;
  const body = `
<h1>Sign in to ${escapeHtml(productName)}</h1>
<div class="card">
<p id="status" role="status">Tap the button to finish signing in.</p>
<form id="confirm" method="post" action="/auth/confirm">
<input type="hidden" name="th" id="th" value="">
<input type="hidden" name="type" id="type" value="">
<button type="submit" id="submit" disabled>Sign in</button>
</form>
<noscript><p>Signing in needs JavaScript. Turn it on for this site, then open the link in the email again. You can also <a href="/login">ask for a new link</a>.</p></noscript>
</div>
<p class="small">Didn't ask to sign in? Close this page: nothing happens unless you tap the button.</p>
<p class="small"><a href="/login">Ask for a new link</a></p>`;
  const extra: Record<string, string> = {};
  // Without the proxy (it normally sets the policy for every page), the page brings its own.
  if (proxyNonce === null) {
    extra['Content-Security-Policy'] =
      `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
  }
  return html(200, htmlPage({ productName, title: 'Sign in', body, script: { nonce, source: CONFIRM_SCRIPT } }), extra);
}

/** The page for a POST that did not come from our own page (403). */
export function crossOriginPage(productName: string): Response {
  const body = `
<h1>Please try again</h1>
<div class="card"><p>This request didn't come from the ${escapeHtml(productName)} sign-in page, so nothing happened. Open the link in the email again.</p></div>`;
  return html(403, htmlPage({ productName, title: 'Please try again', body }));
}

function rateLimitedPage(productName: string, retryAfterSeconds: number): Response {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  const body = `
<h1>Too many attempts</h1>
<div class="card"><p>Please wait about ${minutes} minute${minutes === 1 ? '' : 's'}, then open the link in the email again.</p></div>`;
  return html(429, htmlPage({ productName, title: 'Too many attempts', body }), { 'Retry-After': String(retryAfterSeconds) });
}

async function readForm(req: Request): Promise<FormData | null> {
  const length = Number(req.headers.get('content-length') ?? '0');
  if (!Number.isFinite(length) || length > MAX_BODY_BYTES) return null;
  const type = req.headers.get('content-type') ?? '';
  if (!type.startsWith('application/x-www-form-urlencoded') && !type.startsWith('multipart/form-data')) return null;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return null;
    return await new Request(req.url, { method: 'POST', headers: { 'content-type': type }, body: text }).formData();
  } catch {
    return null;
  }
}

function outcomeResponse(deps: Deps, outcome: ConfirmOutcome): Response {
  const appUrl = deps.env.APP_URL;
  switch (outcome.type) {
    case 'rate_limited':
      return rateLimitedPage(deps.env.PRODUCT_NAME, outcome.retryAfterSeconds);
    case 'invalid_link':
      return seeOther(errorLocation(appUrl, 'link'));
    case 'already_owner':
      return seeOther(errorLocation(appUrl, 'already_owner'));
    case 'setup_mismatch':
      return seeOther(errorLocation(appUrl, 'setup'));
    case 'signed_in':
      return withSetCookies(seeOther(`${appUrl}${outcome.location}`), outcome.cookies);
  }
}

/** POST /auth/confirm. */
export async function handleConfirmPost(req: Request, deps: Deps): Promise<Response> {
  if (!isSameOriginRequest(req, deps.env.APP_URL)) {
    log.warn('magic link confirm refused: cross-origin', { event: 'auth.confirm_cross_origin' });
    return crossOriginPage(deps.env.PRODUCT_NAME);
  }
  const form = await readForm(req);
  try {
    const outcome = await confirmMagicLink(deps, { tokenHash: form?.get('th') ?? null, type: form?.get('type') ?? null, ip: clientIp(req) });
    return outcomeResponse(deps, outcome);
  } catch (error) {
    log.error('magic link confirm failed', { event: 'auth.confirm_failed', code: errorCode(error) }, error);
    return seeOther(errorLocation(deps.env.APP_URL, 'unavailable'));
  }
}
