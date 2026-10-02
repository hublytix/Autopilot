import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import {
  NOT_ENOUGH_DATA,
  NOT_ENOUGH_LOGGED_HISTORY,
  SENDS_NOT_CONFIRMABLE,
  WEEKLY_REPORT_HONESTY_LINE,
  WEEKLY_REPORT_LABELS,
  WeeklyReport,
  weeklyReportSubject,
} from '@/emails/WeeklyReport';
import type { WeeklyMetrics } from '@/server/domain/weekly-metrics';
import { renderEmail } from '@/server/email/render';
import { formatWait, weekLabelOf, weeklyReportProps } from '@/server/services/reports/present';

// The stored metrics as the email shows them (PLAN §9.8 step 5, D-37): D-37's labels, "Not enough
// data" for a null, the baseline's own "Not enough logged history", times in the report's zone,
// record links (first 20 + "and N more"), the honesty line and the dashboard link.

const PRESENTATION = { productName: 'Hublytix Autopilot', timezone: 'America/New_York', dashboardUrl: 'http://localhost:3000/dashboard' };

const METRICS: WeeklyMetrics = {
  version: 1,
  period: { start: '2026-10-05T12:00:00.000Z', end: '2026-10-12T12:00:00.000Z' },
  basis: { loggingMode: 'log_all', emailScope: true, sendsLogged: true, repliesLogged: true },
  cohort: {
    leadsIn: 6,
    filtered: 2,
    draftsEmailed: 4,
    sendsConfirmed: 3,
    sendLinkOpenedNotConfirmed: 1,
    medianTimeToFirstReply: { seconds: 1260, samples: 3 },
    waiting: { count: 1, leads: [{ leadId: 'lead-2', submittedAt: '2026-10-06T14:05:00.000Z', recordUrl: 'https://app.hubspot.com/contacts/1234567/record/0-1/1002' }], more: 0 },
    unchecked: 0,
  },
  events: { repliesFromLeads: 1, followUpsDrafted: 7 },
  comparison: {
    baseline: 'ok',
    baselineMedianSeconds: 12600,
    baselinePercentWithoutReply: 20,
    medianSeconds: 1260,
    percentWithoutReply: 25,
    population: 4,
    withoutReply: 1,
  },
};

async function text(metrics: WeeklyMetrics): Promise<string> {
  return (await renderEmail(createElement(WeeklyReport, weeklyReportProps(metrics, PRESENTATION)))).text;
}

