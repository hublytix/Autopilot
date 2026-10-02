import 'server-only';
import type { FakeAdapters } from '@/server/adapters/fake';
import type { Db } from '@/server/db';
import type { Deps, SessionCookie } from '@/server/ports';
import { seedAccount, seedConnection } from '@/server/jobs/testing';
import { issuePendingInstallCookie } from '@/server/services/install/cookies';

// Test support for the auth flows (Vitest only; nothing in the app imports this): a pending install
// as the OAuth callback leaves it, the magic links the fake mailer delivered, and the POST a browser
// sends from /auth/confirm.

export interface PendingInstallSeed {
  readonly accountId: string;
  readonly installedAt: Date;
  /** The `ap_pending_install` cookie the callback would have set. */
  readonly cookie: SessionCookie;
}

/** An unbound account in onboarding with an active connection and a fresh pending_install cookie. */
export async function seedPendingInstall(deps: Deps, input: { installerEmail?: string | null; now?: Date } = {}): Promise<PendingInstallSeed> {
  const now = input.now ?? deps.clock.now();
  const accountId = await seedAccount(deps.db, { now, processingState: 'onboarding' });
  await seedConnection(deps.db, { accountId, now });
  const cookie = issuePendingInstallCookie(
    deps.env,
    { accountId, installerEmail: input.installerEmail === undefined ? 'installer@brightside-plumbing.example' : input.installerEmail, installedAt: now },
    now,
  );
  return { accountId, installedAt: now, cookie };
}

export interface DeliveredMagicLink {
  readonly to: readonly string[];
  readonly subject: string;
  readonly replyTo: string | undefined;
  readonly url: string;
  /** The hashed token from the URL fragment. */
  readonly tokenHash: string;
  readonly type: string;
  readonly text: string;
}

const LINK = /(https?:\/\/[^\s"<>]+\/auth\/confirm#th=([A-Za-z0-9_%-]+)&(?:amp;)?type=([a-z]+))/;

/** Every magic-link email the fake mailer delivered, oldest first. */
export function deliveredMagicLinks(fakes: Pick<FakeAdapters, 'mailer'>): DeliveredMagicLink[] {
  return fakes.mailer.sent
    .filter((mail) => mail.kind === 'magic_link')
    .map((mail) => {
      const match = LINK.exec(mail.text) ?? LINK.exec(mail.html);
      if (match === null) throw new Error('magic_link_without_link');
      return {
        to: mail.to,
        subject: mail.subject,
        replyTo: mail.replyTo,
        url: (match[1] ?? '').replace('&amp;', '&'),
        tokenHash: decodeURIComponent(match[2] ?? ''),
        type: match[3] ?? '',
        text: mail.text,
      };
    });
}

/** The newest magic link, or an error when none was sent. */
export function lastMagicLink(fakes: Pick<FakeAdapters, 'mailer'>): DeliveredMagicLink {
  const links = deliveredMagicLinks(fakes);
  const last = links.at(-1);
  if (last === undefined) throw new Error('no_magic_link_sent');
  return last;
}

/** The POST the /auth/confirm page's form sends (same-origin), from client `ip`. */
export function confirmPostRequest(appUrl: string, input: { tokenHash: string; type: string; ip?: string; cookie?: string | null; origin?: string | null }): Request {
  const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded', 'x-real-ip': input.ip ?? '198.51.100.20' });
  const origin = input.origin === undefined ? appUrl : input.origin;
  if (origin !== null) headers.set('origin', origin);
  if (input.cookie !== undefined && input.cookie !== null) headers.set('cookie', input.cookie);
  const body = `th=${encodeURIComponent(input.tokenHash)}&type=${encodeURIComponent(input.type)}`;
  return new Request(`${appUrl}/auth/confirm`, { method: 'POST', headers, body });
}

/** Rows of `accounts` the auth flows touch. */
export async function accountAuthState(db: Db, accountId: string) {
  return db.one<{
    owner_user_id: string | null;
    pending_owner_email: string | null;
    pending_owner_expires_at: Date | null;
    pending_owner_auth_user_id: string | null;
    last_install_at: Date;
  }>(`select owner_user_id, pending_owner_email, pending_owner_expires_at, pending_owner_auth_user_id, last_install_at from accounts where id = $1`, [
    accountId,
  ]);
}
