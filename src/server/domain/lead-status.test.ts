import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveLeadStatus, LEAD_STATUS_LABELS, leadStatusLabel, NO_REPLY_AFTER_MS, type LeadStatusInput } from './lead-status';
import { CLASSIFICATIONS, isDraftableClassification, LEAD_DISPLAY_STATUSES, STOP_REASONS, type LeadDisplayStatus } from './types';

// PLAN §12: nothing here may read the wall clock, so the system time is set far from every instant the tests use.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

const NOW = new Date('2026-10-14T16:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

/** A lead that is still being processed: classified as a lead, nothing emailed yet. */
function lead(overrides: Partial<LeadStatusInput> = {}): LeadStatusInput {
  return {
    processingState: 'processing',
    classification: 'lead',
    classificationOverride: null,
    processRev: 0,
    stopReason: null,
    dismissedAt: null,
    repliedAt: null,
    firstNotifiedAt: null,
    fu1NotifiedAt: null,
    fu2NotifiedAt: null,
    firstSendClickedAt: null,
    sendConfirmedAt: null,
    followupsEnabled: true,
    ...overrides,
  };
}

/**
 * The fields that make each status's rule true, on top of `lead()`. The entries set disjoint fields,
 * so in `leadWith` every requested rule still holds on the merged input (no field of one status
 * overwrites another's) and the precedence tests really pit the rules against each other.
 */
const MAKES: Record<LeadDisplayStatus, Partial<LeadStatusInput>> = {
  dismissed: { dismissedAt: ago(HOUR) },
  replied: { repliedAt: ago(2 * DAY) },
  filtered: { classification: 'spam' },
  not_processed: { processingState: 'failed' },
  // Both follow-ups emailed (the last one 3 days ago): no follow-up is coming.
  no_reply: { fu2NotifiedAt: ago(3 * DAY) },
  send_confirmed: { sendConfirmedAt: ago(7 * DAY) },
  send_clicked: { firstSendClickedAt: ago(7 * DAY) },
  // Emailed 10 days ago, follow-ups still to come.
  drafted: { firstNotifiedAt: ago(10 * DAY) },
  processing: {},
};

/** The lead with every given status's fields (disjoint, see MAKES). */
function leadWith(statuses: readonly LeadDisplayStatus[]): LeadStatusInput {
  return lead(statuses.reduce<Partial<LeadStatusInput>>((fields, status) => ({ ...fields, ...MAKES[status] }), {}));
}

describe('deriveLeadStatus precedence (D-32)', () => {
  it('lists the statuses in D-32 order', () => {
    expect(LEAD_DISPLAY_STATUSES).toEqual([
      'dismissed',
      'replied',
      'filtered',
      'not_processed',
      'no_reply',
      'send_confirmed',
      'send_clicked',
      'drafted',
      'processing',
    ]);
  });

  it('builds each status from fields no other status sets', () => {
    const owners = new Map<string, LeadDisplayStatus>();
    for (const status of LEAD_DISPLAY_STATUSES) {
      for (const field of Object.keys(MAKES[status])) {
        expect(owners.get(field), `${field} is set by ${owners.get(field) ?? ''} and ${status}`).toBeUndefined();
        owners.set(field, status);
      }
    }
  });

  it.each(['failed', 'skipped', 'deferred'] as const)('a filtered class wins over a %s processing state (rule 3 before rule 4)', (processingState) => {
    expect(deriveLeadStatus(lead({ classification: 'spam', processingState }), NOW)).toBe('filtered');
    expect(deriveLeadStatus(lead({ classification: 'vendor_pitch', processingState: 'filtered' }), NOW)).toBe('filtered');
  });

  it.each(LEAD_DISPLAY_STATUSES)('derives %s from its own fields alone', (status) => {
    expect(deriveLeadStatus(leadWith([status]), NOW)).toBe(status);
  });

  const pairs = LEAD_DISPLAY_STATUSES.flatMap((higher, i) => LEAD_DISPLAY_STATUSES.slice(i + 1).map((lower) => [higher, lower] as const));

  it.each(pairs)('%s wins over %s', (higher, lower) => {
    expect(deriveLeadStatus(leadWith([higher, lower]), NOW)).toBe(higher);
  });

  it('picks the highest-precedence status for every combination of rules', () => {
    for (let mask = 0; mask < 1 << LEAD_DISPLAY_STATUSES.length; mask += 1) {
      const present = LEAD_DISPLAY_STATUSES.filter((_, i) => (mask & (1 << i)) !== 0);
      expect(deriveLeadStatus(leadWith(present), NOW)).toBe(present[0] ?? 'processing');
    }
  });
});

describe('deriveLeadStatus rules', () => {
  it('files every class but lead and unclear as filtered', () => {
    for (const classification of CLASSIFICATIONS) {
      const expected = isDraftableClassification(classification) ? 'processing' : 'filtered';
      expect(deriveLeadStatus(lead({ classification }), NOW)).toBe(expected);
    }
    expect(deriveLeadStatus(lead({ classification: null, processingState: 'new' }), NOW)).toBe('processing');
  });

  it('does not show an overridden filtered lead as filtered ("This is a real lead")', () => {
    const filtered = lead({ classification: 'vendor_pitch', processingState: 'filtered' });
    expect(deriveLeadStatus(filtered, NOW)).toBe('filtered');
    // Override written, re-processing not yet run.
    expect(deriveLeadStatus({ ...filtered, processRev: 1 }, NOW)).toBe('processing');
    expect(deriveLeadStatus({ ...filtered, classificationOverride: 'lead' }, NOW)).toBe('processing');
    // Re-processed and emailed.
    expect(deriveLeadStatus({ ...filtered, processRev: 1, ...MAKES.drafted }, NOW)).toBe('drafted');
  });

  it('shows failed, skipped and deferred leads as not processed', () => {
    for (const processingState of ['failed', 'skipped', 'deferred'] as const) {
      expect(deriveLeadStatus(lead({ processingState }), NOW)).toBe('not_processed');
    }
    // A failed lead that got the needs-touch email is still "not processed".
    expect(deriveLeadStatus(lead({ processingState: 'failed', firstNotifiedAt: ago(5 * DAY), followupsEnabled: false }), NOW)).toBe(
      'not_processed',
    );
  });

  it('shows new and processing leads as processing, and notified ones as drafted', () => {
    expect(deriveLeadStatus(lead({ processingState: 'new', classification: null }), NOW)).toBe('processing');
    expect(deriveLeadStatus(lead({ processingState: 'processing' }), NOW)).toBe('processing');
    expect(deriveLeadStatus(lead({ processingState: 'notified', firstNotifiedAt: ago(HOUR) }), NOW)).toBe('drafted');
  });

  it('keeps a confirmed send and an opened send link apart (law 3)', () => {
    const notified = lead(MAKES.drafted);
    expect(deriveLeadStatus({ ...notified, firstSendClickedAt: ago(HOUR) }, NOW)).toBe('send_clicked');
    expect(deriveLeadStatus({ ...notified, sendConfirmedAt: ago(HOUR) }, NOW)).toBe('send_confirmed');
    expect(deriveLeadStatus({ ...notified, firstSendClickedAt: ago(2 * HOUR), sendConfirmedAt: ago(HOUR) }, NOW)).toBe('send_confirmed');
  });
});

describe('deriveLeadStatus "no reply" (D-32 rule 5)', () => {
  const notified = lead({ processingState: 'notified', firstNotifiedAt: ago(10 * DAY), sendConfirmedAt: ago(10 * DAY) });

  it('starts exactly 2 days after the last follow-up email', () => {
    const finished = { ...notified, fu1NotifiedAt: ago(8 * DAY) };
    expect(deriveLeadStatus({ ...finished, fu2NotifiedAt: ago(NO_REPLY_AFTER_MS) }, NOW)).toBe('no_reply');
    expect(deriveLeadStatus({ ...finished, fu2NotifiedAt: ago(NO_REPLY_AFTER_MS - 1) }, NOW)).toBe('send_confirmed');
    expect(NO_REPLY_AFTER_MS).toBe(2 * DAY);
  });

  it('applies when follow-ups stopped early, counting from the last email sent', () => {
    for (const stopReason of STOP_REASONS.filter((reason) => reason !== 'dismissed' && reason !== 'replied')) {
      const stopped = { ...notified, stopReason, fu1NotifiedAt: ago(2 * DAY) };
      expect(deriveLeadStatus(stopped, NOW)).toBe('no_reply');
      expect(deriveLeadStatus({ ...stopped, fu1NotifiedAt: ago(2 * DAY - 1) }, NOW)).toBe('send_confirmed');
    }
  });

  it('applies when follow-ups are off, 2 days after the first email', () => {
    const off = lead({ ...MAKES.drafted, firstNotifiedAt: ago(2 * DAY), followupsEnabled: false });
    expect(deriveLeadStatus(off, NOW)).toBe('no_reply');
    expect(deriveLeadStatus({ ...off, firstNotifiedAt: ago(2 * DAY - 1) }, NOW)).toBe('drafted');
  });

  it('never applies while a follow-up is still coming', () => {
    const waiting = { ...notified, fu1NotifiedAt: ago(20 * DAY), firstNotifiedAt: ago(30 * DAY) };
    expect(deriveLeadStatus(waiting, NOW)).toBe('send_confirmed');
    expect(deriveLeadStatus({ ...waiting, sendConfirmedAt: null }, NOW)).toBe('drafted');
  });

  it('never applies to a lead the owner was never emailed about', () => {
    expect(deriveLeadStatus(lead({ followupsEnabled: false, stopReason: 'superseded' }), NOW)).toBe('processing');
  });

  it('gives the simulation its expected Wednesday statuses (PLAN §13)', () => {
    const wednesday = new Date('2026-10-14T16:00:00.000Z');
    const day0 = new Date('2026-10-06T14:00:00.000Z');
    const day2 = new Date('2026-10-08T14:00:00.000Z');
    const day5 = new Date('2026-10-11T14:00:00.000Z');
    const emailed = { processingState: 'notified', firstNotifiedAt: day0, fu1NotifiedAt: day2 } as const;
    const statuses = [
      lead({ ...emailed, fu2NotifiedAt: day5, sendConfirmedAt: new Date('2026-10-06T14:13:00.000Z') }),
      lead({ ...emailed, fu2NotifiedAt: day5, firstSendClickedAt: new Date('2026-10-06T15:00:00.000Z') }),
      lead({ classification: 'spam', processingState: 'filtered' }),
      lead({ classification: 'vendor_pitch', processingState: 'filtered' }),
      lead({ ...emailed, fu2NotifiedAt: day5, sendConfirmedAt: new Date('2026-10-06T14:21:00.000Z') }),
      lead({ ...emailed, stopReason: 'replied', repliedAt: new Date('2026-10-09T15:00:00.000Z') }),
    ].map((input) => deriveLeadStatus(input, wednesday));
    expect(statuses).toEqual(['no_reply', 'no_reply', 'filtered', 'filtered', 'no_reply', 'replied']);
  });
});

describe('lead status labels', () => {
  it('labels every status, with the D-32 wording', () => {
    expect(Object.keys(LEAD_STATUS_LABELS).sort()).toEqual([...LEAD_DISPLAY_STATUSES].sort());
    expect(leadStatusLabel('no_reply')).toBe('No reply from lead (none logged)');
    expect(leadStatusLabel('send_clicked')).toBe('Send link opened');
    expect(leadStatusLabel('not_processed')).toBe('Not processed');
    expect(leadStatusLabel('processing')).toBe('Processing');
  });

  it('never calls an opened send link a send, and says where a send was confirmed (law 3)', () => {
    expect(leadStatusLabel('send_clicked')).not.toMatch(/confirm|sent/i);
    expect(leadStatusLabel('send_confirmed')).toMatch(/HubSpot/);
  });
});
