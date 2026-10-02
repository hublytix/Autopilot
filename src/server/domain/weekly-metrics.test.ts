import { describe, expect, it } from 'vitest';
import { EMAIL_READ_SCOPE, REQUIRED_SCOPES } from '@/server/hubspot/scopes';
import type { LoggingMode } from './types';
import {
  computeWeeklyMetrics,
  EMAIL_SCOPE,
  MAX_WAITING_LISTED,
  medianOf,
  parseWeeklyMetrics,
  wholePercent,
  type WeeklyMetricsBaseline,
  type WeeklyMetricsLead,
  type WeeklyMetricsPeriod,
} from './weekly-metrics';

// PLAN §9.8 step 4, §13 (the Monday expected metrics), D-37, D-38.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (iso: string): Date => new Date(iso);

// [Mon 2026-10-05 08:00, Mon 2026-10-12 08:00) America/New_York (EDT, UTC−4).
const PERIOD: WeeklyMetricsPeriod = { start: at('2026-10-05T12:00:00Z'), end: at('2026-10-12T12:00:00Z') };
const SCOPES = [...REQUIRED_SCOPES];
const RECORD = (contactId: string | null): string | null => (contactId === null ? null : `https://app.hubspot.com/contacts/1234567/record/0-1/${contactId}`);
const BASELINE: WeeklyMetricsBaseline = {
  status: 'ok',
  submissionsRead: 9,
  leadsCounted: 5,
  medianSecondsToFirstOutbound: 3.5 * 3600,
  withoutOutboundCount: 1,
  percentAvailable: true,
};

function lead(id: string, fields: Partial<WeeklyMetricsLead> = {}): WeeklyMetricsLead {
  return {
    id,
    isTest: false,
    hubspotContactId: `10${id.replace(/\D/g, '')}`,
    submittedAt: at('2026-10-06T14:00:00Z'),
    classification: 'lead',
    classificationOverride: null,
    processRev: 0,
    stopReason: null,
    firstNotifiedAt: null,
    firstSendClickedAt: null,
    sendConfirmedAt: null,
    repliedAt: null,
    dismissedAt: null,
    fu1NotifiedAt: null,
    fu2NotifiedAt: null,
    ...fields,
  };
}

/** The PLAN §13 calendar: Day 0 Tue 10-06 (local), Day 1 Wed, Day 2 Thu fu1 ×4, Day 3 Fri #6 replies, Day 5 Sun fu2 ×3. */
function simulationLeads(): WeeklyMetricsLead[] {
  const local = (day: number, hhmm: string): Date => {
    const [h, m] = hhmm.split(':').map(Number);
    return new Date(Date.UTC(2026, 9, day, (h ?? 0) + 4, m ?? 0));
  };
  return [
    lead('#1', {
      submittedAt: local(6, '10:00'),
      firstNotifiedAt: local(6, '10:01'),
      firstSendClickedAt: local(6, '10:12'),
      sendConfirmedAt: local(6, '10:13'),
      fu1NotifiedAt: local(8, '10:01'),
      fu2NotifiedAt: local(11, '10:01'),
    }),
    lead('#2', {
      submittedAt: local(6, '10:05'),
      classification: 'unclear',
      firstNotifiedAt: local(6, '10:06'),
      firstSendClickedAt: local(6, '10:30'),
      fu1NotifiedAt: local(8, '10:06'),
      fu2NotifiedAt: local(11, '10:06'),
    }),
    lead('#3', { submittedAt: local(6, '10:10'), classification: 'spam' }),
    lead('#4', { submittedAt: local(6, '10:15'), classification: 'vendor_pitch' }),
    lead('#6', {
      submittedAt: local(6, '10:20'),
      firstNotifiedAt: local(6, '10:21'),
      firstSendClickedAt: local(6, '10:40'),
      sendConfirmedAt: local(6, '10:41'),
      fu1NotifiedAt: local(8, '10:21'),
      repliedAt: local(9, '14:00'),
      stopReason: 'replied',
    }),
    lead('#5', {
      submittedAt: local(6, '10:31'),
      firstNotifiedAt: local(6, '10:36'),
      sendConfirmedAt: local(7, '10:01'),
      fu1NotifiedAt: local(8, '10:36'),
      fu2NotifiedAt: local(11, '10:36'),
    }),
    // The onboarding test lead: never in a list or a metric.
    lead('test', {
      isTest: true,
      hubspotContactId: null,
      submittedAt: local(6, '09:03'),
      firstNotifiedAt: local(6, '09:03'),
      firstSendClickedAt: local(6, '09:03'),
      sendConfirmedAt: local(6, '09:04'),
      repliedAt: local(6, '09:05'),
      stopReason: 'test_lead',
    }),
  ];
}

