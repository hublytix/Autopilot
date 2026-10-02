import 'server-only';
import { z } from 'zod';
import { checkRecipient, chooseComposeClient, isPhone, type ComposeClient } from '@/server/domain/compose';
import { defangLeadText } from '@/server/domain/defang';
import { errorCode } from '@/server/domain/errors';
import { isDraftKind, type DraftKind, type ValidationErrorCode } from '@/server/domain/types';
import { validateDraft, type ValidatorBrief } from '@/server/domain/validator';
import type { Db } from '@/server/db';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { verifyActionToken } from '@/server/security/action-tokens';
import { loadDraftContext } from '@/server/services/drafting/repository';
import { issueBeacon } from './beacon';
import { judgeClick, recordClick } from './click';
import { loadSendContext, type SendContext } from './context';
import { hitActionLinkLimits } from './limits';
import { composeTarget, type CopyReason } from './send';

// /a/{token}/edit (PLAN §7.4, D-13, D-26, D-47): "Edit first".
//
// GET shows the draft's subject and body in editable fields, the lead's message under "Message from
// the lead (unverified)" with its addresses defanged, and the BCC logging address. Opening the page
// records nothing (mail scanners open links); its beacon counts the click on a person's first
// gesture (D-26, D-62).
//
// POST takes the edited subject and body and answers 200 (never a 302, D-13) with:
// - "Send from my email": the compose link for the owner's mail client (the `mailto:` link on a
//   phone), built from the EDITED text;
// - "Open in default mail app": the `mailto:` link, when it differs and fits COMPOSE_URL_LIMIT;
// - "Copy your reply": the parts to copy (the only way when the link is too long or the address
//   unusual).
// The owner is in charge: the draft validator's codes are shown as hints and never block; only an
// empty or oversized subject or body is refused. The POST is a person's action (a same-origin form
// submit a scanner does not make), so it counts like the beacon: not from a scanner user agent, not
// a prefetch. The edited text is never stored and never logged: it lives in this request and the
// page it renders, nothing else.

/** The largest edited subject and body accepted, in characters (code points). */
export const EDIT_INPUT_LIMITS = { subjectMaxChars: 300, bodyMaxChars: 10_000 } as const;

export type EditInputIssueCode = 'subject_required' | 'subject_too_long' | 'body_required' | 'body_too_long';

export interface EditView {
  /** The lead's address as stored; null when missing. */
  readonly recipient: string | null;
  /** False when the address is missing or not one bare address. */
  readonly recipientValid: boolean;
  /** The draft, to pre-fill the fields. */
  readonly subject: string;
  readonly body: string;
  /** The BCC logging address (D-46), when set. */
  readonly bcc: string | null;
  /** The lead's message, controls stripped and addresses defanged (D-47); null when there is none. */
  readonly leadMessage: string | null;
  readonly beaconNonce: string;
}

export type EditLinkState =
  | { readonly type: 'edit'; readonly view: EditView }
  | { readonly type: 'expired' }
  | { readonly type: 'invalid' }
  | { readonly type: 'rate_limited'; readonly retryAfterSeconds: number };

export interface EditLinkRequest {
  /** The path segment, untrusted. */
  readonly token: string;
  /** Client IP, for the rate limit only (stored as an HMAC). */
  readonly ip: string;
}

export interface EditSubmission extends EditLinkRequest {
  readonly userAgent: string | null;
  /** Sec-CH-UA-Mobile. */
  readonly chUaMobile: string | null;
  /** Prefetch/prerender request headers were present. */
  readonly prefetch: boolean;
  /** The form fields, untrusted. */
  readonly subject: unknown;
  readonly body: unknown;
}

export interface EditedReply {
  readonly recipient: string | null;
  readonly recipientValid: boolean;
  /** The edited text, as the owner sent it (line breaks normalised, ends trimmed). */
  readonly subject: string;
  readonly body: string;
  readonly bcc: string | null;
  /** The draft validator's codes for the edited text: hints, never a block. */
  readonly hints: readonly ValidationErrorCode[];
  /** The "Send from my email" link, or why the copy view is shown instead. */
  readonly send:
    | { readonly type: 'link'; readonly url: string; readonly client: ComposeClient }
    | { readonly type: 'copy'; readonly reason: CopyReason };
  /** "Open in default mail app": the mailto: link when it differs from the send link and fits. */
  readonly mailtoUrl: string | null;
}

