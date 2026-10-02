import { describe, expect, it } from 'vitest';
import { EDIT_INPUT_LIMITS, parseEditInput } from './edit';

// The edit form's input rules (PLAN §7.4, D-13): only an empty or oversized subject or reply is
// refused; everything else is the owner's call (the validator's codes are hints, see
// http/action-links/edit.test.ts).

describe('parseEditInput', () => {
  it('normalises line breaks to \\n and trims the ends, keeping inner spacing', () => {
    expect(parseEditInput({ subject: '  Re: hello \r\n', body: '\r\n Hi Jane,\r\n\r\n  indented\rline\n\n' })).toEqual({
      ok: true,
      subject: 'Re: hello',
      body: 'Hi Jane,\n\n  indented\nline',
    });
  });

  it('treats a missing field or a non-text value (a file) as empty', () => {
    expect(parseEditInput({ subject: undefined, body: new Blob(['x']) })).toEqual({
      ok: false,
      issues: [
        { field: 'subject', code: 'subject_required' },
        { field: 'body', code: 'body_required' },
      ],
      subject: '',
      body: '',
    });
    expect(parseEditInput({ subject: '\n\t ', body: 'Hi' })).toMatchObject({ ok: false, issues: [{ field: 'subject', code: 'subject_required' }] });
  });

  it('counts characters, not UTF-16 units, against the limits', () => {
    const { subjectMaxChars, bodyMaxChars } = EDIT_INPUT_LIMITS;
    expect(parseEditInput({ subject: '🙂'.repeat(subjectMaxChars), body: '𝔁'.repeat(bodyMaxChars) }).ok).toBe(true);
    expect(parseEditInput({ subject: '🙂'.repeat(subjectMaxChars + 1), body: '𝔁'.repeat(bodyMaxChars + 1) })).toMatchObject({
      ok: false,
      issues: [
        { field: 'subject', code: 'subject_too_long' },
        { field: 'body', code: 'body_too_long' },
      ],
    });
  });

  it('accepts text the validator would flag: the owner is in charge', () => {
    expect(parseEditInput({ subject: '[Name], <b>hi</b>', body: 'Call 0161 555 0199 or visit https://elsewhere.example' }).ok).toBe(true);
  });
});
