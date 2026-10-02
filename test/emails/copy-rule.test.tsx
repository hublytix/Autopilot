import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createElement, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { BillingInactive, billingInactiveSubject } from '@/emails/BillingInactive';
import type { DraftFlagCode } from '@/emails/components/DraftFlags';
import { draftFlagLine } from '@/emails/components/DraftFlags';
import { followUpNotes, initialLoggingNote, type LoggingMode } from '@/emails/components/HonestNotes';
import { FollowUp, followUpSubject } from '@/emails/FollowUp';
import { InboxTest, inboxTestSubject } from '@/emails/InboxTest';
import { LeadCapReached, leadCapReachedSubject } from '@/emails/LeadCapReached';
import { MagicLink, magicLinkSubject, type MagicLinkVariant } from '@/emails/MagicLink';
import { NeedsTouch, needsTouchReasonText, needsTouchSubject, type NeedsTouchWhy } from '@/emails/NeedsTouch';
import { NewLead } from '@/emails/NewLead';
import { ReconnectHubSpot, reconnectHubSpotSubject } from '@/emails/ReconnectHubSpot';
import { ReplyDetected, replyDetectedSubject } from '@/emails/ReplyDetected';
import { SettingsChangeAlert, settingsChangeAlertSubject } from '@/emails/SettingsChangeAlert';
import { VerifyNotify, verifyNotifySubject } from '@/emails/VerifyNotify';
import { WEEKLY_REPORT_HONESTY_LINE, WeeklyReport, weeklyReportSubject } from '@/emails/WeeklyReport';
import { newLeadSubject } from '@/server/domain/subject';
import { renderEmail } from '@/server/email/render';
import { EDIT_CROSS_ORIGIN_MESSAGE, EDIT_HINTS, EDIT_INPUT_ERRORS } from '@/server/http/action-links/edit';
import { ACTION_LINK_MESSAGES, neverSendsLine } from '@/server/http/action-links/messages';

// The copy rule (D-37, PLAN §1.2, §12 Domain): an unqualified "reply"/"replied" always means the
// lead's. Every reply the owner sends is qualified with "you", "your" or "from you" ("your reply is
// ready", "Copy your reply"). Checked on the text of every owner email (rendered, every variant), the
// edit page's hints and messages, the action-link page messages, and the visible strings of every
// page under src/app and the action-link HTML.

const PRODUCT = 'Hublytix Autopilot';
const WORD = /\b(?:reply|replies|replied)\b/giu;
const OWNER_WORDS = new Set(['you', 'your', 'yours']);