describe('computeWeeklyMetrics: the PLAN §13 Monday report', () => {
  it('matches the expected metrics exactly', () => {
    const metrics = computeWeeklyMetrics(simulationLeads(), BASELINE, 'log_all', SCOPES, PERIOD, RECORD);
    expect(metrics).toEqual({
      version: 1,
      period: { start: '2026-10-05T12:00:00.000Z', end: '2026-10-12T12:00:00.000Z' },
      basis: { loggingMode: 'log_all', emailScope: true, sendsLogged: true, repliesLogged: true },
      cohort: {
        leadsIn: 6,
        filtered: 2,
        draftsEmailed: 4,
        // #1, #5, #6
        sendsConfirmed: 3,
        // #2
        sendLinkOpenedNotConfirmed: 1,
        // 13 m, 21 m, 23 h 30 m
        medianTimeToFirstReply: { seconds: 21 * 60, samples: 3 },
        waiting: {
          count: 1,
          leads: [{ leadId: '#2', submittedAt: '2026-10-06T14:05:00.000Z', recordUrl: 'https://app.hubspot.com/contacts/1234567/record/0-1/102' }],
          more: 0,
        },
        unchecked: 0,
      },
      events: { repliesFromLeads: 1, followUpsDrafted: 7 },
      comparison: {
        baseline: 'ok',
        baselineMedianSeconds: 3.5 * 3600,
        baselinePercentWithoutReply: 20,
        medianSeconds: 21 * 60,
        // 1 of #1, #2, #5, #6
        percentWithoutReply: 25,
        population: 4,
        withoutReply: 1,
      },
    });
    expect(parseWeeklyMetrics(JSON.parse(JSON.stringify(metrics)))).toEqual(metrics);
  });
});

