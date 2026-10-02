import 'server-only';
import type { AuthOtpType } from '@/server/domain/types';

// Live: Supabase Auth (admin client with the secret key; `@supabase/ssr` for session cookies).
// Fake: links written to the outbox and a signed `ap_session` cookie; `verify` rejects a wrong `type`
// for a new user, as Supabase does. Public sign-ups are off: only `createUser` makes users (D-21, D-22).
// Emails returned by this port are lower-cased.
//
// Errors: TransientError (429, 5xx, network), PermanentError (other 4xx, e.g. `auth_user_exists`),
// ConfigError (bad key). An invalid or expired link is not an error: `verify` returns null.

export interface AuthUser {
  userId: string;
  email: string;
}

export interface SessionCookieOptions {
  path?: string | undefined;
  domain?: string | undefined;
  maxAge?: number | undefined;
  expires?: Date | undefined;
  httpOnly?: boolean | undefined;
  secure?: boolean | undefined;
  sameSite?: 'lax' | 'strict' | 'none' | undefined;
}

/** A cookie the HTTP layer must set on its response (an empty value with `maxAge: 0` clears it). */
export interface SessionCookie {
  name: string;
  value: string;
  options: SessionCookieOptions;
}

export interface VerifiedSession extends AuthUser {
  /** Session cookies to set on the `/auth/confirm` response. */
  cookies: SessionCookie[];
}

export interface RefreshedSession {
  /** The response to return: the given one with any refreshed session cookies applied. */
  response: Response;
  /** The verified user, or null when there is no valid session (the proxy redirects to /login). */
  user: AuthUser | null;
}

export interface AuthProvider {
  /** Creates a confirmed user; PermanentError `auth_user_exists` if the email is taken (check `findUserByEmail` first). */
  createUser(email: string): Promise<{ userId: string }>;

  /** Looks a user up by email (case-insensitive); null when none. */
  findUserByEmail(email: string): Promise<{ userId: string } | null>;

  /** Deletes a user; an already-deleted user counts as success. */
  deleteUser(userId: string): Promise<void>;

  /**
   * Mints a magic-link token for an existing user without sending anything; the caller emails
   * `${APP_URL}/auth/confirm#th=<hashedToken>&type=email` through the Mailer. Call it only for an
   * existing user: live Supabase silently creates unknown ones (D-22).
   */
  generateLink(email: string): Promise<{ hashedToken: string; userId: string }>;

  /** Verifies a link's token hash (`verifyOtp`); the session plus cookies to set, or null if invalid, used or expired. */
  verify(tokenHash: string, type: AuthOtpType): Promise<VerifiedSession | null>;

  /**
   * The user of a verified session, read from the request's cookies only; null if none. Never
   * refreshes (the proxy does); Server Components pass a Request built from `headers()`.
   */
  getVerifiedUser(request: Request): Promise<AuthUser | null>;

  /** Proxy only: refreshes the session cookies on app paths and reports the verified user (PLAN §7.7). */
  refreshSession(request: Request, response: Response): Promise<RefreshedSession>;

  /** Ends the session; the cookies to clear on the sign-out response. */
  signOut(request: Request): Promise<SessionCookie[]>;
}
