import 'server-only';
import { combineChunks, createServerClient, stringFromBase64URL, type CookieOptions } from '@supabase/ssr';
import { createClient, isAuthApiError, isAuthError, isAuthRetryableFetchError, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { ConfigError, PermanentError, TransientError } from '@/server/domain/errors';
import type { AuthOtpType } from '@/server/domain/types';
import type { AuthProvider, AuthUser, RefreshedSession, SessionCookie, SessionCookieOptions, VerifiedSession } from '@/server/ports/auth';
import type { Clock } from '@/server/ports/clock';
import { parseCookieHeader, withSetCookies } from '@/server/security/cookies';

// The live AuthProvider (PLAN §4, D-21, D-22, SB-ADMIN-CLIENT, SB-SSR-MIDDLEWARE-NEXT14):
// - admin calls (createUser, deleteUser, generateLink, the user lookup) use a supabase-js client
//   built with the secret key and no session (persistSession false); this module is server-only;
// - generateLink({type: 'magiclink'}) only mints the token: our Mailer sends the email (D-22);
// - verify, refreshSession and signOut use an @supabase/ssr server client created per request,
//   whose cookie adapter reads the request's cookies and collects what it writes, so the session
//   cookies land on our response (httpOnly, SameSite=Lax, Secure on https);
// - getVerifiedUser reads the session cookie and verifies its access token (getClaims(jwt)) without
//   ever refreshing it: a refresh outside the proxy would rotate the refresh token and lose it.
// Errors carry codes only: Supabase messages and payloads (emails, tokens) never leave here.

export interface SupabaseAuthOptions {
  /** SUPABASE_URL, e.g. https://<project ref>.supabase.co. */
  readonly url: string;
  readonly publishableKey: string;
  /** Admin calls only (SUPABASE_SECRET_KEY); never sent to a browser. */
  readonly secretKey: string;
  readonly clock: Clock;
  /** Default true; false only for a plain-http loopback APP_URL. */
  readonly secureCookies?: boolean | undefined;
  /** Tests stub the network here. */
  readonly fetch?: typeof fetch | undefined;
}

/** How many pages of 1000 users findUserByEmail reads before giving up. */
const USER_LOOKUP_MAX_PAGES = 20;
const USER_LOOKUP_PAGE_SIZE = 1000;

const userSchema = z.object({ id: z.string().min(1), email: z.string().optional().nullable() });
const generatedLinkSchema = z.object({
  properties: z.object({ hashed_token: z.string().min(16) }),
  user: z.object({ id: z.string().min(1) }),
});
const storedSessionSchema = z.object({ access_token: z.string().min(1), expires_at: z.number().optional() });
const claimsSchema = z.object({ sub: z.string().min(1), email: z.string().optional() });

type AuthStep = 'create_user' | 'delete_user' | 'generate_link' | 'find_user' | 'verify' | 'claims' | 'refresh' | 'sign_out';

/** Maps a supabase-js error to our hierarchy (codes only). */
function mapAuthError(error: unknown, step: AuthStep): Error {
  if (isAuthRetryableFetchError(error)) return new TransientError('auth_unavailable', { httpStatus: error.status || undefined });
  if (isAuthApiError(error)) {
    const status = error.status;
    if (status === 429) return new TransientError('auth_rate_limited', { httpStatus: 429 });
    if (status >= 500) return new TransientError('auth_unavailable', { httpStatus: status });
    if (step === 'create_user' && (error.code === 'email_exists' || error.code === 'user_already_exists')) {
      return new PermanentError('auth_user_exists', { httpStatus: status });
    }
    if (error.code === 'email_address_invalid' || error.code === 'validation_failed') {
      return new PermanentError('auth_email_address_invalid', { httpStatus: status });
    }
    // A key Supabase refuses (wrong project, a publishable key on an admin call): an operator problem.
    // A plain 403 is not one: verifyOtp answers 403 otp_expired for a used or expired token.
    if (status === 401 || error.code === 'not_admin' || error.code === 'no_authorization' || error.code === 'bad_jwt') {
      return new ConfigError('auth_config', { httpStatus: status });
    }
    return new PermanentError('auth_request_refused', { httpStatus: status });
  }
  // A missing session, an invalid or expired JWT, a bad stored session: no user.
  if (isAuthError(error)) return new PermanentError('auth_session_invalid');
  return new TransientError('auth_unexpected');
}

function toSameSite(value: CookieOptions['sameSite']): SessionCookieOptions['sameSite'] {
  if (value === true || value === 'strict') return 'strict';
  if (value === 'lax' || value === 'none') return value;
  return undefined;
}

function toSessionCookie(name: string, value: string, options: CookieOptions): SessionCookie {
  return {
    name,
    value,
    options: {
      path: options.path,
      domain: options.domain,
      maxAge: options.maxAge,
      expires: options.expires,
      httpOnly: options.httpOnly,
      secure: options.secure,
      sameSite: toSameSite(options.sameSite),
    },
  };
}

interface RequestClient {
  readonly client: SupabaseClient;
  /** Cookies the client asked to set, in order. */
  readonly written: SessionCookie[];
  /** Response headers the client asked for with them (no-cache for auth cookies). */
  readonly headers: Record<string, string>;
}

export class SupabaseAuthProvider implements AuthProvider {
  readonly #options: SupabaseAuthOptions;
  readonly #storageKey: string;
  #admin: SupabaseClient | undefined;
  #verifier: SupabaseClient | undefined;

  constructor(options: SupabaseAuthOptions) {
    const url = new URL(options.url);
    this.#options = options;
    // supabase-js's default storage key: the cookie is `sb-<project ref>-auth-token` (chunked `.0`, `.1`, …).
    this.#storageKey = `sb-${url.hostname.split('.')[0] ?? ''}-auth-token`;
  }

  /** The session cookie's name (and chunk prefix). */
  get sessionCookieName(): string {
    return this.#storageKey;
  }

  // ── Admin ─────────────────────────────────────────────────────────────────────────────────────

  #adminClient(): SupabaseClient {
    this.#admin ??= createClient(this.#options.url, this.#options.secretKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch },
    });
    return this.#admin;
  }

  async createUser(email: string): Promise<{ userId: string }> {
    const { data, error } = await this.#adminClient().auth.admin.createUser({ email: email.trim().toLowerCase(), email_confirm: false });
    if (error !== null) throw mapAuthError(error, 'create_user');
    const user = userSchema.safeParse(data.user);
    if (!user.success) throw new TransientError('auth_invalid_response');
    return { userId: user.data.id };
  }

  async findUserByEmail(email: string): Promise<{ userId: string } | null> {
    const wanted = email.trim().toLowerCase();
    for (let page = 1; page <= USER_LOOKUP_MAX_PAGES; page += 1) {
      const { data, error } = await this.#adminClient().auth.admin.listUsers({ page, perPage: USER_LOOKUP_PAGE_SIZE });
      if (error !== null) throw mapAuthError(error, 'find_user');
      const users = z.array(userSchema).safeParse(data.users);
      if (!users.success) throw new TransientError('auth_invalid_response');
      const match = users.data.find((user) => user.email?.toLowerCase() === wanted);
      if (match !== undefined) return { userId: match.id };
      if (users.data.length < USER_LOOKUP_PAGE_SIZE) return null;
    }
    throw new PermanentError('auth_user_lookup_too_large');
  }

  async deleteUser(userId: string): Promise<void> {
    const { error } = await this.#adminClient().auth.admin.deleteUser(userId);
    if (error === null) return;
    if (isAuthApiError(error) && (error.status === 404 || error.code === 'user_not_found')) return;
    throw mapAuthError(error, 'delete_user');
  }

  async generateLink(email: string): Promise<{ hashedToken: string; userId: string }> {
    const { data, error } = await this.#adminClient().auth.admin.generateLink({ type: 'magiclink', email: email.trim().toLowerCase() });
    if (error !== null) throw mapAuthError(error, 'generate_link');
    const parsed = generatedLinkSchema.safeParse(data);
    if (!parsed.success) throw new TransientError('auth_invalid_response');
    return { hashedToken: parsed.data.properties.hashed_token, userId: parsed.data.user.id };
  }

  // ── Sessions ──────────────────────────────────────────────────────────────────────────────────

  /** An @supabase/ssr server client for one request: reads `request`'s cookies, collects writes. */
  #requestClient(request: Request): RequestClient {
    const cookies = parseCookieHeader(request.headers.get('cookie'));
    const written: SessionCookie[] = [];
    const headers: Record<string, string> = {};
    const client = createServerClient(this.#options.url, this.#options.publishableKey, {
      cookies: {
        getAll: () => [...cookies].map(([name, value]) => ({ name, value })),
        setAll: (toSet, extra) => {
          for (const cookie of toSet) written.push(toSessionCookie(cookie.name, cookie.value, cookie.options));
          Object.assign(headers, extra);
        },
      },
      cookieOptions: { path: '/', sameSite: 'lax', httpOnly: true, secure: this.#options.secureCookies ?? true },
      global: this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch },
    });
    return { client, written, headers };
  }

  /** A session-less client for verifying an access token. */
  #verifierClient(): SupabaseClient {
    this.#verifier ??= createClient(this.#options.url, this.#options.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch },
    });
    return this.#verifier;
  }

  async verify(tokenHash: string, type: AuthOtpType): Promise<VerifiedSession | null> {
    const { client, written } = this.#requestClient(new Request('http://localhost/'));
    const { data, error } = await client.auth.verifyOtp({ token_hash: tokenHash, type });
    if (error !== null) {
      const mapped = mapAuthError(error, 'verify');
      // An unknown, used or expired token (403 otp_expired and friends) is not an error: no session.
      if (mapped instanceof PermanentError) return null;
      throw mapped;
    }
    const user = userSchema.safeParse(data.user);
    if (!user.success || typeof user.data.email !== 'string' || data.session === null) return null;
    return { userId: user.data.id, email: user.data.email.toLowerCase(), cookies: written };
  }

  /** The stored session's access token, read from the (possibly chunked) cookie without refreshing. */
  async #storedAccessToken(request: Request): Promise<string | null> {
    const cookies = parseCookieHeader(request.headers.get('cookie'));
    const combined = await combineChunks(this.#storageKey, (name) => cookies.get(name));
    if (combined === null || combined.length === 0) return null;
    let json = combined;
    if (combined.startsWith('base64-')) {
      try {
        json = stringFromBase64URL(combined.slice('base64-'.length));
      } catch {
        return null;
      }
    }
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      return null;
    }
    const session = storedSessionSchema.safeParse(raw);
    if (!session.success) return null;
    // Expired: only the proxy may refresh it; until then there is no verified user.
    if (session.data.expires_at !== undefined && session.data.expires_at * 1000 <= this.#options.clock.now().getTime()) return null;
    return session.data.access_token;
  }

  async getVerifiedUser(request: Request): Promise<AuthUser | null> {
    const token = await this.#storedAccessToken(request);
    if (token === null) return null;
    const { data, error } = await this.#verifierClient().auth.getClaims(token);
    if (error !== null) {
      const mapped = mapAuthError(error, 'claims');
      if (mapped instanceof TransientError) throw mapped;
      return null;
    }
    const claims = claimsSchema.safeParse(data?.claims);
    if (!claims.success || claims.data.email === undefined || claims.data.email.length === 0) return null;
    return { userId: claims.data.sub, email: claims.data.email.toLowerCase() };
  }

  async refreshSession(request: Request, response: Response): Promise<RefreshedSession> {
    const { client, written, headers } = this.#requestClient(request);
    // The @supabase/ssr pattern: nothing between creating the client and getClaims(). A refresh it
    // does (or a session it drops) is written through setAll, and those cookies always reach the
    // response, even when the claims check itself fails: a rotated refresh token must not be lost.
    const { data, error } = await client.auth.getClaims();
    let user: AuthUser | null = null;
    if (error === null) {
      const claims = claimsSchema.safeParse(data?.claims);
      if (claims.success && claims.data.email !== undefined && claims.data.email.length > 0) {
        user = { userId: claims.data.sub, email: claims.data.email.toLowerCase() };
      }
    }
    let out = withSetCookies(response, written);
    if (written.length > 0) out = withHeaders(out, headers);
    return { response: out, user };
  }

  async signOut(request: Request): Promise<SessionCookie[]> {
    const { client, written } = this.#requestClient(request);
    try {
      await client.auth.signOut({ scope: 'local' });
    } catch {
      // The cookies below are cleared whatever Supabase said.
    }
    const cleared = new Set(written.filter((c) => c.value === '').map((c) => c.name));
    const secure = this.#options.secureCookies ?? true;
    for (const name of parseCookieHeader(request.headers.get('cookie')).keys()) {
      if ((name === this.#storageKey || name.startsWith(`${this.#storageKey}.`)) && !cleared.has(name)) {
        written.push({ name, value: '', options: { path: '/', maxAge: 0, httpOnly: true, secure, sameSite: 'lax' } });
      }
    }
    return written.filter((c) => c.value === '' || c.options.maxAge === 0);
  }
}

/** Copies `response` with extra headers when its own are immutable (as after Response.redirect()). */
function withHeaders(response: Response, extra: Readonly<Record<string, string>>): Response {
  const entries = Object.entries(extra);
  if (entries.length === 0) return response;
  try {
    for (const [name, value] of entries) response.headers.set(name, value);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    for (const [name, value] of entries) headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}

/** The live AuthProvider from the environment's Supabase settings. */
export function createSupabaseAuthProvider(input: {
  supabaseUrl: string;
  publishableKey: string;
  secretKey: string;
  appUrl: string;
  clock: Clock;
}): SupabaseAuthProvider {
  const app = new URL(input.appUrl);
  const loopback = app.protocol === 'http:' && (app.hostname === 'localhost' || app.hostname === '127.0.0.1' || app.hostname === '[::1]');
  return new SupabaseAuthProvider({
    url: input.supabaseUrl,
    publishableKey: input.publishableKey,
    secretKey: input.secretKey,
    clock: input.clock,
    secureCookies: !loopback,
  });
}
