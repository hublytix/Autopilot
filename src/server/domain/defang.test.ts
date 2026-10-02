import { describe, expect, it } from 'vitest';
import { defangAddresses, defangLeadText, stripControls } from './defang';

const cp = (...codes: number[]): string => String.fromCodePoint(...codes);

describe('defangLeadText (D-47 display)', () => {
  it.each<[string, string, string]>([
    ['an https URL', 'See https://evil.example.org/pay?x=1 now', 'See hxxps://evil[.]example[.]org/pay?x=1 now'],
    ['an http URL', 'http://evil.com', 'hxxp://evil[.]com'],
    ['an upper-case scheme', 'HTTPS://Evil.com', 'hxxps://Evil[.]com'],
    ['an ftp URL', 'ftp://files.evil.com/a', 'fxp://files[.]evil[.]com/a'],
    ['a www address', 'go to www.evil.com today', 'go to www[.]evil[.]com today'],
    ['a bare domain', 'visit evil.com.', 'visit evil[.]com.'],
    ['an email address', 'write to jane.doe@evil.co.uk', 'write to jane.doe[@]evil[.]co[.]uk'],
    ['text without addresses is unchanged', 'Hi, our sink leaks. Can you come on 3.10?', 'Hi, our sink leaks. Can you come on 3.10?'],
    ['several addresses', 'a.com and b@c.com', 'a[.]com and b[@]c[.]com'],
    ['a TLD outside any list', 'visit evil.academy', 'visit evil[.]academy'],
    ['a listed domain inside an unlisted one', 'paypal.com-secure.academy', 'paypal[.]com-secure[.]academy'],
    ['a protocol-relative URL', 'go to //evil.com/x', 'go to //evil[.]com/x'],
    ['a host after a hyphen', 'see -evil.com', 'see -evil[.]com'],
    ['a host after an underscore', 'see _evil.com', 'see _evil[.]com'],
    ['the ideographic full stop', `see evil${cp(0x3002)}com`, 'see evil[.]com'],
    ['the halfwidth ideographic full stop', `see evil${cp(0xff61)}com`, 'see evil[.]com'],
    ['the fullwidth full stop', `see evil${cp(0xff0e)}com`, 'see evil[.]com'],
    ['a scheme glued to a word', 'x-https://evil.com', 'x-hxxps://evil[.]com'],
    ['CJK sentences keep their full stops', `ありがとう${cp(0x3002)}よろしく${cp(0x3002)}`, `ありがとう${cp(0x3002)}よろしく${cp(0x3002)}`],
  ])('defangs %s', (_label, input, expected) => {
    expect(defangLeadText(input)).toBe(expected);
  });

  it('is idempotent', () => {
    const once = defangLeadText('See https://evil.example.org and jane@evil.com, www.x.com, y.net');
    expect(defangLeadText(once)).toBe(once);
  });

  it('keeps line breaks and removes control, invisible and bidi characters', () => {
    expect(defangLeadText(`line one\r\nline two\rthree${cp(0x2028)}four`)).toBe('line one\nline two\nthree\nfour');
    expect(defangLeadText(`tab\there${cp(0x00)}${cp(0x1b)}[31m${cp(0x7f)}`)).toBe('tab here[31m');
    expect(defangLeadText(`ev${cp(0x200b)}il.com ${cp(0x202e)}moc.live`)).toBe('evil[.]com moc[.]live');
  });

  it('leaves no clickable scheme or dotted host behind', () => {
    const out = defangLeadText('Click https://a.b.evil.com/login or www.evil.com or mail admin@evil.com');
    expect(out).not.toMatch(/https?:\/\//i);
    expect(out).not.toMatch(/[a-z0-9]\.[a-z]{2,}/i);
    expect(out).not.toMatch(/[a-z0-9]@[a-z0-9]/i);
  });
});

describe('defangLeadText on adversarial input', () => {
  it.each<[string, string]>([
    ['hyphenated labels', 'a-b.'.repeat(10_000)],
    ['dotted labels', 'a.'.repeat(20_000)],
    ['local-part characters', 'a.b%c+d-'.repeat(5_000)],
    ['@ runs', 'a@b.'.repeat(10_000)],
    ['dot-likes', `a${cp(0x3002)}`.repeat(20_000)],
  ])('stays linear: %s', (_label, text) => {
    expect(() => defangLeadText(text)).not.toThrow();
  }, 2_000);
});

describe('stripControls and defangAddresses', () => {
  it('stripControls only cleans', () => {
    expect(stripControls('a.com\tb')).toBe('a.com b');
  });

  it('defangAddresses only defangs', () => {
    expect(defangAddresses('a.com')).toBe('a[.]com');
  });
});