describe('computeWeeklyMetrics: cohort and events', () => {
  it('takes the cohort by submission in the half-open period and the events by their own time', () => {
    const rows = [
      lead('start', { submittedAt: PERIOD.start }),
      lead('before', { submittedAt: new Date(PERIOD.start.getTime() - 1), repliedAt: PERIOD.start, fu2NotifiedAt: new Date(PERIOD.end.getTime() - 1) }),
      lead('end', { submittedAt: PERIOD.end, repliedAt: PERIOD.end, fu1NotifiedAt: PERIOD.end }),
    ];
    const metrics = computeWeeklyMetrics(rows, BASELINE, 'log_all', SCOPES, PERIOD, RECORD);
    expect(metrics.cohort.leadsIn).toBe(1);
    expect(metrics.events).toEqual({ repliesFromLeads: 1, followUpsDrafted: 1 });
  });

  it('counts a send confirmed after the period end as not confirmed, and the lead as still waiting', () => {
    const rows = [
      lead('late', { firstNotifiedAt: at('2026-10-06T14:01:00Z'), firstSendClickedAt: at('2026-10-06T14:05:00Z'), sendConfirmedAt: PERIOD.end }),
    ];
    const metrics = computeWeeklyMetrics(rows, BASELINE, 'log_all', SCOPES, PERIOD, RECORD);
    expect(metrics.cohort.sendsConfirmed).toBe(0);
    expect(metrics.cohort.sendLinkOpenedNotConfirmed).toBe(1);
    expect(metrics.cohort.waiting?.count).toBe(1);
    expect(metrics.comparison).toMatchObject({ population: 1, withoutReply: 1, percentWithoutReply: 100 });
  });

  it('counts a filtered lead only while not overridden, and puts an overridden one in the comparison population', () => {
    const rows = [
      lead('spam', { classification: 'spam' }),
      lead('override', { classification: 'spam', classificationOverride: 'lead', processRev: 1, firstNotifiedAt: at('2026-10-06T15:00:00Z') }),
      lead('rev only', { classification: 'job_seeker', processRev: 1 }),
      lead('unclassified', { classification: null }),
    ];
    const metrics = computeWeeklyMetrics(rows, BASELINE, 'log_all', SCOPES, PERIOD, RECORD);
    expect(metrics.cohort.leadsIn).toBe(4);
    expect(metrics.cohort.filtered).toBe(1);
    expect(metrics.comparison).toMatchObject({ population: 2, withoutReply: 2 });
  });

  it('reads classification_override alone as the owner\'s "This is a real lead" (process_rev still 0)', () => {
    const rows = [lead('override only', { classification: 'spam', classificationOverride: 'lead', processRev: 0 })];
    const metrics = computeWeeklyMetrics(rows, BASELINE, 'log_all', SCOPES, PERIOD, RECORD);
    expect(metrics.cohort.filtered).toBe(0);
    expect(metrics.comparison).toMatchObject({ population: 1, withoutReply: 1 });
  });

  it('orders waiting leads submitted at the same instant by id', () => {
    const same = at('2026-10-06T14:00:00Z');
    const rows = ['c', 'a', 'b'].map((id) => lead(id, { submittedAt: same, firstNotifiedAt: at('2026-10-06T14:01:00Z') }));
    const metrics = computeWeeklyMetrics(rows, BASELINE, 'log_all', SCOPES, PERIOD, RECORD);
    expect(metrics.cohort.waiting?.leads.map((entry) => entry.leadId)).toEqual(['a', 'b', 'c']);
  });

  it('leaves dismissed leads out of the waiting list and the comparison population, but not out of the counts', () => {
    const rows = [
      lead('dismissed', { firstNotifiedAt: at('2026-10-06T14:01:00Z'), dismissedAt: at('2026-10-06T15:00:00Z') }),
      lead('waiting', { firstNotifiedAt: at('2026-10-06T14:01:00Z') }),
    ];
    const metrics = computeWeeklyMetrics(rows, BASELINE, 'log_all', SCOPES, PERIOD, RECORD);
    expect(metrics.cohort.draftsEmailed).toBe(2);
    expect(metrics.cohort.waiting?.leads.map((entry) => entry.leadId)).toEqual(['waiting']);
    expect(metrics.comparison).toMatchObject({ population: 1, withoutReply: 1 });
  });

  it('leaves a lead whose contact asked HubSpot for deletion out of the waiting count and the comparison population, but not out of the counts', () => {
    // It can no longer be checked (no record, never refreshed): neither "waiting" nor "no logged reply from you" is claimed.
    const rows = [
      lead('gone', { firstNotifiedAt: at('2026-10-06T14:01:00Z'), stopReason: 'privacy_deletion' }),
      lead('gone-confirmed', { firstNotifiedAt: at('2026-10-06T14:01:00Z'), sendConfirmedAt: at('2026-10-06T14:05:00Z'), stopReason: 'privacy_deletion' }),
    ];
    const metrics = computeWeeklyMetrics(rows, BASELINE, 'log_all', SCOPES, PERIOD, RECORD);
    expect(metrics.cohort).toMatchObject({ leadsIn: 2, draftsEmailed: 2, sendsConfirmed: 1 });
    expect(metrics.cohort.waiting).toEqual({ count: 0, leads: [], more: 0 });
    expect(metrics.comparison).toMatchObject({ population: 0, withoutReply: 0, percentWithoutReply: null });
  });

  it('lists the oldest waiting leads first, at most 20 with record links, and says how many more', () => {
    const rows = Array.from({ length: 23 }, (_, i) =>
      lead(`w${String(i).padStart(2, '0')}`, {
        hubspotContactId: i === 0 ? null : String(500 + i),
        submittedAt: new Date(PERIOD.start.getTime() + (23 - i) * HOUR),
        firstNotifiedAt: new Date(PERIOD.start.getTime() + (23 - i) * HOUR + MINUTE),
      }),
    );
    const metrics = computeWeeklyMetrics(rows, BASELINE, 'log_all', SCOPES, PERIOD, RECORD);
    const waiting = metrics.cohort.waiting;
    expect(waiting?.count).toBe(23);
    expect(waiting?.more).toBe(3);
    expect(waiting?.leads).toHaveLength(MAX_WAITING_LISTED);
    expect(waiting?.leads[0]).toEqual({ leadId: 'w22', submittedAt: new Date(PERIOD.start.getTime() + HOUR).toISOString(), recordUrl: RECORD('522') });
    expect(waiting?.leads.map((entry) => entry.leadId)).not.toContain('w00');
    expect(parseWeeklyMetrics(JSON.parse(JSON.stringify(metrics)))).toEqual(metrics);
  });
});

