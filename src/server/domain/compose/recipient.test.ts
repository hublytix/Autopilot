import { describe, expect, it } from 'vitest';
import { checkRecipient, isBareAddress, pctAddr } from '.';

describe('checkRecipient (CMP-RECIPIENT-SAFETY)', () => {
  it.each([
    ['jane@example.com', 'jane', 'example.com'],
    ['jane+leads@example.com', 'jane+leads', 'example.com'],
    ["o'brien@example.ie", "o'brien", 'example.ie'],
    ['jane.doe@sub.example.co.uk', 'jane.doe', 'sub.example.co.uk'],
    ['  jane@example.com  ', 'jane', 'example.com'],
    ['Jane@Example.COM', 'Jane', 'example.com'],
    ['jane@bücher.example', 'jane', 'xn--bcher-kva.example'],
    ['user@пример.рф', 'user', 'xn--e1afmkfd.xn--p1ai'],
    ['josé@example.com', 'josé', 'example.com'],
    ['1234567@bcc.hubspot.com', '1234567', 'bcc.hubspot.com'],
    ['first_last-1@my-company.example', 'first_last-1', 'my-company.example'],
  ])('accepts %j as one bare address', (raw, local, domain) => {
    expect(checkRecipient(raw)).toEqual({ ok: true, address: { local, domain } });
    expect(isBareAddress(raw)).toBe(true);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['a@x.com;evil@y.com', 'forbidden_character'],
    ['a@x.com,b@y.com', 'forbidden_character'],
    ['Jane <jane@x.com>', 'forbidden_character'],
    ['<jane@x.com>', 'forbidden_character'],
    ['"jane"@x.com', 'forbidden_character'],
    ['jane@x.com\r\nbcc:evil@y.com', 'forbidden_character'],
    ['jane@x.com\nevil@y.com', 'forbidden_character'],
    ['jane @x.com', 'forbidden_character'],
    ['jane\t@x.com', 'forbidden_character'],
    ['jane @x.com', 'forbidden_character'],
    ['ja​ne@x.com', 'forbidden_character'],
    ['jane‮@x.com', 'forbidden_character'],
    ['jane@x.com?cc=evil@y.com', 'forbidden_character'],
    ['jane@x.com&bcc=evil@y.com', 'forbidden_character'],
    ['jane@x.com#frag', 'forbidden_character'],
    ['ja%6Ee@x.com', 'forbidden_character'],
    ['jane(comment)@x.com', 'forbidden_character'],
    ['jane\\@x.com', 'forbidden_character'],
    ['jane@[127.0.0.1]', 'forbidden_character'],
    ['mailto:jane@x.com', 'forbidden_character'],
    // Compatibility forms of the delimiters, which NFKC folding turns into the delimiters themselves.
    ['jane@x.com\uFF0Cevil@y.com', 'forbidden_character'],
    ['jane@x.com\uFF1Bevil@y.com', 'forbidden_character'],
    ['jane\uFE50evil@x.com', 'forbidden_character'],
    ['jane\uFF1Cevil@x.com', 'forbidden_character'],
    ['jane\uFF1E@x.com', 'forbidden_character'],
    ['jane\uFF02@x.com', 'forbidden_character'],
    ['jane\uFE54evil@x.com', 'forbidden_character'],
    ['ja\uD800ne@x.com', 'not_well_formed'],
    ['jane@@x.com', 'not_single_address'],
    ['jane@x.com@y.com', 'not_single_address'],
    ['jane.x.com', 'not_single_address'],
    ['evil\uFF20y.com@x.com', 'not_single_address'],
    ['jane\uFE6Bevil@x.com', 'not_single_address'],
    ['@x.com', 'bad_local_part'],
    ['.jane@x.com', 'bad_local_part'],
    ['jane.@x.com', 'bad_local_part'],
    ['jane..doe@x.com', 'bad_local_part'],
    [`${'a'.repeat(65)}@x.com`, 'bad_local_part'],
    ['jane@', 'bad_domain'],
    ['jane@x', 'bad_domain'],
    ['jane@localhost', 'bad_domain'],
    ['jane@-x.com', 'bad_domain'],
    ['jane@x-.com', 'bad_domain'],
    ['jane@x..com', 'bad_domain'],
    ['jane@x.com.', 'bad_domain'],
    ['jane@1.2.3.4', 'bad_domain'],
    ['jane@0x7f.1', 'bad_domain'],
    ['jane@exa_mple.com', 'bad_domain'],
    ['jane@exa/mple.com', 'bad_domain'],
    [`jane@${'a'.repeat(64)}.com`, 'bad_domain'],
    [`${'a'.repeat(60)}@${`${'b'.repeat(60)}.`.repeat(4)}com`, 'too_long'],
    [`a@${'b'.repeat(250)}.com`, 'too_long'],
    // 254 characters as typed, 290 once the IDN domain is in its ASCII form.
    [`${'a'.repeat(64)}@${Array.from({ length: 6 }, () => 'ü'.repeat(30)).join('.')}.com`, 'too_long'],
  ])('refuses %j (%s)', (raw, problem) => {
    expect(checkRecipient(raw)).toEqual({ ok: false, problem });
    expect(isBareAddress(raw)).toBe(false);
  });
});

describe('pctAddr', () => {
  it('percent-encodes the local part, keeps the @ literal and writes the ASCII domain', () => {
    const encode = (raw: string): string => {
      const checked = checkRecipient(raw);
      if (!checked.ok) throw new Error(checked.problem);
      return pctAddr(checked.address);
    };
    expect(encode('jane+leads@example.com')).toBe('jane%2Bleads@example.com');
    expect(encode("o'brien@example.ie")).toBe('o%27brien@example.ie');
    expect(encode('josé@bücher.example')).toBe('jos%C3%A9@xn--bcher-kva.example');
  });
});
