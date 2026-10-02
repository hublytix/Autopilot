import 'server-only';
import type { ContactStopFacts } from './stops';
import type { EmailDirection, HubSpotContactProperty } from './types';

// What HubSpot's data says about a lead after its first notification (brief §5.6, §5.9, law 3,
// PLAN §9.5 steps 3-4, D-08, D-09, HS-CONFIRMED-SEND, HS-REPLY-SIGNAL, HS-CONTACT-ACTIVITY-PROPS,
// HS-OPTOUT, HS-BOUNCE-BADADDRESS). Pure: the contact's properties and its logged emails'
// metadata in, HubSpot event times out. Never content (law 4): no subject, body or header is read.
//
// The lead's addresses: the contact's `email`, each of `hs_additional_emails`, and the address the
// lead submitted while it is stored; compared exactly, case-insensitively, after trimming.
//
// - Confirmed send: the earliest `hs_timestamp` of an `EMAIL` (the owner's outbound) whose status is
//   absent or SENT, at or after first_notified_at − 60 s (clock skew), with one of the lead's
//   addresses among its recipients (`hs_email_to_email`). A CC'd lead or a colleague's thread on
//   the same contact does not count.
// - Reply: the earliest `INCOMING_EMAIL` or `FORWARDED_EMAIL` from one of the lead's addresses
//   (`hs_email_from_email`), strictly after GREATEST(first_notified_at, replies_ignored_before)
//   (D-42: replies before a "Resume follow-ups" are ignored). A third party's email on the contact
//   never stops follow-ups.
// - Fallback, positive only: `hs_sales_email_last_replied`, held to the same time rule, counts as a
//   reply only when no engagement shows one. A missing or older value never proves "no reply" and
//   never clears anything.
// - Never reply evidence: notes_last_contacted, hs_last_sales_activity_timestamp,
//   num_contacted_notes, hs_email_last_reply_date (they are not read at all).
// - Contact stops: hs_email_optout == "true" → opted out; a non-empty
//   hs_email_hard_bounce_reason_enum or hs_email_bad_address == "true" → bounced; so is an EMAIL to
//   one of the lead's addresses with status BOUNCED at or after first_notified_at − 60 s (the owner's
//   send bounced: the address is undeliverable, D-09 extended by D-73).
// - One contact, several leads: the window of a lead ends where the owner was first emailed about a
//   newer lead of the same contact (`until`, D-44's rule): a send, a reply or a bounce at or after it
//   belongs to the newer lead, so one email is never counted for two leads (law 3, D-73).

/** A send logged up to this long before the notification still counts (D-08: clock skew). */
export const CONFIRMED_SEND_SKEW_MS = 60 * 1000;

/** The contact properties the signals need, and the only ones the follow-up read requests (PLAN §9.5 step 3). */
export const SIGNAL_CONTACT_PROPERTIES = [
  'email',
  'hs_additional_emails',
  'hs_email_optout',
  'hs_email_bad_address',
  'hs_email_hard_bounce_reason_enum',
  'hs_sales_email_last_replied',
  'hs_merged_object_ids',
] as const satisfies readonly HubSpotContactProperty[];

/** The contact's properties as HubSpot returns them (`null` for empty ones). */
export type ContactProperties = Partial<Record<HubSpotContactProperty, string | null>>;

/** One logged email's metadata (structurally the HubSpot port's EmailEngagement). */
export interface SignalEmail {
  readonly timestamp: Date;
  readonly direction: EmailDirection | null;
  /** `hs_email_status`; absent when HubSpot has none. */
  readonly status?: string | undefined;
  readonly fromEmail?: string | undefined;
  readonly toEmails: readonly string[];
}

const REPLY_DIRECTIONS: ReadonlySet<EmailDirection> = new Set<EmailDirection>(['INCOMING_EMAIL', 'FORWARDED_EMAIL']);

/** One address, trimmed and lower-cased (`Name <a@b>` keeps the part in brackets); null when empty or not an address. */
export function normalizeAddress(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const bracketed = /<([^<>]*)>\s*$/.exec(raw);
  const address = (bracketed?.[1] ?? raw).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+$/.test(address) ? address : null;
}

