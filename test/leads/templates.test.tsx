import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { BUTTON_LABELS } from '@/emails/components/ActionButtons';
import { draftFlagLine, draftFlagLines } from '@/emails/components/DraftFlags';
import { FIRST_SEND_UNCONFIRMED_NOTE, followUpNotes, initialLoggingNote, REPLIES_NOT_LOGGED_NOTE } from '@/emails/components/HonestNotes';
import { NOT_MONITORED_LINE } from '@/emails/components/NotMonitored';
import { FollowUp, followUpSubject } from '@/emails/FollowUp';
import { NeedsTouch, needsTouchReasonText, needsTouchSubject, type NeedsTouchWhy } from '@/emails/NeedsTouch';
import { NewLead } from '@/emails/NewLead';
import { ReplyDetected, replyDetectedSubject } from '@/emails/ReplyDetected';
import { NOT_ENOUGH_DATA, WeeklyReport, weeklyReportSubject } from '@/emails/WeeklyReport';
import { renderEmail } from '@/server/email/render';
import { needsTouchWhyOf } from '@/server/services/leads/process';
import { hubspotContactRecordUrl } from '@/server/services/leads/record-link';
import { formatReplyTime } from '@/server/services/leads/reply-detected-notification';
import { actionLinks } from './support';

// The lead email templates (brief §5.5, §5.6, PLAN §9.3 step 6, §9.5, D-13, D-27, D-34, D-47): what the
// owner reads, in the HTML and plain-text parts. Presentational: the services pass cleaned text.

const URLS = {
  sendUrl: 'http://localhost:3000/a/apt_send/send',
  editUrl: 'http://localhost:3000/a/apt_edit/edit',
  dismissUrl: 'http://localhost:3000/a/apt_dismiss/dismiss',
  mailtoUrl: 'http://localhost:3000/a/apt_send/send?via=mailto',
};

const BASE = {
  productName: 'Hublytix Autopilot',
  firstName: 'Maya',
  lead: { name: 'Maya Okafor', company: 'Okafor Bakery', email: 'maya[@]okafor-bakery[.]example' },
  message: 'Our sink leaks.\nSee hxxps://okafor-bakery[.]example/sink',
  draftSubject: 'Your leaking sink',
  draftBody: 'Hi Maya,\n\nThanks for getting in touch.\n\nDana',
  loggingMode: 'log_all' as const,
  ...URLS,
};

describe('NewLead', () => {
  it('opens with the not-monitored line and carries the card, the unverified message, the draft, three buttons and the mailto link', async () => {
    const { html, text } = await renderEmail(createElement(NewLead, BASE));
    expect(text).toContain(NOT_MONITORED_LINE);
    expect(text.indexOf(NOT_MONITORED_LINE)).toBeLessThan(text.indexOf('NEW LEAD: MAYA'));
    expect(text).toContain('Name: Maya Okafor');
    expect(text).toContain('Company: Okafor Bakery');
    expect(text).toContain('Email: maya[@]okafor-bakery[.]example');
    expect(text).toContain('Message from the lead (unverified)');
    expect(text).toContain('Our sink leaks.\nSee hxxps://okafor-bakery[.]example/sink');
    expect(text).toContain('Subject: Your leaking sink');
    expect(text).toContain('Hi Maya,\n\nThanks for getting in touch.\n\nDana');
    expect(actionLinks(html)).toEqual([URLS.sendUrl, URLS.editUrl, URLS.dismissUrl, URLS.mailtoUrl]);
    for (const label of Object.values(BUTTON_LABELS)) expect(text).toContain(label);
    expect(text).toContain('Open in default mail app');
    expect(html).not.toMatch(/<img/i);
    // log_all: nothing to warn about.
    expect(text).not.toMatch(/isn't logging|haven't confirmed|logs the emails you send/);
  });

  it('escapes whatever the lead typed', async () => {
    const { html } = await renderEmail(createElement(NewLead, { ...BASE, message: '<script>alert(1)</script><a href="x">click</a>', lead: { ...BASE.lead, name: '<b>Bold</b>' } }));
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<a href="x">');
    expect(html).not.toContain('<b>Bold</b>');
    expect(html).toContain('&lt;script&gt;');
  });

  it.each([
    ['sends_only', "HubSpot logs the emails you send but not the replies you get"],
    ['none', "HubSpot isn't logging your emails, so we can't confirm that you sent this reply"],
    ['unknown', "We haven't confirmed that HubSpot logs your emails"],
  ] as const)('with logging mode %s says plainly what cannot be confirmed', async (mode, sentence) => {
    const { text } = await renderEmail(createElement(NewLead, { ...BASE, loggingMode: mode }));
    expect(text).toContain(sentence);
    expect(initialLoggingNote(mode)).toContain(sentence);
  });

  it('works without a name, company, address or message', async () => {
    const { text } = await renderEmail(createElement(NewLead, { ...BASE, firstName: null, lead: { name: null, company: null, email: null }, message: null }));
    expect(text).toContain('NEW LEAD\n');
    expect(text).toContain('Name: Not given');
    expect(text).not.toContain('Company:');
    expect(text).toContain('Email: Not given');
    expect(text).toContain('The form had no message.');
  });
});