describe('computeWeeklyMetrics: the median', () => {
  const confirmedAfter = (id: string, minutes: number): WeeklyMetricsLead =>
    lead(id, { firstNotifiedAt: at('2026-10-06T14:01:00Z'), sendConfirmedAt: new Date(at('2026-10-06T14:00:00Z').getTime() + minutes * MINUTE) });

  it('needs at least 3 confirmed sends', () => {
    const two = computeWeeklyMetrics([confirmedAfter('a', 10), confirmedAfter('b', 20)], BASELINE, 'log_all', SCOPES, PERIOD, RECORD);
    expect(two.cohort.medianTimeToFirstReply).toEqual({ seconds: null, samples: 2 });
    expect(two.comparison.medianSeconds).toBeNull();
  });

  it('takes the mean of the two middle values for an even count', () => {
    const four = computeWeeklyMetrics(
      [confirmedAfter('a', 10), confirmedAfter('b', 20), confirmedAfter('c', 40), confirmedAfter('d', 600)],
      BASELINE,
      'log_all',
      SCOPES,
      PERIOD,
      RECORD,
    );
    expect(four.cohort.medianTimeToFirstReply).toEqual({ seconds: 30 * 60, samples: 4 });
  });

  it('is pure arithmetic over its inputs', () => {
    expect(medianOf([])).toBeNull();
    expect(medianOf([5])).toBe(5);
    expect(medianOf([9, 1, 5])).toBe(5);
    expect(medianOf([4, 1, 3, 2])).toBe(2.5);
    expect(wholePercent(1, 4)).toBe(25);
    expect(wholePercent(1, 3)).toBe(33);
    expect(wholePercent(0, 0)).toBeNull();
  });

  it('says 0% or 100% only when exactly none or all are counted (never overstates near the ends)', () => {
    expect(wholePercent(0, 201)).toBe(0);
    expect(wholePercent(1, 201)).toBe(1);
    expect(wholePercent(1, 1000)).toBe(1);
    expect(wholePercent(199, 200)).toBe(99);
    expect(wholePercent(200, 201)).toBe(99);
    expect(wholePercent(999, 1000)).toBe(99);
    expect(wholePercent(200, 200)).toBe(100);
    expect(wholePercent(3, 3)).toBe(100);
  });

  it('measures waits in whole seconds (rounded) and never below 0', () => {
    const rows = [
      lead('a', { firstNotifiedAt: at('2026-10-06T14:01:00Z'), sendConfirmedAt: new Date(at('2026-10-06T14:00:00Z').getTime() + 1500) }),
      lead('b', { firstNotifiedAt: at('2026-10-06T14:01:00Z'), sendConfirmedAt: new Date(at('2026-10-06T14:00:00Z').getTime() - 90_000) }),
      lead('c', { firstNotifiedAt: at('2026-10-06T14:01:00Z'), sendConfirmedAt: new Date(at('2026-10-06T14:00:00Z').getTime() + 2400) }),
    ];
    // 2 s (1.5 rounds up), 0 s (a send logged before the submission: clamped), 2 s (2.4 rounds down).
    const metrics = computeWeeklyMetrics(rows, BASELINE, 'log_all', SCOPES, PERIOD, RECORD);
    expect(metrics.cohort.medianTimeToFirstReply).toEqual({ seconds: 2, samples: 3 });
    const clamped = computeWeeklyMetrics([rows[1] as WeeklyMetricsLead, rows[1] as WeeklyMetricsLead, rows[1] as WeeklyMetricsLead].map((row, i) => ({ ...row, id: `b${i}` })), BASELINE, 'log_all', SCOPES, PERIOD, RECORD);
    expect(clamped.cohort.medianTimeToFirstReply).toEqual({ seconds: 0, samples: 3 });
  });

  it('compares the baseline with the median over the comparison population, not the whole cohort', () => {
    // A vendor pitch answered in 2 min and a dismissed "unclear" lead answered in 1 min: in the cohort
    // median, never in the comparison (D-37's population, D-38's "same population").
    const rows = [
      confirmedAfter('a', 30),
      confirmedAfter('b', 40),
      confirmedAfter('c', 50),
      lead('pitch', { classification: 'vendor_pitch', sendConfirmedAt: new Date(at('2026-10-06T14:00:00Z').getTime() + 2 * MINUTE) }),
      lead('dismissed', {
        classification: 'unclear',
        firstNotifiedAt: at('2026-10-06T14:00:30Z'),
        sendConfirmedAt: new Date(at('2026-10-06T14:00:00Z').getTime() + MINUTE),
        dismissedAt: at('2026-10-06T15:00:00Z'),
      }),
    ];
    const metrics = computeWeeklyMetrics(rows, BASELINE, 'log_all', SCOPES, PERIOD, RECORD);
    // Cohort: 1, 2, 30, 40, 50 min → 30 min.
    expect(metrics.cohort.medianTimeToFirstReply).toEqual({ seconds: 30 * 60, samples: 5 });
    // Population a, b, c: 40 min.
    expect(metrics.comparison).toMatchObject({ medianSeconds: 40 * 60, population: 3, withoutReply: 0, percentWithoutReply: 0 });
  });

  it('needs 3 confirmed sends in the comparison population for its median', () => {
    const rows = [confirmedAfter('a', 30), confirmedAfter('b', 40), { ...confirmedAfter('c', 50), dismissedAt: at('2026-10-07T14:00:00Z') }];
    const metrics = computeWeeklyMetrics(rows, BASELINE, 'log_all', SCOPES, PERIOD, RECORD);
    expect(metrics.cohort.medianTimeToFirstReply).toEqual({ seconds: 40 * 60, samples: 3 });
    expect(metrics.comparison.medianSeconds).toBeNull();
  });
});