/** The addresses in a `;`- or `,`-separated HubSpot value (hs_additional_emails). */
export function splitAddresses(value: string | null | undefined): string[] {
  if (typeof value !== 'string') return [];
  return value.split(/[;,]/).flatMap((part) => {
    const address = normalizeAddress(part);
    return address === null ? [] : [address];
  });
}

/** The lead's addresses: the contact's email, its additional emails and any `extra` (the submitted address). */
export function leadAddresses(properties: ContactProperties, extra: readonly (string | null | undefined)[] = []): ReadonlySet<string> {
  const addresses = new Set<string>();
  for (const raw of [properties.email, ...extra]) {
    const address = normalizeAddress(raw);
    if (address !== null) addresses.add(address);
  }
  for (const address of splitAddresses(properties.hs_additional_emails)) addresses.add(address);
  return addresses;
}

function isTrue(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

/** D-09's contact stops from the properties (`deleted` is the read's 404, never a property). */
export function contactStopFacts(properties: ContactProperties): ContactStopFacts {
  const bounceReason = properties.hs_email_hard_bounce_reason_enum;
  return {
    deleted: false,
    optedOut: isTrue(properties.hs_email_optout),
    bounced: (typeof bounceReason === 'string' && bounceReason.trim().length > 0) || isTrue(properties.hs_email_bad_address),
  };
}

function earliest(current: Date | null, candidate: Date): Date {
  return current === null || candidate.getTime() < current.getTime() ? candidate : current;
}

function isSentStatus(status: string | undefined): boolean {
  if (status === undefined) return true;
  const value = status.trim().toUpperCase();
  return value.length === 0 || value === 'SENT';
}

function isBouncedStatus(status: string | undefined): boolean {
  return status !== undefined && status.trim().toUpperCase() === 'BOUNCED';
}

/** True when `at` is before the end of the lead's window (none: open-ended). */
function beforeUntil(at: Date, until: Date | null): boolean {
  return until === null || at.getTime() < until.getTime();
}

function toLead(email: SignalEmail, addresses: ReadonlySet<string>): boolean {
  return email.toEmails.some((to) => addresses.has(normalizeAddress(to) ?? ''));
}

/** The earliest confirmed send to the lead (HS-CONFIRMED-SEND) before `until`, or null. */
export function confirmedSendAt(emails: readonly SignalEmail[], addresses: ReadonlySet<string>, firstNotifiedAt: Date, until: Date | null = null): Date | null {
  const since = firstNotifiedAt.getTime() - CONFIRMED_SEND_SKEW_MS;
  let found: Date | null = null;
  for (const email of emails) {
    if (email.direction !== 'EMAIL' || !isSentStatus(email.status)) continue;
    if (email.timestamp.getTime() < since || !beforeUntil(email.timestamp, until)) continue;
    if (!toLead(email, addresses)) continue;
    found = earliest(found, email.timestamp);
  }
  return found;
}

/** The earliest EMAIL to the lead that bounced (status BOUNCED) in the lead's window, or null. */
export function bouncedSendAt(emails: readonly SignalEmail[], addresses: ReadonlySet<string>, firstNotifiedAt: Date, until: Date | null = null): Date | null {
  const since = firstNotifiedAt.getTime() - CONFIRMED_SEND_SKEW_MS;
  let found: Date | null = null;
  for (const email of emails) {
    if (email.direction !== 'EMAIL' || !isBouncedStatus(email.status)) continue;
    if (email.timestamp.getTime() < since || !beforeUntil(email.timestamp, until)) continue;
    if (!toLead(email, addresses)) continue;
    found = earliest(found, email.timestamp);
  }
  return found;
}

/** A reply must be strictly after this: GREATEST(first_notified_at, replies_ignored_before) (D-08, D-42). */
export function replyThreshold(firstNotifiedAt: Date, repliesIgnoredBefore: Date | null): Date {
  return repliesIgnoredBefore !== null && repliesIgnoredBefore.getTime() > firstNotifiedAt.getTime() ? repliesIgnoredBefore : firstNotifiedAt;
}

/** The earliest logged reply from the lead strictly after `after` and before `until` (HS-REPLY-SIGNAL primary rule), or null. */
export function engagementReplyAt(emails: readonly SignalEmail[], addresses: ReadonlySet<string>, after: Date, until: Date | null = null): Date | null {
  let found: Date | null = null;
  for (const email of emails) {
    if (email.direction === null || !REPLY_DIRECTIONS.has(email.direction)) continue;
    if (email.timestamp.getTime() <= after.getTime() || !beforeUntil(email.timestamp, until)) continue;
    const from = normalizeAddress(email.fromEmail);
    if (from === null || !addresses.has(from)) continue;
    found = earliest(found, email.timestamp);
  }
  return found;
}

/** A HubSpot datetime property: an ISO 8601 instant or epoch milliseconds; null when unusable. */
export function parseHubSpotInstant(value: string | null | undefined): Date | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0) return null;
  const ms = /^\d{1,15}$/.test(text) ? Number(text) : Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** The positive-only fallback (`hs_sales_email_last_replied` strictly after `after`, before `until`), or null. */
