import 'server-only';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';

// Branch (d) of the OAuth callback when the installer is the owner (D-35): "Sign in to finish
// reconnecting", plus a magic link with `next=/dashboard?reconnect=1`.
//
// M3 HOOK: the magic link needs login intents, the AuthProvider link flow and the MagicLink template,
// which arrive in M3. Until then this records that a link is owed and sends nothing; M3 replaces the
// body with: generateLink(owner email) → login intent (purpose 'login', next RECONNECT_NEXT) →
// reserveAndSend('magic_link', …).

export const RECONNECT_NEXT = '/dashboard?reconnect=1';

export interface ReconnectMagicLinkInput {
  readonly accountId: string;
}

export type SendReconnectMagicLink = (deps: Deps, input: ReconnectMagicLinkInput) => Promise<void>;

export const sendReconnectMagicLink: SendReconnectMagicLink = async (_deps, input) => {
  log.info('reconnect magic link pending', { event: 'install.reconnect_magic_link_pending', accountId: input.accountId });
};