describe('computeWeeklyMetrics: nothing after the period end changes the numbers', () => {
  const afterEnd = new Date(PERIOD.end.getTime() + 1000);

  it('ignores a notification, a click, a confirmed send and a dismissal one second after the end', () => {
    const rows = [
      lead('notified late', { firstNotifiedAt: afterEnd }),
      lead('clicked late', { firstNotifiedAt: at('2026-10-06T14:01:00Z'), firstSendClickedAt: afterEnd }),
      lead('dismissed late', { firstNotifiedAt: at('2026-10-06T14:01:00Z'), dismissedAt: afterEnd }),
      lead('confirmed late', { firstNotifiedAt: at('2026-10-06T14:01:00Z'), sendConfirmedAt: afterEnd }),
    ];
    const metrics = computeWeeklyMetrics(rows, BASELINE, 'log_all', SCOPES, PERIOD, RECORD);
    expect(metrics.cohort).toMatchObject({ leadsIn: 4, draftsEmailed: 3, sendsConfirmed: 0, sendLinkOpenedNotConfirmed: 0 });
    // Dismissed after the end: still waiting at the end, and in the population.
    expect(metrics.cohort.waiting?.leads.map((entry) => entry.leadId)).toEqual(['clicked late', 'confirmed late', 'dismissed late']);
    expect(metrics.comparison).toMatchObject({ population: 4, withoutReply: 4, percentWithoutReply: 100 });
  });

  it('counts the same events one second before the end', () => {
    const beforeEnd = new Date(PERIOD.end.getTime() - 1000);
    const rows = [
      lead('notified', { firstNotifiedAt: beforeEnd }),
      lead('clicked', { firstNotifiedAt: at('2026-10-06T14:01:00Z'), firstSendClickedAt: beforeEnd }),
      lead('dismissed', { firstNotifiedAt: at('2026-10-06T14:01:00Z'), dismissedAt: beforeEnd }),
    ];
    const metrics = computeWeeklyMetrics(rows, BASELINE, 'log_all', SCOPES, PERIOD, RECORD);
    expect(metrics.cohort).toMatchObject({ draftsEmailed: 3, sendLinkOpenedNotConfirmed: 1 });
    expect(metrics.cohort.waiting?.leads.map((entry) => entry.leadId)).toEqual(['clicked', 'notified']);
    expect(metrics.comparison).toMatchObject({ population: 2, withoutReply: 2 });
  });
});