describe('weeklyReportProps', () => {
  it('lays the PLAN §13 report out with D-37\'s labels, in order', () => {
    const props = weeklyReportProps(METRICS, PRESENTATION);
    expect(props).toEqual({
      productName: 'Hublytix Autopilot',
      weekLabel: 'Mon 5 Oct – Mon 12 Oct',
      periodLine: 'From Mon 5 Oct, 08:00 to Mon 12 Oct, 08:00 (America/New_York).',
      rows: [
        { label: 'Leads in', value: '6' },
        { label: 'Filtered (spam etc.)', value: '2' },
        { label: 'Drafts emailed to you', value: '4' },
        { label: 'Your sends confirmed in HubSpot', value: '3' },
        { label: 'Send link opened, not confirmed', value: '1' },
        { label: 'Median time to your first reply (logged in HubSpot)', value: '21 min' },
      ],
      waiting: { kind: 'list', value: '1', leads: [{ text: 'Lead submitted Tue 6 Oct, 10:05', recordUrl: 'https://app.hubspot.com/contacts/1234567/record/0-1/1002' }], more: 0 },
      unchecked: 0,
      activity: [
        { label: 'Replies from leads', value: '1' },
        { label: 'Follow-ups drafted', value: '7' },
      ],
      comparison: {
        kind: 'rows',
        rows: [
          { label: 'Median time to your first reply (logged in HubSpot)', baseline: '3 h 30 min', thisWeek: '21 min' },
          { label: '% with no logged reply from you', baseline: '20%', thisWeek: '25%' },
        ],
      },
      dashboardUrl: 'http://localhost:3000/dashboard',
    });
    expect(Object.values(WEEKLY_REPORT_LABELS)).toEqual([
      'Leads in',
      'Filtered (spam etc.)',
      'Drafts emailed to you',
      'Your sends confirmed in HubSpot',
      'Send link opened, not confirmed',
      'Median time to your first reply (logged in HubSpot)',
      'Leads still waiting for your reply (nothing logged in HubSpot)',
      'Replies from leads',
      'Follow-ups drafted',
      'Compared with your baseline',
      '% with no logged reply from you',
    ]);
  });

  it('shows a null as "Not enough data" and unconfirmable sends as D-37\'s line instead of the list', async () => {
    const body = await text({
      ...METRICS,
      cohort: { ...METRICS.cohort, sendsConfirmed: null, medianTimeToFirstReply: { seconds: null, samples: 0 }, waiting: null },
      events: { repliesFromLeads: null, followUpsDrafted: 0 },
      comparison: { ...METRICS.comparison, medianSeconds: null, percentWithoutReply: null, baselineMedianSeconds: null },
    });
    expect(body).toContain(`Your sends confirmed in HubSpot: ${NOT_ENOUGH_DATA}`);
    expect(body).toContain(`Median time to your first reply (logged in HubSpot): ${NOT_ENOUGH_DATA}`);
    expect(body).toContain(`Leads still waiting for your reply (nothing logged in HubSpot): ${SENDS_NOT_CONFIRMABLE}.`);
    expect(body).toContain(`Replies from leads: ${NOT_ENOUGH_DATA}`);
    expect(body).toContain('Follow-ups drafted: 0');
    expect(body).toContain(`Baseline: ${NOT_ENOUGH_DATA} · This week: ${NOT_ENOUGH_DATA}`);
    expect(body).toContain(`Baseline: 20% · This week: ${NOT_ENOUGH_DATA}`);
  });

  it.each([
    ['no_logged_email', NOT_ENOUGH_LOGGED_HISTORY],
    ['not_readable', NOT_ENOUGH_LOGGED_HISTORY],
    ['too_many_submissions', NOT_ENOUGH_DATA],
    ['no_leads', NOT_ENOUGH_DATA],
    ['none', NOT_ENOUGH_DATA],
  ] as const)('words a baseline of %s as the onboarding page does: "%s"', async (baseline, words) => {
    const body = await text({ ...METRICS, comparison: { ...METRICS.comparison, baseline, baselineMedianSeconds: null, baselinePercentWithoutReply: null } });
    expect(body).toMatch(new RegExp(`Compared with your baseline\\s+${words}\\s`, 'i'));
    expect(body).not.toContain('Baseline:');
  });

  it("says how many leads couldn't be checked in HubSpot, and only when the email scope is granted", async () => {
    const one = await text({ ...METRICS, cohort: { ...METRICS.cohort, unchecked: 1 } });
    expect(one).toContain("1 lead couldn't be checked in HubSpot this time.");
    const two = await text({ ...METRICS, cohort: { ...METRICS.cohort, unchecked: 2 } });
    expect(two).toContain("2 leads couldn't be checked in HubSpot this time.");
    expect(await text(METRICS)).not.toContain("couldn't be checked");
    const noScope = await text({
      ...METRICS,
      basis: { loggingMode: 'log_all', emailScope: false, sendsLogged: false, repliesLogged: false },
      cohort: { ...METRICS.cohort, waiting: null, unchecked: 4 },
    });
    expect(noScope).not.toContain("couldn't be checked");
    expect(noScope).toContain(SENDS_NOT_CONFIRMABLE);
  });

  it('lists up to 20 waiting leads with record links, says "and N more", and shows a lead without a record as text', async () => {
    const leads = Array.from({ length: 20 }, (_, i) => ({
      leadId: `lead-${i}`,
      submittedAt: new Date(Date.UTC(2026, 9, 6, 14, i)).toISOString(),
      recordUrl: i === 0 ? null : `https://app.hubspot.com/contacts/1234567/record/0-1/${2000 + i}`,
    }));
    const metrics: WeeklyMetrics = { ...METRICS, cohort: { ...METRICS.cohort, waiting: { count: 23, leads, more: 3 } } };
    const { html, text: body } = await renderEmail(createElement(WeeklyReport, weeklyReportProps(metrics, PRESENTATION)));
    expect(body).toContain('Leads still waiting for your reply (nothing logged in HubSpot): 23');
    expect(body).toContain('and 3 more');
    expect(body).toContain('Lead submitted Tue 6 Oct, 10:00\n');
    expect(body).toContain('Lead submitted Tue 6 Oct, 10:19 https://app.hubspot.com/contacts/1234567/record/0-1/2019');
    expect(html.match(/href="https:\/\/app\.hubspot\.com\/contacts\//g)).toHaveLength(19);
  });

  it('writes times in the report\'s own zone', () => {
    expect(weekLabelOf(METRICS, 'Asia/Kolkata')).toBe('Mon 5 Oct – Mon 12 Oct');
    const kolkata = weeklyReportProps({ ...METRICS, period: { start: '2026-10-05T02:30:00.000Z', end: '2026-10-12T02:30:00.000Z' } }, { ...PRESENTATION, timezone: 'Asia/Kolkata' });
    expect(kolkata.periodLine).toBe('From Mon 5 Oct, 08:00 to Mon 12 Oct, 08:00 (Asia/Kolkata).');
    expect(kolkata.waiting).toMatchObject({ leads: [{ text: 'Lead submitted Tue 6 Oct, 19:35' }] });
    const yearEnd = { ...METRICS, period: { start: '2026-12-28T13:00:00.000Z', end: '2027-01-04T13:00:00.000Z' } };
    expect(weekLabelOf(yearEnd, 'America/New_York')).toBe('Mon 28 Dec – Mon 4 Jan');
  });

  it('formats waits in whole minutes', () => {
    expect(formatWait(0)).toBe('under 1 min');
    expect(formatWait(29)).toBe('under 1 min');
    expect(formatWait(13 * 60)).toBe('13 min');
    expect(formatWait(21 * 60 + 20)).toBe('21 min');
    expect(formatWait(3600)).toBe('1 h');
    expect(formatWait(3.5 * 3600)).toBe('3 h 30 min');
    expect(formatWait(23.5 * 3600)).toBe('23 h 30 min');
    expect(formatWait(48 * 3600)).toBe('2 d');
    expect(formatWait(51 * 3600 + 20 * 60)).toBe('2 d 3 h');
  });
});

describe('WeeklyReport email', () => {
  it('is short: the subject, the honesty line and one link to the dashboard', async () => {
    const { html, text: body } = await renderEmail(createElement(WeeklyReport, weeklyReportProps(METRICS, PRESENTATION)));
    expect(weeklyReportSubject('Hublytix Autopilot', 'Mon 5 Oct – Mon 12 Oct')).toBe('Hublytix Autopilot weekly report: Mon 5 Oct – Mon 12 Oct');
    expect(body).toContain(WEEKLY_REPORT_HONESTY_LINE);
    expect(body).toContain('Open your dashboard http://localhost:3000/dashboard');
    expect(html.match(/href="http:\/\/localhost:3000\/dashboard"/g)).toHaveLength(1);
    expect(html).toContain('name="viewport"');
    expect(body).toContain('it never sends email on your behalf');
  });
});
