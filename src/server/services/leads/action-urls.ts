import 'server-only';
import { PermanentError } from '@/server/domain/errors';
import type { MintedTokens } from '@/server/security/action-tokens';
import { actionLinkPath } from '@/server/services/action-links/paths';

// The three buttons of a lead email and the "Open in default mail app" link (PLAN §7.4, D-13, D-45):
// `/a/{send}/send`, `/a/{edit}/edit`, `/a/{dismiss}/dismiss` and `/a/{send}/send?via=mailto`, each
// token minted (and committed) by reserveAndSend before the render. Never log these URLs.

/** Button purposes of every lead email that carries a draft. */
export const LEAD_EMAIL_BUTTONS = ['send', 'edit', 'dismiss'] as const;

export interface LeadActionUrls {
  readonly sendUrl: string;
  readonly editUrl: string;
  readonly dismissUrl: string;
  readonly mailtoUrl: string;
}

function token(tokens: MintedTokens, purpose: (typeof LEAD_EMAIL_BUTTONS)[number]): string {
  const value = tokens[purpose];
  if (value === undefined) throw new PermanentError('lead_email_token_missing');
  return value;
}

export function leadActionUrls(appUrl: string, tokens: MintedTokens): LeadActionUrls {
  const send = `${appUrl}${actionLinkPath(token(tokens, 'send'), 'send')}`;
  return {
    sendUrl: send,
    editUrl: `${appUrl}${actionLinkPath(token(tokens, 'edit'), 'edit')}`,
    dismissUrl: `${appUrl}${actionLinkPath(token(tokens, 'dismiss'), 'dismiss')}`,
    mailtoUrl: `${send}?via=mailto`,
  };
}