describe('computeWeeklyMetrics: leads the refresh could not read in full', () => {
  const notified = (id: string, fields: Partial<WeeklyMetricsLead> = {}): WeeklyMetricsLead => lead(id, { firstNotifiedAt: at('2026-10-06T14:01:00Z'), ...fields });

  it('never lists or counts an unchecked lead as waiting, counts it, and makes the % "Not enough data"', () => {
    const rows = [notified('checked'), notified('unchecked'), notified('confirmed', { sendConfirmedAt: at('2026-10-06T14:30:00Z') })];
    const metrics = computeWeeklyMetrics(rows, BASELINE, 'log_all', SCOPES, PERIOD, RECORD, { unchecked: new Set(['unchecked']) });
    expect(metrics.cohort.waiting).toEqual({ count: 1, leads: [{ leadId: 'checked', submittedAt: '2026-10-06T14:00:00.000Z', recordUrl: RECORD('10') }], more: 0 });
    expect(metrics.cohort).toMatchObject({ leadsIn: 3, draftsEmailed: 3, sendsConfirmed: 1, unchecked: 1 });
    expect(metrics.comparison).toMatchObject({ population: 3, withoutReply: 1, percentWithoutReply: null });
  });

  it('turns a 0 for sends and replies into "Not enough data" while a lead is unchecked', () => {
    const rows = [notified('a'), notified('b')];
    const metrics = computeWeeklyMetrics(rows, BASELINE, 'log_all', SCOPES, PERIOD, RECORD, { unchecked: new Set(['b']) });
    expect(metrics.cohort.sendsConfirmed).toBeNull();
    expect(metrics.events.repliesFromLeads).toBeNull();
    // An earlier lead (not in the cohort) left unread: the replies 0 is not a fact either; the cohort's numbers are.
    const earlier = computeWeeklyMetrics(rows, BASELINE, 'log_all', SCOPES, PERIOD, RECORD, { unchecked: new Set(['older lead']) });
    expect(earlier.events.repliesFromLeads).toBeNull();
    expect(earlier.cohort).toMatchObject({ sendsConfirmed: 0, unchecked: 0, waiting: { count: 2 } });
    expect(earlier.comparison.percentWithoutReply).toBe(100);
  });

  it('keeps the % when the unchecked lead is outside the comparison population', () => {
    const rows = [notified('a'), notified('pitch', { classification: 'vendor_pitch' })];
    const metrics = computeWeeklyMetrics(rows, BASELINE, 'log_all', SCOPES, PERIOD, RECORD, { unchecked: new Set(['pitch']) });
    expect(metrics.comparison).toMatchObject({ population: 1, withoutReply: 1, percentWithoutReply: 100 });
  });
});

