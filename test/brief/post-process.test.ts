import { describe, expect, it } from 'vitest';
import type { BriefDraft } from '@/server/ports/llm';
import { acceptGeneratedBookingLink, bookingLinkHost, parseBookingLink } from '@/server/services/brief/booking-link';
import { MAX_FAQS } from '@/server/services/brief/limits';
import { postProcessBrief } from '@/server/services/brief/post-process';
import { BRIEF_FIELD_LIMITS, OwnerBriefInputSchema } from '@/server/services/brief/schema';
import { isSameSite, normaliseSiteUrl } from '@/server/services/brief/site-url';

// Post-processing and booking-link rules (brief §5.3, PLAN §9.7, D-24, D-47), the owner's form
// (brief §5.3) and the website address the owner types.

const BOOKING = 'https://cal.example.com/brightside/visit';

function draft(overrides: Partial<BriefDraft> = {}): BriefDraft {
  return {
    company_name: 'Brightside Plumbing',
    one_line: 'Family-run plumbers in Riverton.',
    services: ['Emergency repairs', 'Drain cleaning'],
    who_we_serve: 'Homeowners in Riverton',
    booking_link: BOOKING,
    tone: { style: 'friendly', note: 'Warm.' },
    sign_off_name: 'Dana Whitfield',
    allow_pricing: false,
    never_promise: ['Exact prices before seeing the job'],
    faqs: [{ q: 'Do you offer emergency call-outs?', a: 'Yes.' }],
    ...overrides,
  };
}

describe('postProcessBrief', () => {
  it('caps FAQs at 8, after dropping empty ones', () => {
    const faqs = [{ q: ' ', a: 'orphan answer' }, ...Array.from({ length: 10 }, (_, i) => ({ q: `Question ${i}?`, a: `Answer ${i}.` }))];
    const out = postProcessBrief(draft({ faqs }), { visibleUrls: [BOOKING] });
    expect(out.faqs).toHaveLength(MAX_FAQS);
    expect(out.faqs[0]).toEqual({ q: 'Question 0?', a: 'Answer 0.' });
    expect(out.faqs.at(-1)).toEqual({ q: 'Question 7?', a: 'Answer 7.' });
  });

  it('always sets allow_pricing to false, whatever the model said', () => {
    expect(postProcessBrief(draft({ allow_pricing: true }), { visibleUrls: [] }).allow_pricing).toBe(false);
  });

  it('keeps an https booking link that appears in the visible pages (fragment and trailing slash aside)', () => {
    expect(postProcessBrief(draft(), { visibleUrls: [BOOKING] }).booking_link).toBe(BOOKING);
    expect(acceptGeneratedBookingLink(`${BOOKING}/`, [`${BOOKING}#slots`])).toBe(`${BOOKING}/`);
  });

  it('drops a booking link that is not in the visible pages: a hidden decoy, or one the model made up', () => {
    const decoy = 'https://discount-plumbing.example/book';
    expect(postProcessBrief(draft({ booking_link: decoy }), { visibleUrls: [BOOKING, 'https://brightside-plumbing.example/services'] }).booking_link).toBeNull();
    expect(postProcessBrief(draft({ booking_link: 'https://cal.example.com/brightside/other' }), { visibleUrls: [BOOKING] }).booking_link).toBeNull();
  });

  it('drops a booking link that is not https, even when the page shows it', () => {
    const http = 'http://cal.example.com/brightside/visit';
    expect(postProcessBrief(draft({ booking_link: http }), { visibleUrls: [http] }).booking_link).toBeNull();
    for (const bad of ['javascript:alert(1)', 'https://user:pw@cal.example.com/x', 'https://127.0.0.1/book', 'https://cal.example.com:8443/x', 'not a url']) {
      expect(acceptGeneratedBookingLink(bad, [bad])).toBeNull();
    }
  });

  it('trims never_promise, dropping empty and repeated items', () => {
    const out = postProcessBrief(draft({ never_promise: ['  Discounts  ', '', '   ', 'discounts', 'Arrival\ntimes we have not confirmed', 'x'.repeat(500)] }), { visibleUrls: [] });
    expect(out.never_promise).toEqual(['Discounts', 'Arrival times we have not confirmed', 'x'.repeat(BRIEF_FIELD_LIMITS.neverPromiseItem)]);
  });

  it('cleans control characters and cuts every field to the owner form limits', () => {
    const out = postProcessBrief(
      draft({ company_name: `Bright\u0000side‮ ${'P'.repeat(300)}`, services: Array.from({ length: 30 }, (_, i) => `Service ${i}`), sign_off_name: '  Dana\tWhitfield  ' }),
      { visibleUrls: [] },
    );
    expect(out.company_name.startsWith('Brightside‮ P')).toBe(true);
    expect(Array.from(out.company_name).length).toBeLessThanOrEqual(BRIEF_FIELD_LIMITS.companyName);
    expect(out.services).toHaveLength(BRIEF_FIELD_LIMITS.services);
    expect(out.sign_off_name).toBe('Dana Whitfield');
  });

  it('produces a brief the owner form accepts unchanged', () => {
    const out = postProcessBrief(draft(), { visibleUrls: [BOOKING] });
    const parsed = OwnerBriefInputSchema.safeParse({ ...out, booking_link_choice: 'link', booking_link_confirmed: true });
    expect(parsed.success).toBe(true);
  });
});

