import 'server-only';
import { z } from 'zod';
import { log } from '@/server/obs/log';
import { devNotFound, devPlainResponse, getDevContext, type DevContext } from './guard';
import { isSameOriginRequest } from './same-origin';

// The fake HubSpot consent page (PLAN §4, §7.6, D-29): `/dev/fake-hubspot/authorize` is where the
// fake's `authorizeUrl` sends the installer. The page shows the requested scopes with Approve and
// Cancel; the form POSTs to the decision route, which (same-origin only) mints a single-use code
// with `createAuthCode` and redirects to the redirect URI with `code` and `state`, as HubSpot does.
// Like HubSpot, it refuses an unknown client id or a redirect URI other than the registered one
// (here: HUBSPOT_REDIRECT_URI), so the page is never an open redirect. The code is never logged.

export const FAKE_HUBSPOT_AUTHORIZE_PATH = '/dev/fake-hubspot/authorize';
export const FAKE_HUBSPOT_DECISION_PATH = '/dev/fake-hubspot/authorize/decision';

/** One authorize request, as the consent page shows it and its form posts it back. */
export interface AuthorizeRequest {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly scopes: readonly string[];
  readonly optionalScopes: readonly string[];
}

export type AuthorizeRejection = 'client_id' | 'redirect_uri' | 'state' | 'scope';

type Parsed = { ok: true; request: AuthorizeRequest } | { ok: false; reason: AuthorizeRejection };

const STATE = /^[\x21-\x7e]{1,512}$/;
const SCOPE = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const MAX_SCOPES = 50;

/** A space-separated scope list; null when malformed. An absent list is empty. */
function scopeList(raw: string | null): string[] | null {
  if (raw === null) return [];
  const scopes = raw.split(/\s+/).filter((s) => s.length > 0);
  if (scopes.length > MAX_SCOPES || !scopes.every((s) => SCOPE.test(s))) return null;
  return [...new Set(scopes)];
}

/** Checks one authorize request against the configured fake app; `get` reads one parameter (null when absent or repeated). */
function parseAuthorize(get: (name: string) => string | null, env: DevContext['env'], requireScopes: boolean): Parsed {
  const clientId = get('client_id');
  if (clientId !== env.HUBSPOT_CLIENT_ID) return { ok: false, reason: 'client_id' };
  const redirectUri = get('redirect_uri');
  if (redirectUri !== env.HUBSPOT_REDIRECT_URI) return { ok: false, reason: 'redirect_uri' };
  const state = get('state');
  if (state === null || !STATE.test(state)) return { ok: false, reason: 'state' };
  const scopes = scopeList(get('scope'));
  const optionalScopes = scopeList(get('optional_scope'));
  if (scopes === null || optionalScopes === null || (requireScopes && scopes.length === 0)) return { ok: false, reason: 'scope' };
  return { ok: true, request: { clientId, redirectUri, state, scopes, optionalScopes } };
}

export type SearchParamsRecord = Readonly<Record<string, string | string[] | undefined>>;

function fromRecord(params: SearchParamsRecord): (name: string) => string | null {
  return (name) => {
    const value = params[name];
    return typeof value === 'string' ? value : null;
  };
}

export interface ConsentPortal {
  readonly portalId: string;
  readonly hubDomain: string | null;
  readonly accountType: string;
}

export type ConsentView =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'invalid'; readonly reason: AuthorizeRejection }
  | { readonly kind: 'consent'; readonly request: AuthorizeRequest; readonly portal: ConsentPortal; readonly decisionPath: string };

/** The consent page's view model; `ctx` null (not fake mode) → not found. */
export function buildConsentView(params: SearchParamsRecord, ctx: DevContext | null): ConsentView {
  if (ctx === null) return { kind: 'not_found' };
  const parsed = parseAuthorize(fromRecord(params), ctx.env, true);
  if (!parsed.ok) return { kind: 'invalid', reason: parsed.reason };
  const portal = ctx.fakes.hubspot.portal;
  return {
    kind: 'consent',
    request: parsed.request,
    portal: { portalId: portal.portalId, hubDomain: portal.hubDomain, accountType: portal.accountType },
    decisionPath: FAKE_HUBSPOT_DECISION_PATH,
  };
}

/** For the page: the view in the current process (fake mode only). */
export async function fakeHubSpotConsentView(params: SearchParamsRecord): Promise<ConsentView> {
  return buildConsentView(params, await getDevContext());
}

const MAX_FORM_BYTES = 16 * 1024;
const decisionSchema = z.enum(['approve', 'deny']);

function redirectTo(location: string): Response {
  return new Response(null, {
    status: 303,
    // The code travels in the URL: no caching, no referrer.
    headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}

/** `redirectUri` with `params` appended to its query, as HubSpot does. */
function withQuery(redirectUri: string, params: Readonly<Record<string, string>>): string {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.toString();
}

async function readForm(req: Request): Promise<URLSearchParams | null> {
  const type = req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') return null;
  const length = Number(req.headers.get('content-length') ?? '0');
  if (!Number.isFinite(length) || length > MAX_FORM_BYTES) return null;
  const body = await req.text();
  if (body.length > MAX_FORM_BYTES) return null;
  return new URLSearchParams(body);
}

/**
 * POST /dev/fake-hubspot/authorize/decision (fake mode only, same-origin): Approve → a fresh code,
 * 303 to `redirect_uri?code=…&state=…`; Cancel → 303 to `redirect_uri?error=access_denied&state=…`.
 */
export async function handleFakeHubSpotDecision(req: Request, ctx: DevContext | null): Promise<Response> {
  if (ctx === null) return devNotFound();
  if (req.method !== 'POST') return devPlainResponse(405, 'Method not allowed', { Allow: 'POST' });
  if (!isSameOriginRequest(req, ctx.env.APP_URL)) return devPlainResponse(403, 'Forbidden');

  const form = await readForm(req);
  if (form === null) return devPlainResponse(400, 'Invalid authorization request');
  const get = (name: string): string | null => (form.getAll(name).length === 1 ? form.get(name) : null);
  const parsed = parseAuthorize(get, ctx.env, false);
  const decision = decisionSchema.safeParse(get('decision'));
  if (!parsed.ok || !decision.success) {
    log.info('fake hubspot consent refused', { event: 'dev.fake_hubspot_consent_invalid', reason: parsed.ok ? 'decision' : parsed.reason });
    return devPlainResponse(400, 'Invalid authorization request');
  }

  const { redirectUri, state } = parsed.request;
  if (decision.data === 'deny') return redirectTo(withQuery(redirectUri, { error: 'access_denied', state }));
  const code = ctx.fakes.hubspot.createAuthCode({ redirectUri });
  log.info('fake hubspot consent approved', { event: 'dev.fake_hubspot_consent_approved' });
  return redirectTo(withQuery(redirectUri, { code, state }));
}

/** Any other method on the decision route: 404 outside fake mode, else 405. */
export function handleFakeHubSpotDecisionOtherMethod(ctx: DevContext | null): Response {
  if (ctx === null) return devNotFound();
  return devPlainResponse(405, 'Method not allowed', { Allow: 'POST' });
}