/** Lead-side phrases: the unqualified word is the lead's reply, as the rule says it must be. */
const LEAD_SIDE: readonly RegExp[] = [
  /\bno (?:logged )?reply from (?:this|the|your) lead\b/giu,
  // "{Name} replied", also upper-cased in a plain-text heading ("MAYA REPLIED").
  /\b(?:\p{Lu}[\p{L}'-]*|lead) (?:replied|REPLIED)\b/gu,
  /\blead replies\b/giu,
  /\breplies from leads\b/giu,
  /\breplies you get\b/giu,
  /\blogged a reply from\b/giu,
  /\blog(?:s|ging)? replies for you\b/giu,
  /\bautomatic reply\b/giu,
];

/** The occurrences of reply/replies/replied in `text` that are neither the owner's (qualified) nor the lead's. */
function unqualified(text: string): string[] {
  const leadSpans: [number, number][] = [];
  for (const pattern of LEAD_SIDE) {
    for (const match of text.matchAll(pattern)) leadSpans.push([match.index, match.index + match[0].length]);
  }
  const problems: string[] = [];
  for (const match of text.matchAll(WORD)) {
    const at = match.index;
    if (leadSpans.some(([from, to]) => at >= from && at < to)) continue;
    // The words of the same clause just before the word: "your reply", "your first reply", "you sent this reply".
    const clause = text.slice(0, at).split(/[.!?;:\n—–(]/u).at(-1) ?? '';
    const before = clause.toLowerCase().match(/[\p{L}']+/gu) ?? [];
    if (before.slice(-3).some((word) => OWNER_WORDS.has(word))) continue;
    if (/^\s+from you\b/iu.test(text.slice(at + match[0].length))) continue;
    problems.push(text.slice(Math.max(0, at - 40), at + match[0].length + 20).replace(/\s+/gu, ' '));
  }
  return problems;
}

describe('the copy rule checker', () => {
  it('accepts owner replies qualified by you/your and lead-side phrases, and catches the rest', () => {
    for (const ok of [
      'New lead: Maya — your reply is ready',
      'Median time to your first reply',
      'we cannot confirm that you sent this reply',
      '% with no logged reply from you',
      'No reply from this lead is logged in HubSpot.',
      'Maya replied — follow-ups stopped',
      'HubSpot logged a reply from Maya.',
      'Replies from leads',
    ]) {
      expect(unqualified(ok), ok).toEqual([]);
    }
    for (const bad of ['Here is the reply we have.', 'a short starter reply', 'open the reply in your mail app', 'for a first reply', 'We draft a reply for each lead']) {
      expect(unqualified(bad), bad).toHaveLength(1);
    }
  });
});

// ── owner emails, rendered ─────────────────────────────────────────────────────────────────────────

const URLS = {
  sendUrl: 'http://localhost:3000/a/apt_send/send',
  editUrl: 'http://localhost:3000/a/apt_edit/edit',
  dismissUrl: 'http://localhost:3000/a/apt_dismiss/dismiss',
  mailtoUrl: 'http://localhost:3000/a/apt_send/send?via=mailto',
};
const LEAD = { name: 'Maya Okafor', company: 'Okafor Bakery', email: 'maya[@]okafor-bakery[.]example' };
const LOGGING_MODES: readonly LoggingMode[] = ['log_all', 'sends_only', 'none', 'unknown'];
const WHYS: readonly NeedsTouchWhy[] = ['declined', 'checks', 'unavailable', 'failed', 'no_brief', 'unknown'];
const FLAGS: readonly DraftFlagCode[] = ['asks_pricing', 'urgent', 'non_english', 'missing_info', 'possible_spam', 'sensitive_topic', 'other'];
const LEAD_EMAIL_BASE = {
  productName: PRODUCT,
  lead: LEAD,
  message: 'Our sink leaks.',
  draftSubject: 'Your leaking sink',
  draftBody: 'Hi Maya,\n\nThanks for getting in touch.\n\nDana',
  ...URLS,
};

function ownerEmails(): [string, ReactElement][] {
  const emails: [string, ReactElement][] = [];
  for (const firstName of ['Maya', null]) {
    for (const loggingMode of LOGGING_MODES) {
      emails.push([`NewLead ${firstName} ${loggingMode}`, createElement(NewLead, { ...LEAD_EMAIL_BASE, firstName, loggingMode, flags: FLAGS })]);
      for (const why of WHYS) {
        for (const starterReply of [true, false]) {
          emails.push([`NeedsTouch ${why} ${starterReply}`, createElement(NeedsTouch, { ...LEAD_EMAIL_BASE, firstName, loggingMode, why, starterReply, flags: FLAGS })]);
        }
      }
      for (const n of [1, 2] as const) {
        for (const sendConfirmed of [true, false]) {
          emails.push([`FollowUp ${n}`, createElement(FollowUp, { ...LEAD_EMAIL_BASE, firstName, loggingMode, n, sendConfirmed })]);
          emails.push([`FollowUp ${n} needs touch`, createElement(FollowUp, { ...LEAD_EMAIL_BASE, firstName, loggingMode, n, sendConfirmed, needsTouch: 'checks' })]);
        }
      }
    }
    emails.push([
      'ReplyDetected',
      createElement(ReplyDetected, { productName: PRODUCT, firstName, repliedAtText: 'Tue 6 Oct, 10:15', hubspotRecordUrl: 'https://app.hubspot.com/contacts/1/record/0-1/2', dashboardUrl: 'http://localhost:3000/dashboard' }),
    ]);
  }
  emails.push([
    'InboxTest',
    createElement(InboxTest, {
      productName: PRODUCT,
      testAddress: 'test+abc@example.com',
      leadMessage: 'Hi, this is a test.',
      draftSubject: 'Your test',
      draftBody: 'Hi there,\n\nThanks.',
      ...URLS,
      checkUrl: 'http://localhost:3000/onboarding/inbox',
    }),
  ]);
  emails.push(['LeadCapReached', createElement(LeadCapReached, { productName: PRODUCT, limit: 50, dashboardUrl: 'http://localhost:3000/dashboard' })]);
  emails.push([
    'WeeklyReport',
    createElement(WeeklyReport, {
      productName: PRODUCT,
      weekLabel: 'Mon 5 Oct – Sun 11 Oct',
      rows: [
        { label: 'Leads in', value: '6' },
        { label: 'Drafts emailed to you', value: '4' },
        { label: 'Your sends confirmed in HubSpot', value: '2' },
        { label: 'Send link opened, not confirmed', value: '1' },
        { label: 'Median time to your first reply (logged in HubSpot)', value: null },
        { label: 'Leads still waiting for your reply (nothing logged in HubSpot)', value: '2' },
        { label: 'Replies from leads', value: '1' },
      ],
      dashboardUrl: 'http://localhost:3000/dashboard',
    }),
  ]);
  emails.push(['BillingInactive', createElement(BillingInactive, { productName: PRODUCT, billingUrl: 'http://localhost:3000/billing' })]);
  emails.push(['ReconnectHubSpot', createElement(ReconnectHubSpot, { productName: PRODUCT, reconnectUrl: 'http://localhost:3000/login', purgeDate: '6 Nov 2026' })]);
  for (const variant of ['sign_in', 'onboarding', 'reconnect'] as const satisfies readonly MagicLinkVariant[]) {
    emails.push([`MagicLink ${variant}`, createElement(MagicLink, { productName: PRODUCT, variant, url: 'http://localhost:3000/auth/confirm#th=x', portal: 'brightside.example (ID 1)' })]);
  }
  emails.push(['VerifyNotify', createElement(VerifyNotify, { productName: PRODUCT, businessName: 'Brightside Plumbing', url: 'http://localhost:3000/v/x', validDays: 7 })]);
  emails.push([
    'SettingsChangeAlert',
    createElement(SettingsChangeAlert, {
      productName: PRODUCT,
      changedOn: 'Tue 6 Oct',
      notifyAddresses: [{ address: 'owner@example.com', confirmed: true }],
      bccAddress: '123@bcc.hubspot.com',
      settingsUrl: 'http://localhost:3000/settings',
    }),
  ]);
  return emails;
}

function subjects(): string[] {
  const out = [newLeadSubject('Maya'), newLeadSubject(null), needsTouchSubject('Maya'), needsTouchSubject(null), replyDetectedSubject('Maya'), replyDetectedSubject(null)];
  for (const n of [1, 2] as const) out.push(followUpSubject(n, 'Maya'), followUpSubject(n, null, true));
  out.push(inboxTestSubject(PRODUCT), leadCapReachedSubject(PRODUCT, 50), weeklyReportSubject(PRODUCT, 'Mon 5 Oct'), billingInactiveSubject(PRODUCT));
  out.push(reconnectHubSpotSubject(PRODUCT), verifyNotifySubject(PRODUCT), settingsChangeAlertSubject(PRODUCT));
  for (const variant of ['sign_in', 'onboarding', 'reconnect'] as const) out.push(magicLinkSubject(variant, PRODUCT));
  return out;
}

describe('the copy rule on owner emails (D-37)', () => {
  it('every subject qualifies the owner\'s reply', () => {
    for (const subject of subjects()) expect(unqualified(subject), subject).toEqual([]);
  });

  it('every owner email\'s text, in every variant, qualifies the owner\'s reply', async () => {
    const problems: string[] = [];
    for (const [name, element] of ownerEmails()) {
      const { text } = await renderEmail(element);
      for (const problem of unqualified(text)) problems.push(`${name}: …${problem}…`);
    }
    expect(problems).toEqual([]);
  });

  it('the plain-words notes (logging, follow-ups, flags, needs-touch reasons) qualify it too', () => {
    const lines = [
      ...LOGGING_MODES.map(initialLoggingNote).filter((note): note is string => note !== null),
      ...LOGGING_MODES.flatMap((loggingMode) => [true, false].flatMap((sendConfirmed) => followUpNotes({ sendConfirmed, loggingMode }))),
      ...FLAGS.flatMap((flag) => [draftFlagLine(flag, { allowPricing: true }), draftFlagLine(flag, { allowPricing: false })]),
      ...WHYS.map(needsTouchReasonText),
      WEEKLY_REPORT_HONESTY_LINE,
    ];
    for (const line of lines) expect(unqualified(line), line).toEqual([]);
  });

  it('the weekly report never says every count comes from HubSpot (some rows are our own records)', async () => {
    const [, element] = ownerEmails().find(([name]) => name === 'WeeklyReport') ?? [];
    if (element === undefined) throw new Error('no weekly report');
    const { text } = await renderEmail(element);
    expect(text).toContain(WEEKLY_REPORT_HONESTY_LINE);
    expect(text).not.toMatch(/HubSpot data only/i);
  });
});

// ── action-link pages and every app page ─────────────────────────────────────────────────────────────

describe('the copy rule on the edit, dismiss and other action-link pages', () => {
  it('edit hints, input errors and page messages qualify the owner\'s reply', () => {
    const lines = [
      ...Object.values(EDIT_HINTS),
      ...Object.values(EDIT_INPUT_ERRORS),
      EDIT_CROSS_ORIGIN_MESSAGE.title,
      ...EDIT_CROSS_ORIGIN_MESSAGE.paragraphs,
      ...Object.values(ACTION_LINK_MESSAGES).flatMap((message) => [message.title, ...message.paragraphs]),
      neverSendsLine(PRODUCT),
    ];
    for (const line of lines) expect(unqualified(line), line).toEqual([]);
  });
});

const ROOT = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

const ENTITIES: Readonly<Record<string, string>> = { '&apos;': "'", '&quot;': '"', '&ldquo;': '"', '&rdquo;': '"', '&amp;': '&', '&nbsp;': ' ' };

/** The visible strings of a source file: string literals (interpolations as "Name") and JSX text; comments dropped. */
function visibleStrings(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/gu, '$1');
  const out: string[] = [];
  for (const match of code.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/gu)) {
    out.push((match[1] ?? match[2] ?? match[3] ?? '').replace(/\$\{[^}]*\}/gu, 'Name'));
  }
  for (const match of code.matchAll(/>([^<>{}]+)</gu)) {
    out.push((match[1] ?? '').replace(/&[a-z]+;/gu, (entity) => ENTITIES[entity] ?? ' '));
  }
  return out;
}

describe('the copy rule on every page (src/app) and the action-link HTML', () => {
  const files = [...sourceFiles(join(ROOT, 'src', 'app')), ...sourceFiles(join(ROOT, 'src', 'server', 'http', 'action-links'))];

  it('scans the pages', () => {
    expect(files.some((file) => file.endsWith(join('a', '[token]', 'edit', 'page.tsx')))).toBe(true);
    expect(files.some((file) => file.endsWith(join('a', '[token]', 'dismiss', 'page.tsx')))).toBe(true);
    expect(files.some((file) => file.endsWith(join('onboarding', 'preferences', 'preferences-form.tsx')))).toBe(true);
  });

  it('no visible string uses an unqualified "reply" for the owner\'s', () => {
    const problems: string[] = [];
    for (const file of files) {
      for (const text of visibleStrings(readFileSync(file, 'utf8'))) {
        for (const problem of unqualified(text)) problems.push(`${relative(ROOT, file)}: …${problem}…`);
      }
    }
    expect(problems).toEqual([]);
  });
});
