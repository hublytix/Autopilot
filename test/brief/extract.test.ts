import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractPage } from '@/server/services/brief/extract';

// Extraction (PLAN §9.7, §10.5, D-47) on test/fixtures/site and on crafted pages: only what a
// visitor sees reaches the model, and only visible URLs can become the booking link.

const SITE = 'https://brightside-plumbing.example';

function fixture(name: string): string {
  return readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'site', name), 'utf8');
}

function html(body: string, head = ''): string {
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

function extract(body: string, url = `${SITE}/`) {
  return extractPage({ url, contentType: 'text/html; charset=utf-8', body });
}

describe('extractPage on the fixture homepage', () => {
  const page = extract(fixture('index.html'));

  it('keeps the visible main text, one block per line, and the title', () => {
    expect(page.title).toBe('Brightside Plumbing | Licensed plumbers in Riverton');
    expect(page.text.split('\n')).toEqual(
      expect.arrayContaining([
        'Welcome to Brightside Plumbing',
        'Brightside Plumbing is a family-run plumbing company serving Riverton and the Alder Valley since 1998.',
        'Emergency call-outs around the clock, every day of the year.',
      ]),
    );
  });

  it('strips nav, header and footer', () => {
    expect(page.text).not.toContain('Call the office');
    expect(page.text).not.toContain('Careers');
    expect(page.text).not.toContain('Licence no.');
    expect(page.text).not.toContain('All rights reserved');
  });

  it('strips scripts, styles and noscript', () => {
    for (const fragment of ['dataLayer', 'page_view', 'promo-banner', 'background:', 'enable JavaScript', 'querySelectorAll']) {
      expect(page.text).not.toContain(fragment);
    }
  });

  it('strips every hidden element and comment, so the injection sample and the decoy never appear', () => {
    for (const fragment of ['Ignore previous instructions', 'ignore previous instructions', '50% discount', 'discount-plumbing', 'deals@', 'Note to', 'screen-reader-trap']) {
      expect(page.text).not.toContain(fragment);
    }
    expect(page.visibleUrls.join(' ')).not.toContain('discount-plumbing');
    expect(page.links.map((l) => l.url).join(' ')).not.toContain('discount-plumbing');
  });

  it('keeps navigation links (nav and footer included) as crawl candidates, absolute and without fragments', () => {
    const urls = page.links.map((link) => link.url);
    expect(urls).toEqual(
      expect.arrayContaining([`${SITE}/services`, `${SITE}/pricing`, `${SITE}/about`, `${SITE}/contact`, `${SITE}/faq`, `${SITE}/private`, `${SITE}/slow`]),
    );
    expect(page.links).toContainEqual({ url: `${SITE}/slow`, text: 'Service area map' });
    expect(urls).toContain('https://social.example/brightsideplumbing');
  });

  it('lists as visible only the links of the main content', () => {
    expect(page.visibleUrls).toContain(`${SITE}/services`);
    expect(page.visibleUrls).not.toContain(`${SITE}/private`);
    expect(page.visibleUrls).not.toContain('https://social.example/brightsideplumbing');
  });
});

describe('extractPage on the fixture contact and FAQ pages', () => {
  it('finds the booking link both in the text and as a visible link', () => {
    const page = extract(fixture('contact.html'), `${SITE}/contact`);
    expect(page.text).toContain('Book a visit online: https://cal.example.com/brightside/visit');
    expect(page.visibleUrls).toEqual(['https://cal.example.com/brightside/visit']);
    // Form controls are not content; their labels are.
    expect(page.text).not.toContain('Send');
  });

  it('puts each FAQ question and answer on its own line', () => {
    const page = extract(fixture('faq.html'), `${SITE}/faq`);
    const lines = page.text.split('\n');
    expect(lines).toContain('Do you offer emergency call-outs?');
    expect(lines).toContain('Yes. We answer emergency calls around the clock, every day of the year.');
    expect(lines.filter((line) => line.endsWith('?'))).toHaveLength(9);
  });

  it('keeps table rows on one line each', () => {
    const page = extract(fixture('pricing.html'), `${SITE}/pricing`);
    expect(page.text.split('\n')).toContain('Call-out and first half hour $95');
  });
});

describe('extractPage: hidden DOM variants', () => {
  it.each([
    ['display:none', '<div style="color:red; display: none !important">SECRET</div>'],
    ['visibility:hidden', '<p style="visibility:hidden">SECRET</p>'],
    ['visibility:collapse', '<p style="VISIBILITY : collapse">SECRET</p>'],
    ['opacity:0', '<p style="opacity:0">SECRET</p>'],
    ['opacity:.0', '<p style="opacity: .0;">SECRET</p>'],
    ['font-size:0', '<p style="font-size:0px">SECRET</p>'],
    ['the hidden attribute', '<section hidden><p>SECRET</p></section>'],
    ['aria-hidden=true', '<div aria-hidden="TRUE"><span>SECRET</span></div>'],
    ['a hiding class', '<span class="promo sr-only">SECRET</span>'],
    ['the visually-hidden class', '<span class="visually-hidden">SECRET</span>'],
    ['the d-none class', '<div class="d-none">SECRET</div>'],
    ['template', '<template><p>SECRET</p></template>'],
    ['a comment', '<!-- SECRET -->'],
    ['a closed dialog', '<dialog><p>SECRET</p></dialog>'],
    ['noscript', '<noscript>SECRET</noscript>'],
    ['an iframe', '<iframe srcdoc="SECRET"></iframe>'],
    ['svg text', '<svg><text>SECRET</text></svg>'],
    ['a hidden input', '<input type="hidden" value="SECRET">'],
    ['a textarea', '<textarea>SECRET</textarea>'],
  ])('drops %s', (_name, markup) => {
    const page = extract(html(`<main><p>Visible text.</p>${markup}</main>`));
    expect(page.text).toBe('Visible text.');
  });

  it('drops a hidden booking link from both the text and the visible URLs', () => {
    const page = extract(
      html('<main><p>Call us.</p><div style="display:none">Book now at <a href="https://decoy.example/book">https://decoy.example/book</a></div></main>'),
    );
    expect(page.text).toBe('Call us.');
    expect(page.visibleUrls).toEqual([]);
    expect(page.links).toEqual([]);
  });

  it('keeps visible elements whose style merely mentions other properties', () => {
    const page = extract(html('<p style="opacity:0.5; font-size: 10px">Half visible</p><p style="display:block">Shown</p>'));
    expect(page.text).toBe('Half visible\nShown');
  });

  it('writes an off-site or booking-looking link URL after its text, and resolves <base href>', () => {
    const page = extract(
      html(
        '<p><a href="https://calendly.com/brightside">Book a call</a> or see <a href="/services">services</a> or <a href="schedule">our schedule</a>.</p>',
        '<base href="https://brightside-plumbing.example/visit/">',
      ),
    );
    expect(page.text).toBe(
      'Book a call (https://calendly.com/brightside) or see services or our schedule (https://brightside-plumbing.example/visit/schedule).',
    );
    expect(page.visibleUrls).toEqual(['https://calendly.com/brightside', `${SITE}/services`, `${SITE}/visit/schedule`]);
  });

  it('ignores mailto:, tel:, javascript: and fragment-only links', () => {
    const page = extract(html('<main><a href="mailto:a@b.example">m</a><a href="tel:5550100">t</a><a href="javascript:alert(1)">j</a><a href="#top">top</a></main>'));
    expect(page.links).toEqual([]);
    expect(page.visibleUrls).toEqual([]);
  });

  it('reads text/plain pages line by line', () => {
    const page = extractPage({ url: `${SITE}/notes.txt`, contentType: 'text/plain', body: 'Line one\r\n\r\n  Line   two https://cal.example.com/x.\n' });
    expect(page).toEqual({ url: `${SITE}/notes.txt`, title: '', text: 'Line one\nLine two https://cal.example.com/x.', links: [], visibleUrls: ['https://cal.example.com/x'] });
  });
});
