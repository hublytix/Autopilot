import { describe, expect, it } from 'vitest';
import portalJson from '../../../../../test/fixtures/hubspot-portal.json';
import { stateFromFixture } from './state';

// The simulation portal must match PLAN §13 exactly: the baseline figures are asserted downstream.

const state = stateFromFixture(portalJson);
const HOUR = 60 * 60 * 1000;

describe('test/fixtures/hubspot-portal.json', () => {
  it('describes portal 1234567 in America/New_York on app.hubspot.com, installed by the owner', () => {
    expect(state.portal).toMatchObject({
      portalId: '1234567',
      timeZone: 'America/New_York',
      uiDomain: 'app.hubspot.com',
      hubDomain: 'brightside-plumbing.example',
      installerEmail: 'owner@brightside-plumbing.example',
      ownerTestAddress: 'owner.personal@example.net',
    });
    expect(state.portal.grantedScopes).toEqual(['oauth', 'crm.objects.contacts.read', 'forms', 'sales-email-read']);
    expect(state.mailboxes).toEqual({ 'owner@brightside-plumbing.example': 'log_all' });
  });

  it('has the three forms, with an email-only subscriber newsletter form', () => {
    expect(state.forms.map((f) => [f.name, f.formType, f.archived])).toEqual([
      ['Contact us', 'hubspot', false],
      ['Request a quote', 'hubspot', false],
      ['Newsletter signup', 'hubspot', false],
    ]);
    for (const name of ['Contact us', 'Request a quote']) {
      const form = state.forms.find((f) => f.name === name);
      expect(form?.fields.map((f) => f.name)).toEqual(['firstname', 'lastname', 'email', 'company', 'message']);
    }
    const newsletter = state.forms.find((f) => f.name === 'Newsletter signup');
    expect(newsletter?.fields.map((f) => f.name)).toEqual(['email']);
    expect(newsletter?.lifecycleStages).toEqual(['subscriber']);
  });

  it('has five baseline contacts, each with one submission between 2026-09-10 and 2026-09-30', () => {
    expect(state.contacts).toHaveLength(5);
    expect(state.submissions).toHaveLength(5);
    const from = Date.parse('2026-09-10T00:00:00Z');
    const to = Date.parse('2026-10-01T00:00:00Z');
    const submitters = state.submissions.map((s) => {
      expect(s.submittedAtMs).toBeGreaterThanOrEqual(from);
      expect(s.submittedAtMs).toBeLessThan(to);
      return s.values.find((v) => v.name === 'email')?.value;
    });
    expect(new Set(submitters)).toEqual(new Set(state.contacts.map((c) => c.properties.email)));
  });

  it('gives four leads a logged outbound email after 30 m, 2 h, 5 h and 26 h, and one none (median 3 h 30 m, 20%)', () => {
    const gaps = state.contacts.map((contact) => {
      const submission = state.submissions.find((s) => s.values.some((v) => v.name === 'email' && v.value === contact.properties.email));
      const firstOutbound = state.emails
        .filter((e) => e.direction === 'EMAIL' && e.contactIds.includes(contact.id) && e.toEmails.includes(contact.properties.email ?? ''))
        .map((e) => e.timestampMs)
        .sort((a, b) => a - b)[0];
      return firstOutbound === undefined || submission === undefined ? null : firstOutbound - submission.submittedAtMs;
    });
    const answered = gaps.filter((g): g is number => g !== null).sort((a, b) => a - b);
    expect(answered).toEqual([0.5 * HOUR, 2 * HOUR, 5 * HOUR, 26 * HOUR]);
    expect(gaps.filter((g) => g === null)).toHaveLength(1);
    const median = ((answered[1] ?? 0) + (answered[2] ?? 0)) / 2;
    expect(median).toBe(3.5 * HOUR);
    expect(gaps.filter((g) => g === null).length / gaps.length).toBe(0.2);
  });

  it('keeps every address on reserved example domains', () => {
    const addresses = [
      state.portal.installerEmail,
      state.portal.ownerTestAddress,
      ...state.contacts.map((c) => c.properties.email),
      ...state.emails.flatMap((e) => [e.fromEmail, ...e.toEmails]),
    ];
    for (const address of addresses) expect(address).toMatch(/@[a-z-]+\.example$|@example\.(com|org|net)$/);
  });
});
