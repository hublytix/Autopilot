import 'server-only';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PermanentError } from '@/server/domain/errors';
import { isAuthOtpType, type AuthOtpType } from '@/server/domain/types';
import type { AuthProvider, AuthUser, RefreshedSession, SessionCookie, VerifiedSession } from '@/server/ports/auth';
import type { Clock } from '@/server/ports/clock';
import { hmacBase64Url, timingSafeEqualString } from '@/server/security/keys';
import { readRequestCookie, withSetCookies } from '@/server/security/cookies';

export const SESSION_COOKIE_NAME = 'ap_session';
/** A magic link is valid for 1 hour (D-22). */
export const LINK_VALIDITY_MS = 60 * 60 * 1000;
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** `refreshSession` re-signs a session with less than this left. */
export const DEFAULT_REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MIN_SIGNING_KEY_BYTES = 32;

// A signed cookie has exactly one valid spelling: `<payload>.<signature>`, both canonical unpadded
// base64url, the signature an HMAC-SHA256 (43 characters). Buffer.from(…, 'base64url') skips
// invalid characters and padding, so the parts are checked as text and compared as text.
const COOKIE_PAYLOAD = /^[A-Za-z0-9_-]+$/;
const COOKIE_SIGNATURE = /^[A-Za-z0-9_-]{43}$/;

export interface FakeAuthOptions {
  clock: Clock;
  /** HMAC-SHA256 key for the `ap_session` cookie (at least 32 bytes). */
  sessionSigningKey: string | Uint8Array;
  sessionTtlMs?: number | undefined;
  refreshWindowMs?: number | undefined;
  /** Default true. */
  secureCookies?: boolean | undefined;
}

/**
 * Which `verifyOtp` types a token accepts. A user who has never signed in gets a signup token
 * (`email` or `signup`); a returning user gets a magic-link token (`email` or `magiclink`). Supabase
 * looks the hash up in a different token column per type, so a wrong type fails without using the
 * token up. Only `type=email` works for both (D-22).
 */
type TokenKind = 'signup' | 'magiclink';

const userSchema = z.object({ userId: z.string(), email: z.string(), createdAtMs: z.number(), lastSignInAtMs: z.number().nullable() });
const tokenSchema = z.object({
  tokenHash: z.string(),
  userId: z.string(),
  email: z.string(),
  kind: z.enum(['signup', 'magiclink']),
  expiresAtMs: z.number(),
  used: z.boolean(),
});
const sessionSchema = z.object({ sessionId: z.string(), userId: z.string(), expiresAtMs: z.number() });
const snapshotSchema = z.object({
  version: z.literal(1),
  users: z.array(userSchema),
  tokens: z.array(tokenSchema),
  sessions: z.array(sessionSchema),
});
/** Plain JSON for fake-mode persistence. Holds token hashes and session ids: never log it. */
export type FakeAuthSnapshot = z.infer<typeof snapshotSchema>;

type UserState = z.infer<typeof userSchema>;
type TokenState = z.infer<typeof tokenSchema>;
type SessionState = z.infer<typeof sessionSchema>;

const cookiePayloadSchema = z.object({ sid: z.string(), uid: z.string(), exp: z.number() });
const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

type SessionRead = { state: 'none' } | { state: 'invalid' } | { state: 'valid'; session: SessionState; user: UserState };

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The fake `AuthProvider` (PLAN §4, D-21, D-22): one user per lower-cased email; `generateLink`
 * mints a single-use token hash valid for 1 hour of Clock time (a newer link replaces the user's
 * older one, as Supabase keeps one token per user); sessions are an HMAC-signed `ap_session` cookie
 * backed by a server-side session record, so `signOut` and `deleteUser` end them.
 */
export class FakeAuthProvider implements AuthProvider {
  readonly #clock: Clock;
  readonly #key: Buffer;
  readonly #ttlMs: number;
  readonly #refreshWindowMs: number;
  readonly #secure: boolean;
  readonly #users = new Map<string, UserState>();
  readonly #tokens = new Map<string, TokenState>();
  readonly #sessions = new Map<string, SessionState>();