export type EditSubmitOutcome =
  | { readonly type: 'ready'; readonly reply: EditedReply }
  /** Empty or oversized input; the values are echoed back so the form keeps what was typed. */
  | {
      readonly type: 'rejected';
      readonly issues: readonly { readonly field: 'subject' | 'body'; readonly code: EditInputIssueCode }[];
      readonly subject: string;
      readonly body: string;
    }
  | { readonly type: 'expired' }
  | { readonly type: 'invalid' }
  | { readonly type: 'rate_limited'; readonly retryAfterSeconds: number };

const lineBreaks = (value: string): string => value.replace(/\r\n?/g, '\n');
const chars = (value: string): number => Array.from(value).length;

const fieldText = z.preprocess((value) => (typeof value === 'string' ? value : ''), z.string());
const EditInputSchema = z.object({
  subject: fieldText.transform((value) => lineBreaks(value).trim()),
  body: fieldText.transform((value) => lineBreaks(value).trim()),
});

type ParsedInput =
  | { readonly ok: true; readonly subject: string; readonly body: string }
  | { readonly ok: false; readonly issues: Extract<EditSubmitOutcome, { type: 'rejected' }>['issues']; readonly subject: string; readonly body: string };

/** Zod for the form fields, then the only checks that block: empty or oversized. */
export function parseEditInput(input: { subject: unknown; body: unknown }): ParsedInput {
  const { subject, body } = EditInputSchema.parse(input);
  const issues: { field: 'subject' | 'body'; code: EditInputIssueCode }[] = [];
  if (subject === '') issues.push({ field: 'subject', code: 'subject_required' });
  else if (chars(subject) > EDIT_INPUT_LIMITS.subjectMaxChars) issues.push({ field: 'subject', code: 'subject_too_long' });
  if (body === '') issues.push({ field: 'body', code: 'body_required' });
  else if (chars(body) > EDIT_INPUT_LIMITS.bodyMaxChars) issues.push({ field: 'body', code: 'body_too_long' });
  return issues.length === 0 ? { ok: true, subject, body } : { ok: false, issues, subject, body };
}

/** The brief the validator uses before the owner has saved one: nothing allowed beyond the defaults. */
const EMPTY_BRIEF: ValidatorBrief = {
  company_name: '',
  one_line: '',
  services: [],
  who_we_serve: '',
  booking_link: null,
  tone: { note: '' },
  sign_off_name: '',
  allow_pricing: false,
  never_promise: [],
  faqs: [],
};

async function leadMessageOf(db: Db, context: SendContext): Promise<string | null> {
  const row = await db.maybeOne<{ message: string | null }>(`select message from lead_messages where lead_id = $1 and account_id = $2`, [
    context.leadId,
    context.accountId,
  ]);
  const shown = row?.message === null || row?.message === undefined ? '' : defangLeadText(row.message).trim();
  return shown === '' ? null : shown;
}

async function draftKindOf(db: Db, context: SendContext): Promise<DraftKind | null> {
  const row = await db.maybeOne<{ kind: string }>(`select kind from drafts where id = $1 and account_id = $2`, [context.draftId, context.accountId]);
  return row !== null && isDraftKind(row.kind) ? row.kind : null;
}

/** loadDraftContext's codes for a lead or content that is gone. */
const CONTENT_GONE: ReadonlySet<string> = new Set(['draft_lead_not_found', 'draft_content_missing']);

