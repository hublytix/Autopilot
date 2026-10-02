import 'server-only';
import { PermanentError } from '@/server/domain/errors';
import { eol, oneLine, pct } from './encode';
import { checkRecipient, pctAddr, type BareAddress, type RecipientProblem } from './recipient';

// Compose-link builders (D-13, CMP-BUILDER-SPEC; golden vectors in test/fixtures/compose-vectors.json).
//
//   mailto   'mailto:' + to + '?' + cc= + bcc= + subject= + body=      (body CRLF, RFC 6068)
//   gmail    u form (default):  https://mail.google.com/mail/u/{0|account}/?to=&cc=&bcc=&su=&body=&tf=cm
//            view form:         https://mail.google.com/mail/[u/{account}/]?view=cm&fs=1&to=&cc=&bcc=&su=&body=
//                               (body LF; `su` is Gmail's subject parameter)
//   outlook  mailtouri (default): {base}?mailtouri=pct(mailto)   (the browser's mailto-handler contract)
//            params:              {base}?to=&cc=&bcc=&subject=&body=  (body LF)
//
// Empty cc/bcc lists, an empty subject and an empty body are left out. Every value goes through
// pct() (never URLSearchParams); every address through checkRecipient() + pctAddr(). The result is
// already what WHATWG URL parsing and NextResponse.redirect produce, so a redirect's Location is the
// same string byte for byte.

export const COMPOSE_CLIENTS = ['gmail', 'outlook_work', 'outlook_personal', 'other', 'mailto'] as const;
/** The owner's mail client (settings.mail_client), or `mailto` when the page forces the device's mail app. */
export type ComposeClient = (typeof COMPOSE_CLIENTS)[number];
export type GmailForm = 'u' | 'view';
export type OutlookMode = 'mailtouri' | 'params';

export interface ComposeMessage {
  readonly to: readonly string[];
  readonly cc?: readonly string[] | undefined;
  readonly bcc?: readonly string[] | undefined;
  readonly subject: string;
  readonly body: string;
}

export interface ComposeOptions {
  /** COMPOSE_GMAIL_FORM. */
  readonly gmailForm: GmailForm;
  /** COMPOSE_OUTLOOK_MODE. */
  readonly outlookMode: OutlookMode;
  /** COMPOSE_OUTLOOK_WORK_BASE / COMPOSE_OUTLOOK_PERSONAL_BASE. */
  readonly outlookWorkBase: string;
  readonly outlookPersonalBase: string;
  /**
   * The "Gmail address I send from" (settings.gmail_account_email, CMP-GMAIL-MULTIACCOUNT): selects the
   * Gmail account with /mail/u/{email}/. Left out when unset or not a bare address.
   */
  readonly gmailAccount?: string | null | undefined;
}

export interface ComposeInput extends ComposeMessage, ComposeOptions {
  readonly client: ComposeClient;
}

export interface ComposeLink {
  readonly url: string;
  /** `url.length`: the per-client length check (COMPOSE_URL_LIMIT) runs on the final URL. */
  readonly length: number;
}

/** A to/cc/bcc entry is not one bare address (the message names the field only, never the value). */
export class InvalidRecipientError extends PermanentError<'compose_invalid_recipient'> {
  override readonly name: string = 'InvalidRecipientError';
  readonly field: 'to' | 'cc' | 'bcc';
  readonly problem: RecipientProblem;

  constructor(field: 'to' | 'cc' | 'bcc', problem: RecipientProblem) {
    super('compose_invalid_recipient');
    this.field = field;
    this.problem = problem;
  }
}

interface Parsed {
  readonly to: readonly BareAddress[];
  readonly cc: readonly BareAddress[];
  readonly bcc: readonly BareAddress[];
  readonly subject: string;
  readonly body: string;
}

function parseList(field: 'to' | 'cc' | 'bcc', list: readonly string[] | undefined): BareAddress[] {
  return (list ?? []).map((raw) => {
    const checked = checkRecipient(raw);
    if (!checked.ok) throw new InvalidRecipientError(field, checked.problem);
    return checked.address;
  });
}

function parseMessage(message: ComposeMessage): Parsed {
  const to = parseList('to', message.to);
  if (to.length === 0) throw new InvalidRecipientError('to', 'empty');
  return { to, cc: parseList('cc', message.cc), bcc: parseList('bcc', message.bcc), subject: message.subject, body: message.body };
}

function addrList(list: readonly BareAddress[]): string {
  return list.map(pctAddr).join(',');
}

/** The address-list, subject and body fields shared by every query-string form. */
function fields(message: Parsed, names: { subject: 'subject' | 'su'; to: boolean }, lineBreak: '\r\n' | '\n'): string[] {
  const out: string[] = [];
  if (names.to) out.push(`to=${addrList(message.to)}`);
  if (message.cc.length > 0) out.push(`cc=${addrList(message.cc)}`);
  if (message.bcc.length > 0) out.push(`bcc=${addrList(message.bcc)}`);
  if (message.subject !== '') out.push(`${names.subject}=${pct(oneLine(message.subject))}`);
  if (message.body !== '') out.push(`body=${pct(eol(message.body, lineBreak))}`);
  return out;
}

function mailtoUri(message: Parsed): string {
  const query = fields(message, { subject: 'subject', to: false }, '\r\n');
  return `mailto:${addrList(message.to)}${query.length > 0 ? `?${query.join('&')}` : ''}`;
}

function gmailAccount(raw: string | null | undefined): BareAddress | null {
  if (raw === null || raw === undefined) return null;
  const checked = checkRecipient(raw);
  return checked.ok ? checked.address : null;
}

function gmailUrl(message: Parsed, form: GmailForm, account: BareAddress | null): string {
  const query = fields(message, { subject: 'su', to: true }, '\n');
  if (form === 'view') {
    const path = account === null ? '' : `u/${pctAddr(account)}/`;
    return `https://mail.google.com/mail/${path}?${['view=cm', 'fs=1', ...query].join('&')}`;
  }
  return `https://mail.google.com/mail/u/${account === null ? '0' : pctAddr(account)}/?${[...query, 'tf=cm'].join('&')}`;
}

function outlookUrl(message: Parsed, base: string, mode: OutlookMode): string {
  const separator = base.includes('?') ? '&' : '?';
  if (mode === 'mailtouri') return `${base}${separator}mailtouri=${pct(mailtoUri(message))}`;
  return `${base}${separator}${fields(message, { subject: 'subject', to: true }, '\n').join('&')}`;
}

/** The compose URL for `input.client`. Throws InvalidRecipientError unless every address is one bare address. */
export function buildCompose(input: ComposeInput): ComposeLink {
  const message = parseMessage(input);
  let url: string;
  switch (input.client) {
    case 'gmail':
      url = gmailUrl(message, input.gmailForm, gmailAccount(input.gmailAccount));
      break;
    case 'outlook_work':
      url = outlookUrl(message, input.outlookWorkBase, input.outlookMode);
      break;
    case 'outlook_personal':
      url = outlookUrl(message, input.outlookPersonalBase, input.outlookMode);
      break;
    case 'other':
    case 'mailto':
      url = mailtoUri(message);
      break;
  }
  return { url, length: url.length };
}

/** The RFC 6068 `mailto:` URI for `message` (the interstitial's target). */
export function buildMailto(message: ComposeMessage): ComposeLink {
  const url = mailtoUri(parseMessage(message));
  return { url, length: url.length };
}

/** D-13: a link longer than COMPOSE_URL_LIMIT is replaced by the copy-reply page. */
export function fitsComposeLimit(link: ComposeLink, limit: number): boolean {
  return link.length <= limit;
}