  constructor(options: FakeAuthOptions) {
    const key = typeof options.sessionSigningKey === 'string' ? Buffer.from(options.sessionSigningKey, 'utf8') : Buffer.from(options.sessionSigningKey);
    if (key.length < MIN_SIGNING_KEY_BYTES) throw new RangeError('fake_auth_signing_key_too_short');
    this.#clock = options.clock;
    this.#key = key;
    this.#ttlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.#refreshWindowMs = options.refreshWindowMs ?? DEFAULT_REFRESH_WINDOW_MS;
    this.#secure = options.secureCookies ?? true;
  }

  // ── AuthProvider ──────────────────────────────────────────────────────────────────────────────

  async createUser(email: string): Promise<{ userId: string }> {
    const normalised = normaliseEmail(email);
    if (!EMAIL.test(normalised)) throw new PermanentError('auth_email_address_invalid', { httpStatus: 400 });
    if (this.#users.has(normalised)) throw new PermanentError('auth_user_exists', { httpStatus: 422 });
    return { userId: this.#addUser(normalised).userId };
  }

  async findUserByEmail(email: string): Promise<{ userId: string } | null> {
    const user = this.#users.get(normaliseEmail(email));
    return user === undefined ? null : { userId: user.userId };
  }

  async deleteUser(userId: string): Promise<void> {
    const user = this.#userById(userId);
    if (user === undefined) return;
    this.#users.delete(user.email);
    for (const [hash, token] of this.#tokens) if (token.userId === userId) this.#tokens.delete(hash);
    for (const [id, session] of this.#sessions) if (session.userId === userId) this.#sessions.delete(id);
  }

  async generateLink(email: string): Promise<{ hashedToken: string; userId: string }> {
    const normalised = normaliseEmail(email);
    if (!EMAIL.test(normalised)) throw new PermanentError('auth_email_address_invalid', { httpStatus: 400 });
    // Live Supabase silently signs up an unknown email here (D-22); the fake does the same.
    const user = this.#users.get(normalised) ?? this.#addUser(normalised);
    for (const [hash, token] of this.#tokens) if (token.userId === user.userId) this.#tokens.delete(hash);
    const hashedToken = createHash('sha224')
      .update(normalised + randomBytes(16).toString('hex'))
      .digest('hex');
    this.#tokens.set(hashedToken, {
      tokenHash: hashedToken,
      userId: user.userId,
      email: normalised,
      kind: user.lastSignInAtMs === null ? 'signup' : 'magiclink',
      expiresAtMs: this.#nowMs() + LINK_VALIDITY_MS,
      used: false,
    });
    return { hashedToken, userId: user.userId };
  }

  async verify(tokenHash: string, type: AuthOtpType): Promise<VerifiedSession | null> {
    if (!isAuthOtpType(type)) return null;
    const token = this.#tokens.get(tokenHash);
    const nowMs = this.#nowMs();
    if (token === undefined || token.used) return null;
    if (nowMs >= token.expiresAtMs) {
      this.#tokens.delete(tokenHash);
      return null;
    }
    if (!this.#accepts(token.kind, type)) return null;
    const user = this.#userById(token.userId);
    if (user === undefined) return null;
    token.used = true;
    user.lastSignInAtMs = nowMs;
    const session: SessionState = { sessionId: randomUUID(), userId: user.userId, expiresAtMs: nowMs + this.#ttlMs };
    this.#sessions.set(session.sessionId, session);
    return { userId: user.userId, email: user.email, cookies: [this.#sessionCookie(session)] };
  }

  async getVerifiedUser(request: Request): Promise<AuthUser | null> {
    const read = this.#readSession(request);
    return read.state === 'valid' ? { userId: read.user.userId, email: read.user.email } : null;
  }

  async refreshSession(request: Request, response: Response): Promise<RefreshedSession> {
    const read = this.#readSession(request);
    if (read.state === 'none') return { response, user: null };
    if (read.state === 'invalid') return { response: withSetCookies(response, [this.#clearCookie()]), user: null };
    const user = { userId: read.user.userId, email: read.user.email };
    const nowMs = this.#nowMs();
    if (read.session.expiresAtMs - nowMs >= this.#refreshWindowMs) return { response, user };
    read.session.expiresAtMs = nowMs + this.#ttlMs;
    return { response: withSetCookies(response, [this.#sessionCookie(read.session)]), user };
  }

  async signOut(request: Request): Promise<SessionCookie[]> {
    const read = this.#readSession(request);
    if (read.state === 'valid') this.#sessions.delete(read.session.sessionId);
    return [this.#clearCookie()];
  }

  // ── Test and dev helpers ──────────────────────────────────────────────────────────────────────

  /** Signs a user in without a link (route tests); throws for an unknown user. */
  issueSession(userId: string): SessionCookie {
    const user = this.#userById(userId);
    if (user === undefined) throw new Error('fake_auth_unknown_user');
    const nowMs = this.#nowMs();
    user.lastSignInAtMs ??= nowMs;
    const session: SessionState = { sessionId: randomUUID(), userId, expiresAtMs: nowMs + this.#ttlMs };
    this.#sessions.set(session.sessionId, session);
    return this.#sessionCookie(session);
  }

  /** Every user, oldest first. */
  users(): { userId: string; email: string; lastSignInAt: Date | null }[] {
    return [...this.#users.values()].map((u) => ({
      userId: u.userId,
      email: u.email,
      lastSignInAt: u.lastSignInAtMs === null ? null : new Date(u.lastSignInAtMs),
    }));
  }

  snapshot(): FakeAuthSnapshot {
    return {
      version: 1,
      users: [...this.#users.values()].map((u) => ({ ...u })),
      tokens: [...this.#tokens.values()].map((t) => ({ ...t })),
      sessions: [...this.#sessions.values()].map((s) => ({ ...s })),
    };
  }

  restore(snapshot: unknown): void {
    const parsed = snapshotSchema.parse(snapshot);
    this.#users.clear();
    this.#tokens.clear();
    this.#sessions.clear();
    for (const u of parsed.users) this.#users.set(u.email, u);
    for (const t of parsed.tokens) this.#tokens.set(t.tokenHash, t);
    for (const s of parsed.sessions) this.#sessions.set(s.sessionId, s);
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────────────

  #nowMs(): number {
    return this.#clock.now().getTime();
  }

  #addUser(email: string): UserState {
    const user: UserState = { userId: randomUUID(), email, createdAtMs: this.#nowMs(), lastSignInAtMs: null };
    this.#users.set(email, user);
    return user;
  }

  #userById(userId: string): UserState | undefined {
    for (const user of this.#users.values()) if (user.userId === userId) return user;
    return undefined;
  }

  #accepts(kind: TokenKind, type: AuthOtpType): boolean {
    return type === 'email' || type === kind;
  }

  #sign(payload: string): string {
    return hmacBase64Url(this.#key, payload);
  }

  #sessionCookie(session: SessionState): SessionCookie {
    const payload = Buffer.from(JSON.stringify({ sid: session.sessionId, uid: session.userId, exp: session.expiresAtMs })).toString('base64url');
    const maxAge = Math.max(0, Math.floor((session.expiresAtMs - this.#nowMs()) / 1000));
    return {
      name: SESSION_COOKIE_NAME,
      value: `${payload}.${this.#sign(payload)}`,
      options: { path: '/', httpOnly: true, secure: this.#secure, sameSite: 'lax', maxAge, expires: new Date(session.expiresAtMs) },
    };
  }

  #clearCookie(): SessionCookie {
    return {
      name: SESSION_COOKIE_NAME,
      value: '',
      options: { path: '/', httpOnly: true, secure: this.#secure, sameSite: 'lax', maxAge: 0, expires: new Date(0) },
    };
  }

  #readSession(request: Request): SessionRead {
    const raw = readRequestCookie(request, SESSION_COOKIE_NAME);
    if (raw === undefined || raw.length === 0) return { state: 'none' };
    const dot = raw.indexOf('.');
    if (dot <= 0) return { state: 'invalid' };
    const payload = raw.slice(0, dot);
    const signature = raw.slice(dot + 1);
    if (!COOKIE_PAYLOAD.test(payload) || !COOKIE_SIGNATURE.test(signature)) return { state: 'invalid' };
    if (!timingSafeEqualString(signature, this.#sign(payload))) return { state: 'invalid' };
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return { state: 'invalid' };
    }
    const claims = cookiePayloadSchema.safeParse(decoded);
    if (!claims.success) return { state: 'invalid' };
    const nowMs = this.#nowMs();
    const session = this.#sessions.get(claims.data.sid);
    if (session === undefined || session.userId !== claims.data.uid || nowMs >= session.expiresAtMs || nowMs >= claims.data.exp) {
      return { state: 'invalid' };
    }
    const user = this.#userById(session.userId);
    if (user === undefined) return { state: 'invalid' };
    return { state: 'valid', session, user };
  }
}