describe('draft flags in plain words (no codes, law 5)', () => {
  const FLAGS = ['asks_pricing', 'urgent', 'non_english', 'missing_info', 'possible_spam', 'sensitive_topic', 'other'] as const;

  it('words every flag without its code, and the pricing flag by the brief', () => {
    for (const flag of FLAGS) {
      for (const allowPricing of [false, true]) {
        const line = draftFlagLine(flag, { allowPricing });
        // No code: no underscore, and a two-word code never appears run together ("asks pricing", "non english").
        expect(line).not.toContain('_');
        if (flag.includes('_')) expect(line.toLowerCase()).not.toContain(flag.replace('_', ' '));
      }
    }
    expect(draftFlagLine('asks_pricing', { allowPricing: false })).toBe("The lead asked about prices. Your business details say not to quote them, so the draft doesn't.");
    expect(draftFlagLine('asks_pricing', { allowPricing: true })).toBe('The lead asked about prices. Check any prices in the draft before you send it.');
    expect(draftFlagLine('urgent', { allowPricing: false })).toBe('The message may be urgent.');
    expect(draftFlagLine('possible_spam', { allowPricing: false })).toBe(`This may not be a genuine enquiry. If it isn't, tap "${BUTTON_LABELS.dismiss}".`);
    expect(draftFlagLines(['urgent', 'urgent', 'asks_pricing'], { allowPricing: false })).toHaveLength(2);
  });

  it('the new_lead and needs-touch emails show one line per flag under "Worth knowing", and nothing without flags', async () => {
    const flagged = await renderEmail(createElement(NewLead, { ...BASE, flags: ['asks_pricing', 'urgent'], allowPricing: false }));
    expect(flagged.text).toContain('Worth knowing');
    expect(flagged.text).toContain("The lead asked about prices. Your business details say not to quote them, so the draft doesn't.");
    expect(flagged.text).toContain('The message may be urgent.');
    expect(flagged.text).not.toContain('_pricing');
    expect(flagged.text.indexOf('Worth knowing')).toBeLessThan(flagged.text.indexOf('Subject: Your leaking sink'));

    const touched = await renderEmail(createElement(NeedsTouch, { ...BASE, why: 'failed', starterReply: false, flags: ['sensitive_topic'] }));
    expect(touched.text).toContain('The message touches on something sensitive. Read the draft closely before you send it.');

    const plain = await renderEmail(createElement(NewLead, BASE));
    expect(plain.text).not.toContain('Worth knowing');
  });
});

