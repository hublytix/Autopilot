import 'server-only';
import type { ComposeClient } from '@/server/domain/compose';
import { errorCode } from '@/server/domain/errors';
import type { ValidationErrorCode } from '@/server/domain/types';
import { requestFromHeaders, type HeadersLike } from '@/server/http/auth/request';
import { clientIp } from '@/server/http/hubspot-install';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { isSameOriginHeaders } from '@/server/security/same-origin';
import { isPrefetchRequest } from '@/server/services/action-links/click';
import {
  EDIT_INPUT_LIMITS,
  resolveEditLink,
  submitEditedReply,
  type EditInputIssueCode,
  type EditView,
} from '@/server/services/action-links/edit';
import { actionLinkPath } from '@/server/services/action-links/paths';
import { ACTION_LINK_MESSAGES, neverSendsLine, type PageMessage } from './messages';

// /a/{token}/edit (PLAN §7.4, D-13): the page state for the Server Component (GET), and the form
// submission the Server Action hands over (POST, answered by re-rendering the page with the result:
// a 200, never a 302). Both run the /a/* rate limits and the token checks in services/action-links.
// The POST must come from this app's own page (PLAN §7.1 "origin": the Origin header, or
// Sec-Fetch-Site: same-origin), on top of Next's own Server Action check, which lets a request
// without any Origin through. The edited text goes back to the owner's page only: it is never
// stored and never logged (only codes and ids are).

/** Shown instead of the form when the POST did not come from the page. */
export const EDIT_CROSS_ORIGIN_MESSAGE: PageMessage = {
  title: "We couldn't use these changes",
  paragraphs: ['Changes are accepted only from the page the email links to. Open the link from the email again and make your changes there.'],
};

/** The validator's codes as plain hints (the owner decides; nothing here blocks a send). */
export const EDIT_HINTS: Readonly<Record<ValidationErrorCode, string>> = {
  too_long: "It's longer than the drafts we write (120 words for your first reply, 70 for a follow-up).",
  not_plain_text: 'It has formatting such as HTML or markdown (for example **bold** or # headings), which shows up as symbols in a plain email.',
  placeholder: 'It still has a placeholder, such as [Name] or {first_name}, to fill in.',
  missing_first_name: "It doesn't use the lead's first name.",
  missing_booking_link: "Your booking link isn't in it.",
  currency: 'It mentions a price or an amount of money, and your brief says not to quote prices.',
  never_promise: 'It includes something your brief says never to promise.',
  bad_subject: 'The subject is longer than 120 characters or has line breaks or control characters.',
  url_not_allowed: "It has a web address other than your website or your booking link. Check it's one you meant to share.",
  contact_not_allowed: "It has an email address or phone number that isn't in your brief. Check it's one you meant to share.",
  addresses_owner: 'Part of it reads like a note to you or to an assistant rather than your reply to the lead.',
  echoes_lead: "It repeats a long passage of the lead's message word for word.",
};

/** Why an edit was refused (the only checks that block). */
export const EDIT_INPUT_ERRORS: Readonly<Record<EditInputIssueCode, string>> = {
  subject_required: 'Enter a subject.',
  subject_too_long: `Shorten the subject to at most ${EDIT_INPUT_LIMITS.subjectMaxChars} characters.`,
  body_required: 'Write your reply.',
  body_too_long: `Shorten your reply to at most ${EDIT_INPUT_LIMITS.bodyMaxChars.toLocaleString('en-US')} characters.`,
};

const TARGET_NAMES: Readonly<Record<ComposeClient, string>> = {
  gmail: 'Gmail',
  outlook_work: 'Outlook',
  outlook_personal: 'Outlook',
  other: 'your mail app',
  mailto: 'your mail app',
};

export interface EditLimits {
  readonly subjectMaxChars: number;
  readonly bodyMaxChars: number;
}

export type EditPageState =
  | {
      readonly type: 'edit';
      readonly view: EditView;
      /** `/a/{token}/beacon`. */
      readonly beaconPath: string;
      readonly neverSends: string;
      readonly limits: EditLimits;
    }
  | { readonly type: 'message'; readonly message: PageMessage };

export interface EditHint {
  readonly code: ValidationErrorCode;
  readonly text: string;
}

/** The result page's content (useActionState state: plain, serialisable data). */
export interface EditReadyView {
  readonly recipient: string | null;
  readonly recipientValid: boolean;
  readonly subject: string;
  readonly body: string;
  readonly bcc: string | null;
  readonly hints: readonly EditHint[];
  /** "Send from my email" (the owner's compose link); null when the copy view replaces it. */
  readonly sendUrl: string | null;
  /** Where that link opens: "Gmail", "Outlook" or "your mail app". */
  readonly sendTarget: string | null;
  /** Why there is no send link. */
  readonly copyReason: 'too_long' | 'invalid_recipient' | null;
  /** "Open in default mail app" (mailto:), when it differs from the send link and fits. */
  readonly mailtoUrl: string | null;
}