describe('computeWeeklyMetrics: honesty rules (D-37)', () => {
  // Nothing confirmed, nothing replied, the lead notified and waiting.
  const quiet = [lead('q', { firstNotifiedAt: at('2026-10-06T14:01:00Z'), firstSendClickedAt: at('2026-10-06T14:02:00Z') })];
  const NO_EMAIL_SCOPE = SCOPES.filter((scope) => scope !== EMAIL_SCOPE);

  const rows: readonly [LoggingMode, readonly string[], { sends: boolean; replies: boolean }][] = [
    ['log_all', SCOPES, { sends: true, replies: true }],
    ['sends_only', SCOPES, { sends: true, replies: false }],
    ['unknown', SCOPES, { sends: false, replies: false }],
    ['none', SCOPES, { sends: false, replies: false }],
    ['log_all', NO_EMAIL_SCOPE, { sends: false, replies: false }],
    ['sends_only', NO_EMAIL_SCOPE, { sends: false, replies: false }],
  ];

  it.each(rows)('logging_mode %s with scopes %j: zeros become "Not enough data" only when unsupported', (mode, scopes, supported) => {
    const metrics = computeWeeklyMetrics(quiet, BASELINE, mode, scopes, PERIOD, RECORD);
    expect(metrics.basis).toEqual({ loggingMode: mode, emailScope: scopes.includes(EMAIL_SCOPE), sendsLogged: supported.sends, repliesLogged: supported.replies });
    expect(metrics.cohort.sendsConfirmed).toBe(supported.sends ? 0 : null);
    expect(metrics.events.repliesFromLeads).toBe(supported.replies ? 0 : null);
    // When sends aren't logged, the waiting list is replaced by "We can't confirm your sends …".
    expect(metrics.cohort.waiting).toEqual(supported.sends ? { count: 1, leads: [{ leadId: 'q', submittedAt: '2026-10-06T14:00:00.000Z', recordUrl: RECORD('10') }], more: 0 } : null);
    expect(metrics.comparison.percentWithoutReply).toBe(supported.sends ? 100 : null);
    // Our own records are always counts.
    expect(metrics.cohort).toMatchObject({ leadsIn: 1, filtered: 0, draftsEmailed: 1, sendLinkOpenedNotConfirmed: 1 });
    expect(metrics.events.followUpsDrafted).toBe(0);
  });

  it.each(rows)('logging_mode %s with scopes %j: a count over 0 is always shown', (mode, scopes) => {
    const busy = [
      lead('s', { firstNotifiedAt: at('2026-10-06T14:01:00Z'), sendConfirmedAt: at('2026-10-06T14:10:00Z'), repliedAt: at('2026-10-07T14:00:00Z') }),
    ];
    const metrics = computeWeeklyMetrics(busy, BASELINE, mode, scopes, PERIOD, RECORD);
    expect(metrics.cohort.sendsConfirmed).toBe(1);
    expect(metrics.events.repliesFromLeads).toBe(1);
    // 0% means every lead in the population has a confirmed send: backed by data in any mode.
    expect(metrics.comparison.percentWithoutReply).toBe(0);
  });

  it('says "Not enough data" for the % with no population', () => {
    const metrics = computeWeeklyMetrics([lead('spam', { classification: 'spam' })], BASELINE, 'log_all', SCOPES, PERIOD, RECORD);
    expect(metrics.comparison).toMatchObject({ population: 0, withoutReply: 0, percentWithoutReply: null });
  });
});

describe('computeWeeklyMetrics: the baseline side', () => {
  const rows = simulationLeads();

  it.each([
    ['unavailable', 40, 12, 'not_readable'],
    ['insufficient', 40, 12, 'no_logged_email'],
    ['insufficient', 501, 0, 'too_many_submissions'],
    ['insufficient', 40, 0, 'no_leads'],
  ] as const)('keeps the reason of a %s baseline (%i submissions, %i leads): %s', (status, submissionsRead, leadsCounted, reason) => {
    const metrics = computeWeeklyMetrics(
      rows,
      { ...BASELINE, status, submissionsRead, leadsCounted, medianSecondsToFirstOutbound: null, withoutOutboundCount: null },
      'log_all',
      SCOPES,
      PERIOD,
      RECORD,
    );
    expect(metrics.comparison).toMatchObject({ baseline: reason, baselineMedianSeconds: null, baselinePercentWithoutReply: null });
    expect(metrics.comparison).toMatchObject({ medianSeconds: 21 * 60, percentWithoutReply: 25 });
    expect(parseWeeklyMetrics(JSON.parse(JSON.stringify(metrics)))).toEqual(metrics);
  });

  it('is "none" (Not enough data) when no baseline was ever stored', () => {
    expect(computeWeeklyMetrics(rows, null, 'log_all', SCOPES, PERIOD, RECORD).comparison).toMatchObject({
      baseline: 'none',
      baselineMedianSeconds: null,
      baselinePercentWithoutReply: null,
    });
  });

  it('keeps a baseline median under 3 samples and a % that may not be shown as "Not enough data"', () => {
    const metrics = computeWeeklyMetrics(rows, { ...BASELINE, medianSecondsToFirstOutbound: null, percentAvailable: false }, 'log_all', SCOPES, PERIOD, RECORD);
    expect(metrics.comparison).toMatchObject({ baseline: 'ok', baselineMedianSeconds: null, baselinePercentWithoutReply: null });
  });
});

describe('weekly metrics plumbing', () => {
  it('reads the email scope the HubSpot module grants', () => {
    expect(EMAIL_SCOPE).toBe(EMAIL_READ_SCOPE);
  });

  it('refuses stored metrics of another shape', () => {
    expect(parseWeeklyMetrics(null)).toBeNull();
    expect(parseWeeklyMetrics({ version: 2 })).toBeNull();
  });
});