describe('NeedsTouch', () => {
  it('has the card, the starter reply, why in plain words, and the same buttons', async () => {
    const { html, text } = await renderEmail(createElement(NeedsTouch, { ...BASE, why: 'checks', starterReply: true }));
    expect(text).toContain(NOT_MONITORED_LINE);
    expect(text).toContain("The draft of your reply didn't pass our checks, so we haven't used it.");
    expect(text).toContain("So we've written a short starter version of your reply instead.");
    expect(text).toContain('Your starter reply (needs your touch)');
    expect(text).toContain('Name: Maya Okafor');
    expect(text).toContain('Message from the lead (unverified)');
    expect(actionLinks(html)).toEqual([URLS.sendUrl, URLS.editUrl, URLS.dismissUrl, URLS.mailtoUrl]);
  });

  it('maps every drafting reason to owner wording without codes', () => {
    const reasons = ['refusal', 'validation_failed', 'invalid_output', 'max_tokens', 'fatal_config', 'ai_budget', 'transient', 'job_failed', 'no_brief', 'earlier_attempt'] as const;
    const whys = new Set<NeedsTouchWhy>(reasons.map(needsTouchWhyOf));
    expect([...whys].sort()).toEqual(['checks', 'declined', 'failed', 'no_brief', 'unavailable', 'unknown']);
    for (const why of whys) expect(needsTouchReasonText(why)).not.toMatch(/_|refusal|validation|fatal|budget|transient/);
  });

  it('subjects use the safe first name, else none', () => {
    expect(needsTouchSubject('Maya')).toBe('New lead: Maya — your reply needs your touch');
    expect(needsTouchSubject(null)).toBe('New lead — your reply needs your touch');
  });
});

describe('FollowUp', () => {
  it('states D-34’s honest notes, the follow-up draft and the three buttons', async () => {
    const { html, text } = await renderEmail(
      createElement(FollowUp, { ...BASE, n: 1, sendConfirmed: false, loggingMode: 'sends_only', draftSubject: 'Re: Your leaking sink', draftBody: 'Hi Maya,\n\nJust following up.' }),
    );
    expect(text).toContain(NOT_MONITORED_LINE);
    expect(text).toContain("We couldn't confirm in HubSpot that your first reply was sent.");
    expect(text).toContain("HubSpot isn't logging replies for you, so check your inbox before sending.");
    expect(text).toContain('FOLLOW-UP 1 FOR MAYA');
    expect(text).toContain('Subject: Re: Your leaking sink');
    expect(actionLinks(html)).toEqual([URLS.sendUrl, URLS.editUrl, URLS.dismissUrl, URLS.mailtoUrl]);
  });

  it('says nothing extra when HubSpot confirmed the send and logs replies', async () => {
    const { text } = await renderEmail(createElement(FollowUp, { ...BASE, n: 2, sendConfirmed: true, loggingMode: 'log_all' }));
    expect(text).not.toContain(FIRST_SEND_UNCONFIRMED_NOTE);
    expect(text).not.toContain(REPLIES_NOT_LOGGED_NOTE);
    expect(text).toContain('Still no reply from this lead is logged in HubSpot.');
  });

  it('picks the notes from the confirmed send and the logging mode', () => {
    expect(followUpNotes({ sendConfirmed: true, loggingMode: 'log_all' })).toEqual([]);
    expect(followUpNotes({ sendConfirmed: false, loggingMode: 'none' })).toEqual([FIRST_SEND_UNCONFIRMED_NOTE, REPLIES_NOT_LOGGED_NOTE]);
    expect(followUpNotes({ sendConfirmed: true, loggingMode: 'unknown' })).toEqual([
      "We haven't confirmed that HubSpot logs replies for you, so check your inbox before sending.",
    ]);
  });

  it('a starter follow-up says why', async () => {
    const { text } = await renderEmail(createElement(FollowUp, { ...BASE, n: 2, sendConfirmed: true, loggingMode: 'log_all', needsTouch: 'unavailable' }));
    expect(text).toContain('Drafting is unavailable right now. So this is a short starter follow-up.');
  });

  it('subjects', () => {
    expect(followUpSubject(1, 'Maya')).toBe('Follow-up 1 for Maya — your draft is ready');
    expect(followUpSubject(2, null, true)).toBe('Follow-up 2 — your draft needs your touch');
  });
});