export interface EditFieldErrors {
  readonly subject?: string;
  readonly body?: string;
}

export type EditFormState =
  /** Nothing submitted yet: the form with the draft. */
  | { readonly type: 'idle' }
  /** Empty or oversized input: the form again, with what was typed and the errors. */
  | { readonly type: 'input_error'; readonly errors: EditFieldErrors; readonly subject: string; readonly body: string }
  | { readonly type: 'ready'; readonly reply: EditReadyView }
  | { readonly type: 'message'; readonly message: PageMessage };

export const EDIT_IDLE: EditFormState = { type: 'idle' };

/** PLAN §7.1 "origin" for a form post read through next/headers. */
export function formFromSameOrigin(appUrl: string, headers: HeadersLike): boolean {
  return isSameOriginHeaders(headers, appUrl);
}

function ipOf(deps: Deps, headers: HeadersLike): string {
  return clientIp(requestFromHeaders(deps.env.APP_URL, headers));
}

/** GET /a/{token}/edit: the form's content, or one of the shared messages. */
export async function editPageState(deps: Deps, token: string, headers: HeadersLike): Promise<EditPageState> {
  try {
    const state = await resolveEditLink(deps, { token, ip: ipOf(deps, headers) });
    switch (state.type) {
      case 'edit':
        return {
          type: 'edit',
          view: state.view,
          beaconPath: actionLinkPath(token, 'beacon'),
          neverSends: neverSendsLine(deps.env.PRODUCT_NAME),
          limits: { subjectMaxChars: EDIT_INPUT_LIMITS.subjectMaxChars, bodyMaxChars: EDIT_INPUT_LIMITS.bodyMaxChars },
        };
      case 'expired':
        return { type: 'message', message: ACTION_LINK_MESSAGES.expired };
      case 'invalid':
        return { type: 'message', message: ACTION_LINK_MESSAGES.invalid };
      case 'rate_limited':
        return { type: 'message', message: ACTION_LINK_MESSAGES.rateLimited };
    }
  } catch (error) {
    log.error('edit page failed', { event: 'action_link.edit_page_failed', code: errorCode(error) }, error);
    return { type: 'message', message: ACTION_LINK_MESSAGES.unavailable };
  }
}

export interface EditFormRequest {
  /** The request headers (next/headers in the Server Action). */
  readonly headers: HeadersLike;
  readonly formData: FormData;
}

/** POST /a/{token}/edit: the result page's state. */
export async function submitEditForm(deps: Deps, token: string, request: EditFormRequest): Promise<EditFormState> {
  const { headers, formData } = request;
  if (!formFromSameOrigin(deps.env.APP_URL, headers)) return { type: 'message', message: EDIT_CROSS_ORIGIN_MESSAGE };
  try {
    const outcome = await submitEditedReply(deps, {
      token,
      ip: ipOf(deps, headers),
      userAgent: headers.get('user-agent'),
      chUaMobile: headers.get('sec-ch-ua-mobile'),
      prefetch: isPrefetchRequest(headers),
      subject: formData.get('subject'),
      body: formData.get('body'),
    });
    switch (outcome.type) {
      case 'ready': {
        const { reply } = outcome;
        return {
          type: 'ready',
          reply: {
            recipient: reply.recipient,
            recipientValid: reply.recipientValid,
            subject: reply.subject,
            body: reply.body,
            bcc: reply.bcc,
            hints: reply.hints.map((code) => ({ code, text: EDIT_HINTS[code] })),
            sendUrl: reply.send.type === 'link' ? reply.send.url : null,
            sendTarget: reply.send.type === 'link' ? TARGET_NAMES[reply.send.client] : null,
            copyReason: reply.send.type === 'copy' ? reply.send.reason : null,
            mailtoUrl: reply.mailtoUrl,
          },
        };
      }
      case 'rejected': {
        const subjectIssue = outcome.issues.find((issue) => issue.field === 'subject');
        const bodyIssue = outcome.issues.find((issue) => issue.field === 'body');
        return {
          type: 'input_error',
          errors: {
            ...(subjectIssue === undefined ? {} : { subject: EDIT_INPUT_ERRORS[subjectIssue.code] }),
            ...(bodyIssue === undefined ? {} : { body: EDIT_INPUT_ERRORS[bodyIssue.code] }),
          },
          subject: outcome.subject,
          body: outcome.body,
        };
      }
      case 'expired':
        return { type: 'message', message: ACTION_LINK_MESSAGES.expired };
      case 'invalid':
        return { type: 'message', message: ACTION_LINK_MESSAGES.invalid };
      case 'rate_limited':
        return { type: 'message', message: ACTION_LINK_MESSAGES.rateLimited };
    }
  } catch (error) {
    log.error('edit submit failed', { event: 'action_link.edit_failed', code: errorCode(error) }, error);
    return { type: 'message', message: ACTION_LINK_MESSAGES.unavailable };
  }
}
