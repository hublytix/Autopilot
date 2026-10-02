import { describe, expect, it } from 'vitest';
import { parseEnv } from '@/server/env';
import type { FormSubmission } from '@/server/ports';
import {
  emailHmac,
  fillFromContact,
  isTestAddressSubmission,
  parseWebhookBody,
  submissionContent,
  submissionKey,
  webhookDedupeKey,
} from '@/server/services/intake';

// Submission mapping (D-31), keys (D-05, D-31), the test-address window (D-14) and the webhook body
// schema (HS-WH-PAYLOAD): pure parts of intake.

const env = parseEnv({ APP_MODE: 'fake' });
const submittedAt = new Date('2026-10-06T14:05:00.000Z');

function submission(values: FormSubmission['values'], conversionId?: string): FormSubmission {
  return { submittedAt, values, conversionId };
}

describe('submission mapping', () => {
  it('reads contact fields only, trimmed, with empty values missing and the email lower-cased', () => {
    const content = submissionContent(
      submission([
        { name: 'email', value: '  Nina.Patel@Example.COM ', objectTypeId: '0-1' },
        { name: 'firstname', value: '   ', objectTypeId: '0-1' },
        { name: 'company', value: 'Patel Dental', objectTypeId: '0-2' },
        { name: 'message', value: ' Leaking chair line. ' },
      ]),
    );
    expect(content).toEqual({ email: 'nina.patel@example.com', firstName: null, lastName: null, company: null, message: 'Leaking chair line.' });
  });

  it('fills each missing field from the same-named contact property, never overriding a submitted one', () => {
    const filled = fillFromContact(
      { email: 'nina.patel@example.com', firstName: null, lastName: 'Patel', company: null, message: 'Hello' },
      { id: '9', properties: { firstname: 'Nina', lastname: 'Other', company: ' ', message: 'Old message', email: 'x@example.com' } },
    );
    expect(filled).toEqual({ email: 'nina.patel@example.com', firstName: 'Nina', lastName: 'Patel', company: null, message: 'Hello' });
  });

  it('keys a submission by its conversionId, else by an HMAC of form, time and email', () => {
    expect(submissionKey(env, 'form-1', submission([], 'conv-1'), 'a@example.com')).toBe('conv-1');
    const key = submissionKey(env, 'form-1', submission([]), 'a@example.com');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(submissionKey(env, 'form-1', submission([]), 'a@example.com')).toBe(key);
    expect(submissionKey(env, 'form-2', submission([]), 'a@example.com')).not.toBe(key);
    expect(key).not.toContain('example');
  });

  it('skips a test address only from 1 h before to 24 h after the check was created, whatever the case', () => {
    const createdAt = new Date('2026-10-06T12:00:00.000Z');
    const windows = [{ addressHmac: emailHmac(env, 'Owner.Personal@example.net'), createdAt }];
    const hmac = emailHmac(env, 'owner.personal@EXAMPLE.net');
    const hour = 3_600_000;
    expect(isTestAddressSubmission(windows, hmac, new Date(createdAt.getTime() - hour))).toBe(true);
    expect(isTestAddressSubmission(windows, hmac, new Date(createdAt.getTime() - hour - 1))).toBe(false);
    expect(isTestAddressSubmission(windows, hmac, new Date(createdAt.getTime() + 24 * hour - 1))).toBe(true);
    expect(isTestAddressSubmission(windows, hmac, new Date(createdAt.getTime() + 24 * hour))).toBe(false);
    expect(isTestAddressSubmission(windows, emailHmac(env, 'someone@example.net'), createdAt)).toBe(false);
  });
});

describe('webhook body', () => {
  const event = {
    eventId: 1,
    subscriptionId: 12345,
    portalId: 62515,
    occurredAt: 1564113600000,
    subscriptionType: 'contact.creation',
    attemptNumber: 0,
    objectId: 123,
    changeSource: 'CRM',
    changeFlag: 'NEW',
    appId: 54321,
  };

  it('parses HubSpot events (ids as strings) and drops malformed entries one by one', () => {
    const parsed = parseWebhookBody([event, { ...event, objectId: 'abc' }, { ...event, subscriptionType: 'has spaces' }]);
    expect(parsed?.malformed).toBe(2);
    expect(parsed?.events).toEqual([expect.objectContaining({ portalId: '62515', appId: '54321', objectId: '123', eventId: '1' })]);
    const [first] = parsed?.events ?? [];
    if (first === undefined) throw new Error('no event');
    expect(webhookDedupeKey(first)).toBe('62515:contact.creation:123:1:1564113600000');
  });

  it('refuses anything but an array of at most 100 entries', () => {
    expect(parseWebhookBody({ events: [] })).toBeNull();
    expect(parseWebhookBody(Array.from({ length: 101 }, () => event))).toBeNull();
    expect(parseWebhookBody(Array.from({ length: 100 }, () => event))?.events).toHaveLength(100);
  });
});
