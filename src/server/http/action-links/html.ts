import 'server-only';
import { escapeHtml, htmlPage } from '@/server/http/auth/html';
import { PRIVATE_HEADERS } from '@/server/http/auth/request';
import { generateNonce } from '@/server/security/csp';
import type { InterstitialView } from '@/server/services/action-links';
import { ACTION_LINK_MESSAGES, neverSendsLine, type PageMessage } from './messages';

// The pages GET /a/{token}/send renders itself (a route handler, because it must also answer 302):
// the mailto interstitial (D-13) and the expired / not-available / too-many-attempts states. They
// are self-contained (no framework script), mobile-first, with 44 px tap targets and visible focus
// (the shared htmlPage shell), never cached or indexed, and send no Referer to other sites (D-49, D-62).
//
// The interstitial's only script is constant: it reads the beacon URL and nonce from data attributes
// (HTML-escaped, so lead-controlled text can never reach script context) and opens the mailto: link.
// It posts the beacon only on a person's gesture on the page (a trusted click, e.g. "Open mail app",
// or a copy), never on load and never under automation (navigator.webdriver): link-detonation
// sandboxes run pages in real browsers, so a load-time beacon would count their visits as clicks
// (D-26, law 3). Its CSP nonce is the proxy's (x-nonce); without a proxy the page sends a policy of
// its own.

const NONCE_SHAPE = /^[A-Za-z0-9+/=_-]{16,128}$/;

// Runs in the browser: arms the gesture beacon (once; keepalive, so it survives the hand-off to the
// mail app), then opens the mail app. referrerPolicy 'same-origin' (also the page's own policy, D-62)
// makes the browser send a real Origin header, as the beacon's same-origin check needs.
export const INTERSTITIAL_SCRIPT = `(function(){
var root=document.getElementById('ap-send');var open=document.getElementById('ap-open');
var url=root&&root.getAttribute('data-beacon');var nonce=root&&root.getAttribute('data-nonce');
var sent=false;
function beacon(e){if(sent||!e||e.isTrusted!==true||!url||!nonce||!window.fetch||navigator.webdriver)return;sent=true;
try{fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({n:nonce}),keepalive:true,credentials:'omit',cache:'no-store',referrerPolicy:'same-origin'}).catch(function(){});}catch(x){}}
document.addEventListener('click',beacon,true);document.addEventListener('copy',beacon,true);
var href=open&&open.getAttribute('href');
if(href&&href.indexOf('mailto:')===0){window.location.href=href;}
})();`;

export function htmlResponse(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...PRIVATE_HEADERS, ...extra } });
}

/** One of the shared states as a page (no script). */
export function messagePage(productName: string, message: PageMessage): string {
  const paragraphs = message.paragraphs.map((text) => `<p>${escapeHtml(text)}</p>`).join('');
  return htmlPage({ productName, title: message.title, body: `<h1>${escapeHtml(message.title)}</h1>${paragraphs}` });
}

export function invalidLinkResponse(productName: string): Response {
  return htmlResponse(404, messagePage(productName, ACTION_LINK_MESSAGES.invalid));
}

export function expiredDraftResponse(productName: string): Response {
  return htmlResponse(410, messagePage(productName, ACTION_LINK_MESSAGES.expired));
}

export function rateLimitedResponse(productName: string, retryAfterSeconds: number): Response {
  return htmlResponse(429, messagePage(productName, ACTION_LINK_MESSAGES.rateLimited), { 'Retry-After': String(retryAfterSeconds) });
}

export function unavailableResponse(productName: string): Response {
  return htmlResponse(503, messagePage(productName, ACTION_LINK_MESSAGES.unavailable), { 'Retry-After': '60' });
}

export interface InterstitialInput {
  readonly productName: string;
  readonly view: InterstitialView;
  /** `/a/{token}/beacon`. */
  readonly beaconPath: string;
  /** `/a/{token}/copy`. */
  readonly copyPath: string;
  /** The request's x-nonce (set by the proxy), if any. */
  readonly proxyNonce: string | null;
}

const BREAK = 'style="overflow-wrap:anywhere"';

/** 200: opens the mailto: URL on load, with a button and "Copy your reply" as fallbacks (D-13). */
export function interstitialResponse(input: InterstitialInput): Response {
  const { view, productName } = input;
  const nonce = input.proxyNonce !== null && NONCE_SHAPE.test(input.proxyNonce) ? input.proxyNonce : generateNonce();
  const beaconAttributes =
    view.beaconNonce === null ? '' : ` data-beacon="${escapeHtml(input.beaconPath)}" data-nonce="${escapeHtml(view.beaconNonce)}"`;
  const bcc =
    view.bcc === null
      ? ''
      : `<p ${BREAK}><strong>BCC:</strong> ${escapeHtml(view.bcc)}</p>
<p class="small">This address lets HubSpot log your email. Some mail apps leave the BCC out: if it is missing, add it by hand.</p>`;
  const body = `
<h1>Opening your mail app</h1>
<div class="card" id="ap-send"${beaconAttributes}>
<p role="status">Your reply is ready in a new email. If your mail app didn't open, tap the button.</p>
<a class="button" id="ap-open" href="${escapeHtml(view.mailtoUrl)}">Open mail app</a>
<p ${BREAK}><strong>To:</strong> ${escapeHtml(view.recipient)}</p>
<p ${BREAK}><strong>Subject:</strong> ${escapeHtml(view.subject)}</p>
${bcc}
</div>
<p><a href="${escapeHtml(input.copyPath)}">Copy your reply</a> to paste it into any mail app instead.</p>
<p class="small">${escapeHtml(neverSendsLine(productName))}</p>`;
  const extra: Record<string, string> = {};
  if (input.proxyNonce === null) {
    extra['Content-Security-Policy'] =
      `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
  }
  return htmlResponse(200, htmlPage({ productName, title: 'Opening your mail app', body, script: { nonce, source: INTERSTITIAL_SCRIPT } }), extra);
}