export function fallbackReplyAt(properties: ContactProperties, after: Date, until: Date | null = null): Date | null {
  const at = parseHubSpotInstant(properties.hs_sales_email_last_replied);
  return at !== null && at.getTime() > after.getTime() && beforeUntil(at, until) ? at : null;
}

/** The contact ids a merge folded into this record (`hs_merged_object_ids`, `;`-separated); digits only. */
export function mergedContactIds(properties: ContactProperties): string[] {
  const value = properties.hs_merged_object_ids;
  if (typeof value !== 'string') return [];
  return [...new Set(value.split(/[;,]/).map((id) => id.trim()).filter((id) => /^\d{1,20}$/.test(id)))];
}

export interface SignalsInput {
  readonly properties: ContactProperties;
  /** The contact's logged emails (metadata only); empty when they could not be read. */
  readonly emails: readonly SignalEmail[];
  /** T0: when the owner was first emailed about the lead. */
  readonly firstNotifiedAt: Date;
  readonly repliesIgnoredBefore: Date | null;
  /** More of the lead's addresses: the one it submitted, while stored. */
  readonly extraAddresses?: readonly (string | null | undefined)[] | undefined;
  /**
   * The end of the lead's window: when the owner was first emailed about a newer lead of the same
   * contact (null: none). Sends, replies and bounces from then on belong to that lead.
   */
  readonly until?: Date | null | undefined;
}

export type ReplySource = 'engagement' | 'last_replied_property';

export interface Signals {
  readonly confirmedSendAt: Date | null;
  readonly replyAt: Date | null;
  readonly replySource: ReplySource | null;
  /** D-09 (deleted is always false here: a 404 has no properties); `bounced` also covers a send that bounced. */
  readonly contact: ContactStopFacts;
  /** The earliest send to the lead that bounced (status BOUNCED), or null. */
  readonly bouncedSendAt: Date | null;
}

/** PLAN §9.5 step 4's facts, from one contact read. */
export function evaluateSignals(input: SignalsInput): Signals {
  const addresses = leadAddresses(input.properties, input.extraAddresses ?? []);
  const until = input.until ?? null;
  const after = replyThreshold(input.firstNotifiedAt, input.repliesIgnoredBefore);
  const engagement = engagementReplyAt(input.emails, addresses, after, until);
  const fallback = engagement === null ? fallbackReplyAt(input.properties, after, until) : null;
  const bounced = bouncedSendAt(input.emails, addresses, input.firstNotifiedAt, until);
  const contact = contactStopFacts(input.properties);
  return {
    confirmedSendAt: confirmedSendAt(input.emails, addresses, input.firstNotifiedAt, until),
    replyAt: engagement ?? fallback,
    replySource: engagement !== null ? 'engagement' : fallback !== null ? 'last_replied_property' : null,
    contact: bounced === null ? contact : { ...contact, bounced: true },
    bouncedSendAt: bounced,
  };
}