/** The validator's codes for the edited text; null when the lead's content disappeared meanwhile. */
async function hintsFor(db: Db, context: SendContext, edited: { subject: string; body: string }): Promise<ValidationErrorCode[] | null> {
  const kind = await draftKindOf(db, context);
  if (kind === null) return null;
  try {
    const draft = await loadDraftContext(db, { accountId: context.accountId, leadId: context.leadId, kind });
    return validateDraft(edited, {
      kind,
      brief: draft.brief ?? EMPTY_BRIEF,
      firstName: draft.lead.firstName,
      leadMessage: draft.lead.message,
      siteUrl: draft.siteUrl,
    });
  } catch (error) {
    // Purged between the two reads.
    if (CONTENT_GONE.has(errorCode(error))) return null;
    throw error;
  }
}

/** GET: the edit form's content. Records nothing but the rate-limit counters and the beacon nonce. */
export async function resolveEditLink(deps: Deps, request: EditLinkRequest): Promise<EditLinkState> {
  const retryAfterSeconds = await hitActionLinkLimits(deps, request.ip, request.token);
  if (retryAfterSeconds !== null) return { type: 'rate_limited', retryAfterSeconds };
  const checked = await verifyActionToken(deps.db, request.token, 'edit', deps.clock.now());
  if (!checked.ok) return { type: 'invalid' };
  const loaded = await loadSendContext(deps.db, checked.token);
  if (loaded.type !== 'ok') return loaded;
  const { context } = loaded;
  return {
    type: 'edit',
    view: {
      recipient: context.recipient,
      recipientValid: context.recipient !== null && checkRecipient(context.recipient).ok,
      subject: context.subject,
      body: context.body,
      bcc: context.bcc,
      leadMessage: await leadMessageOf(deps.db, context),
      beaconNonce: await issueBeacon(deps, context.tokenId),
    },
  };
}

/** POST: the edited reply's links and hints. Never stores or logs the edited text. */
export async function submitEditedReply(deps: Deps, request: EditSubmission): Promise<EditSubmitOutcome> {
  const retryAfterSeconds = await hitActionLinkLimits(deps, request.ip, request.token);
  if (retryAfterSeconds !== null) return { type: 'rate_limited', retryAfterSeconds };
  const now = deps.clock.now();
  const checked = await verifyActionToken(deps.db, request.token, 'edit', now);
  if (!checked.ok) return { type: 'invalid' };
  const loaded = await loadSendContext(deps.db, checked.token);
  if (loaded.type !== 'ok') return loaded;
  const { context } = loaded;

  const input = parseEditInput({ subject: request.subject, body: request.body });
  if (!input.ok) return { type: 'rejected', issues: input.issues, subject: input.subject, body: input.body };
  const hints = await hintsFor(deps.db, context, input);
  if (hints === null) return { type: 'expired' };

  const verdict = judgeClick({ method: 'POST', userAgent: request.userAgent, prefetch: request.prefetch, beacon: true, now, sentAt: context.sentAt });
  if (verdict.human) await recordClick(deps.db, { tokenId: context.tokenId, accountId: context.accountId, now });

  const edited: SendContext = { ...context, subject: input.subject, body: input.body };
  const client = chooseComposeClient({
    mailClient: context.mailClient,
    phone: isPhone({ userAgent: request.userAgent, chUaMobile: request.chUaMobile }),
    viaMailto: false,
  });
  const send = composeTarget(deps, edited, client);
  const mailto = client === 'mailto' ? null : composeTarget(deps, edited, 'mailto');
  log.info('edited reply prepared', {
    event: 'action_link.edit',
    accountId: context.accountId,
    leadId: context.leadId,
    mode: send.type === 'copy' ? 'copy' : send.client,
    outcome: verdict.human ? 'click_recorded' : 'click_not_recorded',
    reason: verdict.human ? undefined : verdict.reason,
    codes: hints,
  });
  return {
    type: 'ready',
    reply: {
      recipient: context.recipient,
      recipientValid: send.type === 'link' || send.reason !== 'invalid_recipient',
      subject: input.subject,
      body: input.body,
      bcc: context.bcc,
      hints,
      send: send.type === 'link' ? { type: 'link', url: send.link.url, client: send.client } : { type: 'copy', reason: send.reason },
      mailtoUrl: mailto?.type === 'link' ? mailto.link.url : null,
    },
  };
}