describe('ReplyDetected', () => {
  it('"{Name} replied — follow-ups stopped" with the HubSpot record link', async () => {
    const recordUrl = hubspotContactRecordUrl('app-eu1.hubspot.com', '24681357', '1051');
    expect(recordUrl).toBe('https://app-eu1.hubspot.com/contacts/24681357/record/0-1/1051');
    const { html, text } = await renderEmail(
      createElement(ReplyDetected, {
        productName: 'Hublytix Autopilot',
        firstName: 'Maya',
        repliedAtText: formatReplyTime(new Date('2026-10-08T15:20:00.000Z'), 'America/New_York'),
        hubspotRecordUrl: recordUrl,
      }),
    );
    expect(replyDetectedSubject('Maya')).toBe('Maya replied — follow-ups stopped');
    expect(text).toContain("This email isn't monitored. To answer the lead, send your reply from your own mailbox.");
    expect(text).toContain('MAYA REPLIED — FOLLOW-UPS STOPPED');
    expect(text).toContain('HubSpot logged a reply from Maya on Thu 8 Oct, 11:20.');
    expect(html).toContain(`href="${recordUrl}"`);
    expect(actionLinks(html)).toEqual([]);
    // Without the lead page's URL the email promises no "Resume follow-ups" (law 5, D-73); the
    // notification plan passes the lead page (M6), which offers it.
    expect(text).not.toMatch(/resume follow-ups|dashboard/i);
  });

  it('offers "resume follow-ups" only with a page that has it', async () => {
    const { text, html } = await renderEmail(
      createElement(ReplyDetected, { productName: 'P', firstName: 'Maya', repliedAtText: null, hubspotRecordUrl: null, resumeFollowUpsUrl: 'http://localhost:3000/leads/1' }),
    );
    expect(text).toContain('If it was an automatic reply, such as an out-of-office message, you can resume follow-ups');
    expect(html).toContain('href="http://localhost:3000/leads/1"');
  });

  it('works without a name, a time or a usable record', async () => {
    expect(replyDetectedSubject(null)).toBe('Your lead replied — follow-ups stopped');
    const { text } = await renderEmail(
      createElement(ReplyDetected, { productName: 'P', firstName: null, repliedAtText: null, hubspotRecordUrl: null }),
    );
    expect(text).toContain('HubSpot logged a reply from your lead.');
    expect(text).not.toContain('Open the contact in HubSpot');
  });

  it('only ever links to a HubSpot host with numeric ids', () => {
    expect(hubspotContactRecordUrl('evil.example', '1', '2')).toBe('https://app.hubspot.com/contacts/1/record/0-1/2');
    expect(hubspotContactRecordUrl(null, '1', '2')).toBe('https://app.hubspot.com/contacts/1/record/0-1/2');
    expect(hubspotContactRecordUrl('app.hubspot.com', '1', '2/../../x')).toBeNull();
    expect(hubspotContactRecordUrl('app.hubspot.com', 'abc', '2')).toBeNull();
    expect(hubspotContactRecordUrl('app.hubspot.com', '1', null)).toBeNull();
  });
});

describe('WeeklyReport (stub)', () => {
  it('shows "Not enough data" for a missing value and never estimates', async () => {
    const { text } = await renderEmail(
      createElement(WeeklyReport, {
        productName: 'Hublytix Autopilot',
        weekLabel: 'Mon 5 Oct – Sun 11 Oct',
        rows: [
          { label: 'Leads in', value: '6' },
          { label: 'Median time to your first reply (logged in HubSpot)', value: null },
        ],
        dashboardUrl: 'http://localhost:3000/dashboard',
      }),
    );
    expect(weeklyReportSubject('Hublytix Autopilot', 'Mon 5 Oct – Sun 11 Oct')).toBe('Hublytix Autopilot weekly report: Mon 5 Oct – Sun 11 Oct');
    expect(text).toContain('Leads in: 6');
    expect(text).toContain(`Median time to your first reply (logged in HubSpot): ${NOT_ENOUGH_DATA}`);
  });
});