describe('booking-link helpers', () => {
  it('shows the host for confirmation in ASCII, so a look-alike domain is visible', () => {
    expect(bookingLinkHost(BOOKING)).toBe('cal.example.com');
    expect(bookingLinkHost('https://саl.example.com/book')).toBe('xn--l-7sb4c.example.com');
    expect(bookingLinkHost('http://cal.example.com/')).toBeNull();
    expect(bookingLinkHost(null)).toBeNull();
    expect(parseBookingLink(' https://cal.example.com/x ')?.href).toBe('https://cal.example.com/x');
  });
});

describe('OwnerBriefInputSchema (brief §5.3)', () => {
  const base = { ...draft(), booking_link_choice: 'link', booking_link: BOOKING, booking_link_confirmed: true };

  it('accepts a full brief with a confirmed https link', () => {
    const parsed = OwnerBriefInputSchema.parse(base);
    expect(parsed).toMatchObject({ bookingLinkChoice: 'link', bookingLinkConfirmed: true, brief: { booking_link: BOOKING, allow_pricing: false } });
  });

  it('refuses "unset" and a missing choice: the owner must add a link or choose none', () => {
    expect(OwnerBriefInputSchema.safeParse({ ...base, booking_link_choice: 'unset' }).success).toBe(false);
    const { booking_link_choice: _omit, ...withoutChoice } = base;
    expect(OwnerBriefInputSchema.safeParse(withoutChoice).success).toBe(false);
  });

  it('requires an https link and the host confirmation when the choice is link', () => {
    const http = OwnerBriefInputSchema.safeParse({ ...base, booking_link: 'http://cal.example.com/x' });
    expect(http.success).toBe(false);
    expect(http.error?.issues.map((i) => i.message)).toContain('booking_link_not_https');
    const unconfirmed = OwnerBriefInputSchema.safeParse({ ...base, booking_link_confirmed: false });
    expect(unconfirmed.error?.issues.map((i) => i.message)).toContain('booking_link_not_confirmed');
  });

  it('stores no link when the owner chooses none', () => {
    const parsed = OwnerBriefInputSchema.parse({ ...base, booking_link_choice: 'none', booking_link: BOOKING });
    expect(parsed).toMatchObject({ bookingLinkChoice: 'none', bookingLinkConfirmed: false, brief: { booking_link: null } });
  });

  it('keeps the owner allow_pricing choice and enforces the field limits', () => {
    expect(OwnerBriefInputSchema.parse({ ...base, allow_pricing: true }).brief.allow_pricing).toBe(true);
    expect(OwnerBriefInputSchema.safeParse({ ...base, faqs: Array.from({ length: 9 }, () => ({ q: 'Q?', a: 'A.' })) }).success).toBe(false);
    expect(OwnerBriefInputSchema.safeParse({ ...base, company_name: '   ' }).success).toBe(false);
    expect(OwnerBriefInputSchema.safeParse({ ...base, sign_off_name: 'x'.repeat(81) }).success).toBe(false);
    expect(OwnerBriefInputSchema.safeParse({ ...base, tone: { style: 'casual', note: '' } }).success).toBe(false);
  });

  it('trims text and keeps line breaks only in FAQ answers', () => {
    const parsed = OwnerBriefInputSchema.parse({ ...base, one_line: '  Plumbers\nin Riverton ', faqs: [{ q: ' Q?\n', a: 'Line one.\nLine two.' }] });
    expect(parsed.brief.one_line).toBe('Plumbers in Riverton');
    expect(parsed.brief.faqs).toEqual([{ q: 'Q?', a: 'Line one.\nLine two.' }]);
  });
});

describe('normaliseSiteUrl', () => {
  it.each([
    ['brightside-plumbing.example', 'https://brightside-plumbing.example/'],
    ['  www.brightside-plumbing.example/home#top ', 'https://www.brightside-plumbing.example/home'],
    ['http://brightside-plumbing.example', 'http://brightside-plumbing.example/'],
    ['HTTPS://Brightside-Plumbing.example/About', 'https://brightside-plumbing.example/About'],
  ])('accepts %j as %s', (input, url) => {
    expect(normaliseSiteUrl(input)).toEqual({ ok: true, url });
  });

  it.each([
    ['', 'site_url_invalid'],
    ['not a url', 'site_url_invalid'],
    ['localhost', 'site_url_not_allowed'],
    ['192.168.1.10', 'site_url_not_allowed'],
    ['https://[::1]/', 'site_url_not_allowed'],
    ['ftp://files.example.com', 'site_url_not_allowed'],
    ['https://site.example.com:8080/', 'site_url_not_allowed'],
    ['intranet', 'site_url_not_allowed'],
  ])('refuses %j (%s)', (input, reason) => {
    expect(normaliseSiteUrl(input)).toEqual({ ok: false, reason });
  });

  it('treats www and the bare host, over http or https, as one site', () => {
    expect(isSameSite(new URL('https://www.example.com/a'), new URL('http://example.com/b'))).toBe(true);
    expect(isSameSite(new URL('https://shop.example.com/'), new URL('https://example.com/'))).toBe(false);
  });
});
