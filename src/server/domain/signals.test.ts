import { describe, expect, it } from 'vitest';
import {
  CONFIRMED_SEND_SKEW_MS,
  confirmedSendAt,
  contactStopFacts,
  engagementReplyAt,
  evaluateSignals,
  fallbackReplyAt,
  leadAddresses,
  mergedContactIds,
  normalizeAddress,
  parseHubSpotInstant,
  replyThreshold,
  SIGNAL_CONTACT_PROPERTIES,
  splitAddresses,
  type ContactProperties,
  type SignalEmail,
} from './signals';

// D-08's confirmed-send and reply rules, the positive-only fallback and D-09's contact stops, from
// email metadata and contact properties only (HS-CONFIRMED-SEND, HS-REPLY-SIGNAL,
// HS-CONTACT-ACTIVITY-PROPS, HS-OPTOUT, HS-BOUNCE-BADADDRESS).

const T0 = new Date('2026-10-06T14:05:00.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const LEAD = 'maya@okafor-bakery.example';
const OTHER = 'm.okafor@gmail.example';
const OWNER = 'dana@brightside-plumbing.example';

function at(ms: number): Date {
  return new Date(T0.getTime() + ms);
}

function send(partial: Partial<SignalEmail> = {}): SignalEmail {
  return { timestamp: at(10 * MINUTE), direction: 'EMAIL', status: 'SENT', fromEmail: OWNER, toEmails: [LEAD], ...partial };
}

function reply(partial: Partial<SignalEmail> = {}): SignalEmail {
  return { timestamp: at(2 * HOUR), direction: 'INCOMING_EMAIL', fromEmail: LEAD, toEmails: [OWNER], ...partial };
}

const CONTACT: ContactProperties = { email: LEAD, hs_additional_emails: null };
const ADDRESSES = leadAddresses(CONTACT);

describe('the lead\'s addresses', () => {
  it('are the contact email, every additional email and the submitted address, trimmed and lower-cased', () => {
    const addresses = leadAddresses(
      { email: ' Maya@Okafor-Bakery.example ', hs_additional_emails: 'M.Okafor@Gmail.example;maya.o@work.example , extra@x.example' },
      ['Submitted@Form.example', null, undefined, ''],
    );
    expect([...addresses].sort()).toEqual(
      ['extra@x.example', 'm.okafor@gmail.example', 'maya.o@work.example', 'maya@okafor-bakery.example', 'submitted@form.example'].sort(),
    );
  });

  it('ignores empty values and anything that is not an address', () => {
    expect(splitAddresses(';; ,not an address; @; a@; @b; a@b@c')).toEqual([]);
    expect(normalizeAddress('  ')).toBeNull();
    expect(normalizeAddress('no-at-sign')).toBeNull();
    expect(normalizeAddress('Maya Okafor <Maya@Okafor-Bakery.example>')).toBe(LEAD);
    expect(leadAddresses({}).size).toBe(0);
  });
});

describe('confirmed send (EMAIL to the lead after the notification)', () => {
  it('is the earliest qualifying EMAIL\'s HubSpot time', () => {
    expect(confirmedSendAt([send({ timestamp: at(3 * HOUR) }), send({ timestamp: at(12 * MINUTE) }), send()], ADDRESSES, T0)).toEqual(at(10 * MINUTE));
  });

  it('matches the recipient exactly and case-insensitively, among several recipients', () => {
    expect(confirmedSendAt([send({ toEmails: ['someone@else.example', 'MAYA@OKAFOR-BAKERY.EXAMPLE'] })], ADDRESSES, T0)).toEqual(at(10 * MINUTE));
    expect(confirmedSendAt([send({ toEmails: ['xmaya@okafor-bakery.example'] })], ADDRESSES, T0)).toBeNull();
    expect(confirmedSendAt([send({ toEmails: ['maya@okafor-bakery.example.evil'] })], ADDRESSES, T0)).toBeNull();
    expect(confirmedSendAt([send({ toEmails: ['maya'] })], ADDRESSES, T0)).toBeNull();
  });

  it('counts a send to one of the contact\'s additional emails', () => {
    const addresses = leadAddresses({ email: LEAD, hs_additional_emails: `${OTHER};maya.o@work.example` });
    expect(confirmedSendAt([send({ toEmails: ['M.Okafor@Gmail.example'] })], addresses, T0)).toEqual(at(10 * MINUTE));
    expect(confirmedSendAt([send({ toEmails: [OTHER] })], ADDRESSES, T0)).toBeNull();
  });

  it('never counts an email where the lead was only CC\'d (not among the recipients) or a colleague\'s thread', () => {
    expect(confirmedSendAt([send({ toEmails: ['colleague@brightside-plumbing.example'] })], ADDRESSES, T0)).toBeNull();
    expect(confirmedSendAt([send({ toEmails: [] })], ADDRESSES, T0)).toBeNull();
  });

  it('needs the status absent or SENT: bounced, failed, scheduled and sending emails are not sends', () => {
    expect(confirmedSendAt([send({ status: undefined })], ADDRESSES, T0)).toEqual(at(10 * MINUTE));
    expect(confirmedSendAt([send({ status: 'sent' })], ADDRESSES, T0)).toEqual(at(10 * MINUTE));
    expect(confirmedSendAt([send({ status: ' ' })], ADDRESSES, T0)).toEqual(at(10 * MINUTE));
    for (const status of ['BOUNCED', 'FAILED', 'SCHEDULED', 'SENDING', 'SOMETHING_NEW']) {
      expect(confirmedSendAt([send({ status })], ADDRESSES, T0)).toBeNull();
    }
  });

  it('needs direction EMAIL: inbound and unknown directions are not sends', () => {
    for (const direction of ['INCOMING_EMAIL', 'FORWARDED_EMAIL', null] as const) {
      expect(confirmedSendAt([send({ direction })], ADDRESSES, T0)).toBeNull();
    }
  });

  it('accepts a send logged up to 60 s before the notification (clock skew), not earlier', () => {
    expect(CONFIRMED_SEND_SKEW_MS).toBe(60 * SECOND);
    expect(confirmedSendAt([send({ timestamp: at(-60 * SECOND) })], ADDRESSES, T0)).toEqual(at(-60 * SECOND));
    expect(confirmedSendAt([send({ timestamp: at(-60 * SECOND - 1) })], ADDRESSES, T0)).toBeNull();
    expect(confirmedSendAt([send({ timestamp: at(-2 * HOUR) })], ADDRESSES, T0)).toBeNull();
  });
});

describe('reply (INCOMING_EMAIL or FORWARDED_EMAIL from the lead)', () => {
  it('is the earliest reply from one of the lead\'s addresses, either direction', () => {
    const emails = [reply({ timestamp: at(5 * HOUR) }), reply({ direction: 'FORWARDED_EMAIL', timestamp: at(3 * HOUR) })];
    expect(engagementReplyAt(emails, ADDRESSES, T0)).toEqual(at(3 * HOUR));
  });

  it('matches the sender exactly and case-insensitively, additional emails included', () => {
    const addresses = leadAddresses({ email: LEAD, hs_additional_emails: OTHER });
    expect(engagementReplyAt([reply({ fromEmail: 'MAYA@Okafor-Bakery.Example' })], ADDRESSES, T0)).toEqual(at(2 * HOUR));
    expect(engagementReplyAt([reply({ fromEmail: 'M.OKAFOR@gmail.example' })], addresses, T0)).toEqual(at(2 * HOUR));
    expect(engagementReplyAt([reply({ fromEmail: 'M.OKAFOR@gmail.example' })], ADDRESSES, T0)).toBeNull();
  });

  it('never counts a third party\'s email on the contact, an email without a sender, or the owner\'s own EMAIL', () => {
    expect(engagementReplyAt([reply({ fromEmail: 'boss@okafor-bakery.example' })], ADDRESSES, T0)).toBeNull();
    expect(engagementReplyAt([reply({ fromEmail: undefined })], ADDRESSES, T0)).toBeNull();
    expect(engagementReplyAt([reply({ direction: 'EMAIL' })], ADDRESSES, T0)).toBeNull();
    expect(engagementReplyAt([reply({ direction: null })], ADDRESSES, T0)).toBeNull();
  });

  it('must be strictly after the notification (no skew allowance)', () => {
    expect(engagementReplyAt([reply({ timestamp: T0 })], ADDRESSES, T0)).toBeNull();
    expect(engagementReplyAt([reply({ timestamp: at(-30 * SECOND) })], ADDRESSES, T0)).toBeNull();
    expect(engagementReplyAt([reply({ timestamp: at(1) })], ADDRESSES, T0)).toEqual(at(1));
  });

  it('ignores replies up to replies_ignored_before (after "Resume follow-ups"): GREATEST of the two times', () => {
    const resumed = at(26 * HOUR);
    expect(replyThreshold(T0, null)).toEqual(T0);
    expect(replyThreshold(T0, resumed)).toEqual(resumed);
    expect(replyThreshold(T0, at(-HOUR))).toEqual(T0);
    const outOfOffice = reply({ timestamp: at(25 * HOUR) });
    const realReply = reply({ timestamp: at(30 * HOUR) });
    const threshold = replyThreshold(T0, resumed);
    expect(engagementReplyAt([outOfOffice], ADDRESSES, threshold)).toBeNull();
    expect(engagementReplyAt([reply({ timestamp: resumed })], ADDRESSES, threshold)).toBeNull();
    expect(engagementReplyAt([outOfOffice, realReply], ADDRESSES, threshold)).toEqual(at(30 * HOUR));
  });
});

describe('hs_sales_email_last_replied: a positive-only fallback', () => {
  it('reads ISO and epoch-millisecond values, and nothing else', () => {
    expect(parseHubSpotInstant('2026-10-06T16:05:00.000Z')).toEqual(at(2 * HOUR));
    expect(parseHubSpotInstant(String(at(2 * HOUR).getTime()))).toEqual(at(2 * HOUR));
    expect(parseHubSpotInstant('')).toBeNull();
    expect(parseHubSpotInstant('yesterday')).toBeNull();
    expect(parseHubSpotInstant(null)).toBeNull();
  });

  it('counts only when strictly after the same threshold as engagements', () => {
    expect(fallbackReplyAt({ hs_sales_email_last_replied: at(2 * HOUR).toISOString() }, T0)).toEqual(at(2 * HOUR));
    expect(fallbackReplyAt({ hs_sales_email_last_replied: T0.toISOString() }, T0)).toBeNull();
    expect(fallbackReplyAt({ hs_sales_email_last_replied: at(-HOUR).toISOString() }, T0)).toBeNull();
    expect(fallbackReplyAt({ hs_sales_email_last_replied: null }, T0)).toBeNull();
  });

  it('is used only when no engagement shows a reply, and never clears anything', () => {
    const properties: ContactProperties = { ...CONTACT, hs_sales_email_last_replied: at(5 * HOUR).toISOString() };
    const fromProperty = evaluateSignals({ properties, emails: [], firstNotifiedAt: T0, repliesIgnoredBefore: null });
    expect(fromProperty).toMatchObject({ replyAt: at(5 * HOUR), replySource: 'last_replied_property' });

    const fromEngagement = evaluateSignals({ properties, emails: [reply({ timestamp: at(7 * HOUR) })], firstNotifiedAt: T0, repliesIgnoredBefore: null });
    expect(fromEngagement).toMatchObject({ replyAt: at(7 * HOUR), replySource: 'engagement' });

    const older = evaluateSignals({
      properties: { ...CONTACT, hs_sales_email_last_replied: at(-HOUR).toISOString() },
      emails: [],
      firstNotifiedAt: T0,
      repliesIgnoredBefore: null,
    });
    expect(older).toMatchObject({ replyAt: null, replySource: null });

    const beforeResume = evaluateSignals({ properties, emails: [], firstNotifiedAt: T0, repliesIgnoredBefore: at(6 * HOUR) });
    expect(beforeResume).toMatchObject({ replyAt: null, replySource: null });
  });

  it('is the only activity property read: the others are not even requested', () => {
    expect(SIGNAL_CONTACT_PROPERTIES).toEqual([
      'email',
      'hs_additional_emails',
      'hs_email_optout',
      'hs_email_bad_address',
      'hs_email_hard_bounce_reason_enum',
      'hs_sales_email_last_replied',
      'hs_merged_object_ids',
    ]);
    for (const name of ['notes_last_contacted', 'hs_last_sales_activity_timestamp', 'num_contacted_notes', 'hs_email_last_reply_date']) {
      expect(SIGNAL_CONTACT_PROPERTIES as readonly string[]).not.toContain(name);
    }
  });
});

describe('contact stops (D-09)', () => {
  it('opts out on hs_email_optout == "true" only', () => {
    expect(contactStopFacts({ hs_email_optout: 'true' }).optedOut).toBe(true);
    expect(contactStopFacts({ hs_email_optout: ' TRUE ' }).optedOut).toBe(true);
    for (const value of ['false', '', null, 'yes', '1']) {
      expect(contactStopFacts({ hs_email_optout: value }).optedOut).toBe(false);
    }
    expect(contactStopFacts({}).optedOut).toBe(false);
  });

  it('bounces on any hard-bounce reason or hs_email_bad_address == "true"', () => {
    expect(contactStopFacts({ hs_email_hard_bounce_reason_enum: 'UNKNOWN_USER' }).bounced).toBe(true);
    expect(contactStopFacts({ hs_email_hard_bounce_reason_enum: 'SOMETHING_UNDOCUMENTED' }).bounced).toBe(true);
    expect(contactStopFacts({ hs_email_bad_address: 'true' }).bounced).toBe(true);
    expect(contactStopFacts({ hs_email_hard_bounce_reason_enum: '  ', hs_email_bad_address: 'false' }).bounced).toBe(false);
    expect(contactStopFacts({ hs_email_hard_bounce_reason_enum: null, hs_email_bad_address: null }).bounced).toBe(false);
  });

  it('never reports a deletion from properties (only a 404 means deleted)', () => {
    expect(contactStopFacts({ hs_email_optout: 'true', hs_email_bad_address: 'true' })).toEqual({ deleted: false, optedOut: true, bounced: true });
  });
});

describe('evaluateSignals', () => {
  it('combines the send, the reply and the contact stops from one read', () => {
    const signals = evaluateSignals({
      properties: { email: LEAD, hs_additional_emails: OTHER, hs_email_optout: 'true' },
      emails: [
        send({ toEmails: [OTHER], timestamp: at(9 * MINUTE) }),
        send({ status: 'BOUNCED', timestamp: at(MINUTE) }),
        reply({ fromEmail: 'stranger@example.net', timestamp: at(HOUR) }),
        reply({ timestamp: at(4 * HOUR) }),
      ],
      firstNotifiedAt: T0,
      repliesIgnoredBefore: null,
    });
    expect(signals).toEqual({
      confirmedSendAt: at(9 * MINUTE),
      replyAt: at(4 * HOUR),
      replySource: 'engagement',
      // The send that bounced is not a send, but it is a bounce (D-73).
      contact: { deleted: false, optedOut: true, bounced: true },
      bouncedSendAt: at(MINUTE),
    });
  });

  it('uses the submitted address too while it is stored', () => {
    const signals = evaluateSignals({
      properties: { email: 'changed@okafor-bakery.example' },
      emails: [send(), reply()],
      firstNotifiedAt: T0,
      repliesIgnoredBefore: null,
      extraAddresses: [LEAD],
    });
    expect(signals).toMatchObject({ confirmedSendAt: at(10 * MINUTE), replyAt: at(2 * HOUR) });
  });

  it('confirms nothing from no data: "not enough data", never an estimate', () => {
    expect(evaluateSignals({ properties: CONTACT, emails: [], firstNotifiedAt: T0, repliesIgnoredBefore: null })).toEqual({
      confirmedSendAt: null,
      replyAt: null,
      replySource: null,
      contact: { deleted: false, optedOut: false, bounced: false },
      bouncedSendAt: null,
    });
  });

  it('a send to the lead that bounced after the notification is a bounce stop; an older one, a failed one or one to someone else is not', () => {
    const bounced = (emails: SignalEmail[]) => evaluateSignals({ properties: CONTACT, emails, firstNotifiedAt: T0, repliesIgnoredBefore: null });
    expect(bounced([send({ status: 'BOUNCED', timestamp: at(HOUR) })])).toMatchObject({ confirmedSendAt: null, contact: { bounced: true }, bouncedSendAt: at(HOUR) });
    expect(bounced([send({ status: ' bounced ', timestamp: at(-30 * SECOND) })])).toMatchObject({ contact: { bounced: true } });
    expect(bounced([send({ status: 'BOUNCED', timestamp: at(-2 * MINUTE) })])).toMatchObject({ contact: { bounced: false }, bouncedSendAt: null });
    expect(bounced([send({ status: 'FAILED', timestamp: at(HOUR) })])).toMatchObject({ contact: { bounced: false }, bouncedSendAt: null });
    expect(bounced([send({ status: 'BOUNCED', toEmails: ['colleague@okafor-bakery.example'], timestamp: at(HOUR) })])).toMatchObject({
      contact: { bounced: false },
    });
    expect(bounced([reply({ status: 'BOUNCED' })])).toMatchObject({ contact: { bounced: false } });
  });
});

describe('one contact, two leads (D-44 window, D-73)', () => {
  // Lead A was notified at T0; a newer lead B of the same contact was notified at T0 + 1 day.
  const UNTIL = at(24 * HOUR);
  const window = (emails: SignalEmail[], until: Date | null, properties: ContactProperties = CONTACT) =>
    evaluateSignals({ properties, emails, firstNotifiedAt: T0, repliesIgnoredBefore: null, until });

  it('a send, a reply and a bounce after the owner was emailed about the newer lead belong to that lead, never to both', () => {
    const forB = [send({ timestamp: at(25 * HOUR) }), reply({ timestamp: at(26 * HOUR) }), send({ status: 'BOUNCED', timestamp: at(27 * HOUR) })];
    expect(window(forB, UNTIL)).toMatchObject({ confirmedSendAt: null, replyAt: null, contact: { bounced: false }, bouncedSendAt: null });
    // Lead B's own window (from its notification, open-ended) has them all.
    expect(evaluateSignals({ properties: CONTACT, emails: forB, firstNotifiedAt: UNTIL, repliesIgnoredBefore: null })).toMatchObject({
      confirmedSendAt: at(25 * HOUR),
      replyAt: at(26 * HOUR),
      contact: { bounced: true },
    });
  });

  it('keeps what happened in the older lead\'s own window', () => {
    const emails = [send({ timestamp: at(HOUR) }), reply({ timestamp: at(2 * HOUR) }), send({ timestamp: at(25 * HOUR) }), reply({ timestamp: at(26 * HOUR) })];
    expect(window(emails, UNTIL)).toMatchObject({ confirmedSendAt: at(HOUR), replyAt: at(2 * HOUR) });
    // At the bound itself the email is the newer lead's.
    expect(window([send({ timestamp: UNTIL })], UNTIL)).toMatchObject({ confirmedSendAt: null });
  });

  it('the fallback property only counts inside the window too', () => {
    expect(window([], UNTIL, { ...CONTACT, hs_sales_email_last_replied: at(30 * HOUR).toISOString() })).toMatchObject({ replyAt: null });
    expect(window([], UNTIL, { ...CONTACT, hs_sales_email_last_replied: at(3 * HOUR).toISOString() })).toMatchObject({
      replyAt: at(3 * HOUR),
      replySource: 'last_replied_property',
    });
  });
});

describe('merged contact ids', () => {
  it('reads the ids a merge folded into the record (digits only, deduplicated)', () => {
    expect(mergedContactIds({ hs_merged_object_ids: '101;102; 103;101' })).toEqual(['101', '102', '103']);
    expect(mergedContactIds({ hs_merged_object_ids: 'abc;;' })).toEqual([]);
    expect(mergedContactIds({ hs_merged_object_ids: null })).toEqual([]);
    expect(mergedContactIds({})).toEqual([]);
  });
});
