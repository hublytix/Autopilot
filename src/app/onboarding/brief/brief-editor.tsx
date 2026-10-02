'use client';

import { useActionState } from 'react';
import { Alert, Checkbox, Field, fieldDescription, Input, Select, SubmitButton } from '@/components/ui';
import type { BriefFormState, BriefFormValues, FieldIssue } from '@/server/actions/onboarding/types';
import { Textarea } from './textarea';

// The brief editor (brief §5.3, PLAN §7.5, D-47): every brief field, editable. Lists are one item
// per line; up to 8 FAQ pairs; prices off by default with a warning; and the booking link is an
// explicit choice: confirm the link found on the site (its host shown), enter another, or say there
// is none. Saving creates an owner version (the brief drafts use). Works without JavaScript.

export interface BriefLimits {
  companyName: number;
  oneLine: number;
  services: number;
  service: number;
  whoWeServe: number;
  toneNote: number;
  signOffName: number;
  neverPromise: number;
  neverPromiseItem: number;
  faqs: number;
  faqQuestion: number;
  faqAnswer: number;
}

export interface BriefEditorProps {
  action: (state: BriefFormState, formData: FormData) => Promise<BriefFormState>;
  initial: BriefFormValues;
  bookingLink: { url: string; host: string; source: 'generated' | 'owner' } | null;
  limits: BriefLimits;
}

const TONES = [
  { value: 'friendly', label: 'Friendly' },
  { value: 'formal', label: 'Formal' },
  { value: 'direct', label: 'Direct' },
] as const;

function message(issue: FieldIssue, limits: BriefLimits): string {
  const field = issue.path.split('.')[0] ?? '';
  switch (issue.code) {
    case 'required':
      if (field === 'company_name') return 'Enter your business name.';
      if (field === 'sign_off_name') return 'Enter the name your replies are signed with.';
      if (field === 'faqs') return 'Fill in both the question and the answer, or clear both.';
      return 'This is required.';
    case 'too_long':
      return 'This is too long. Shorten it a little.';
    case 'too_many':
      if (field === 'services') return `List at most ${limits.services} services.`;
      if (field === 'never_promise') return `List at most ${limits.neverPromise} lines.`;
      return `Add at most ${limits.faqs} questions.`;
    case 'invalid_choice':
      return 'Choose a tone.';
    case 'booking_link_choice_required':
    case 'booking_link_not_confirmed':
      return 'Choose one of the booking link options.';
    case 'booking_link_not_https':
      return 'Enter a full booking link that starts with https://';
    default:
      return 'Check this field.';
  }
}

/** The first message for a field: an exact path, or any path under it (`services.3` → `services`). */
function errorFor(issues: readonly FieldIssue[], limits: BriefLimits, ...paths: string[]): string | undefined {
  const issue = issues.find((candidate) => paths.some((path) => candidate.path === path || candidate.path.startsWith(`${path}.`)));
  return issue === undefined ? undefined : message(issue, limits);
}

export function BriefEditor({ action, initial, bookingLink, limits }: BriefEditorProps) {
  const [state, formAction] = useActionState(action, { issues: [], values: null });
  const values = state.values ?? initial;
  const issues = state.issues;
  const err = (...paths: string[]): string | undefined => errorFor(issues, limits, ...paths);
  const describe = (id: string, hint: boolean, error: string | undefined): string | undefined =>
    fieldDescription(id, { hint, error: error !== undefined });

  const companyError = err('company_name');
  const oneLineError = err('one_line');
  const servicesError = err('services');
  const whoError = err('who_we_serve');
  const toneError = err('tone.style');
  const toneNoteError = err('tone.note');
  const signOffError = err('sign_off_name');
  const neverError = err('never_promise');
  const bookingError = err('booking_link_choice', 'booking_link_confirmed');
  const otherLinkError = err('booking_link');
  // The filled questions and one empty row show; the other empty rows sit behind a disclosure.
  const lastFilled = values.faqs.reduce((last, faq, index) => (faq.q.trim() !== '' || faq.a.trim() !== '' ? index : last), -1);
  const shownFaqs = Math.min(values.faqs.length, lastFilled + 2);
  const faqRow = (faq: { q: string; a: string }, index: number) => {
    const questionError = err(`faqs.${index}.q`, `faqs.${index}`);
    const answerError = err(`faqs.${index}.a`);
    return (
      <div key={index} className="flex flex-col gap-3 rounded-lg border border-neutral-300 p-4 dark:border-neutral-700">
        <Field id={`faq_q_${index}`} label={`Question ${index + 1}`} error={questionError}>
          <Input
            id={`faq_q_${index}`}
            name={`faq_q_${index}`}
            maxLength={limits.faqQuestion}
            defaultValue={faq.q}
            invalid={questionError !== undefined}
            describedBy={describe(`faq_q_${index}`, false, questionError)}
          />
        </Field>
        <Field id={`faq_a_${index}`} label={`Answer ${index + 1}`} error={answerError}>
          <Textarea
            id={`faq_a_${index}`}
            name={`faq_a_${index}`}
            rows={3}
            maxLength={limits.faqAnswer}
            defaultValue={faq.a}
            invalid={answerError !== undefined}
            describedBy={describe(`faq_a_${index}`, false, answerError)}
          />
        </Field>
      </div>
    );
  };

  return (
    // The key resets the uncontrolled inputs when the server sends different values back.
    <form key={JSON.stringify(values)} action={formAction} className="flex flex-col gap-6" noValidate>
      {issues.length > 0 ? (
        <Alert tone="error" title="Some fields need a look">
          <p>Fix the fields marked below, then save again.</p>
        </Alert>
      ) : null}

      <Field id="company_name" label="Business name" error={companyError}>
        <Input
          id="company_name"
          name="company_name"
          autoComplete="organization"
          maxLength={limits.companyName}
          defaultValue={values.company_name}
          invalid={companyError !== undefined}
          describedBy={describe('company_name', false, companyError)}
        />
      </Field>

      <Field id="one_line" label="What you do, in one line" hint="For example: Family-run plumbers serving Springfield since 1998." optional error={oneLineError}>
        <Input
          id="one_line"
          name="one_line"
          maxLength={limits.oneLine}
          defaultValue={values.one_line}
          invalid={oneLineError !== undefined}
          describedBy={describe('one_line', true, oneLineError)}
        />
      </Field>

      <Field id="services" label="Services" hint={`One per line, up to ${limits.services}.`} optional error={servicesError}>
        <Textarea
          id="services"
          name="services"
          rows={5}
          defaultValue={values.services}
          invalid={servicesError !== undefined}
          describedBy={describe('services', true, servicesError)}
        />
      </Field>

      <Field id="who_we_serve" label="Who you serve" hint="For example: homeowners and small businesses in the county." optional error={whoError}>
        <Input
          id="who_we_serve"
          name="who_we_serve"
          maxLength={limits.whoWeServe}
          defaultValue={values.who_we_serve}
          invalid={whoError !== undefined}
          describedBy={describe('who_we_serve', true, whoError)}
        />
      </Field>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-base font-semibold">Tone of your replies</legend>
        <Field id="tone_style" label="Style" error={toneError}>
          <Select
            id="tone_style"
            name="tone_style"
            defaultValue={values.tone_style}
            invalid={toneError !== undefined}
            describedBy={describe('tone_style', false, toneError)}
          >
            {TONES.map((tone) => (
              <option key={tone.value} value={tone.value}>
                {tone.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="tone_note" label="Anything else about your tone" hint="For example: we keep it short and say “cheers”." optional error={toneNoteError}>
          <Input
            id="tone_note"
            name="tone_note"
            maxLength={limits.toneNote}
            defaultValue={values.tone_note}
            invalid={toneNoteError !== undefined}
            describedBy={describe('tone_note', true, toneNoteError)}
          />
        </Field>
      </fieldset>

      <Field id="sign_off_name" label="Sign replies as" hint="The name at the end of each draft, for example: Dana." error={signOffError}>
        <Input
          id="sign_off_name"
          name="sign_off_name"
          autoComplete="name"
          maxLength={limits.signOffName}
          defaultValue={values.sign_off_name}
          invalid={signOffError !== undefined}
          describedBy={describe('sign_off_name', true, signOffError)}
        />
      </Field>

      <div className="flex flex-col gap-2">
        <Checkbox
          id="allow_pricing"
          name="allow_pricing"
          defaultChecked={values.allow_pricing}
          label="Drafts may mention prices"
          hint="Off by default. Turn this on only if your prices are fixed and public: a draft could quote a price you would rather discuss first."
        />
      </div>

      <Field
        id="never_promise"
        label="Things your replies must never promise"
        hint={`One per line, up to ${limits.neverPromise}. For example: same-day visits.`}
        optional
        error={neverError}
      >
        <Textarea
          id="never_promise"
          name="never_promise"
          rows={4}
          defaultValue={values.never_promise}
          invalid={neverError !== undefined}
          describedBy={describe('never_promise', true, neverError)}
        />
      </Field>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 text-base font-semibold">Common questions (optional)</legend>
        <p className="text-sm text-neutral-700 dark:text-neutral-300">Up to {limits.faqs}. Drafts use these answers when a lead asks.</p>
        {values.faqs.slice(0, shownFaqs).map((faq, index) => faqRow(faq, index))}
        {shownFaqs < values.faqs.length ? (
          <details className="rounded-lg">
            <summary className="min-h-11 cursor-pointer py-2 text-base font-medium underline underline-offset-4">Add more questions</summary>
            <div className="mt-3 flex flex-col gap-4">{values.faqs.slice(shownFaqs).map((faq, offset) => faqRow(faq, shownFaqs + offset))}</div>
          </details>
        ) : null}
      </fieldset>

      <fieldset className="flex flex-col gap-3" aria-describedby={bookingError === undefined ? undefined : 'booking-error'}>
        <legend className="mb-1 text-base font-semibold">Booking link</legend>
        <p className="text-sm text-neutral-700 dark:text-neutral-300">Drafts include this link so leads can book a time. Choose one.</p>
        {bookingError === undefined ? null : (
          <p id="booking-error" className="text-sm font-medium text-red-700 dark:text-red-400">
            {bookingError}
          </p>
        )}
        {bookingLink === null ? null : (
          <>
            <input type="hidden" name="booking_link_found" value={bookingLink.url} />
            <BookingOption
              id="booking_found"
              value="found"
              checked={values.booking_choice === 'found'}
              label={bookingLink.source === 'generated' ? `Yes, ${bookingLink.host} is my booking page` : `Keep ${bookingLink.host}`}
              hint={bookingLink.url}
            />
          </>
        )}
        <BookingOption id="booking_other" value="other" checked={values.booking_choice === 'other'} label={bookingLink === null ? 'Use my booking link' : 'Use a different booking link'} />
        <div className="pl-9">
          <Field id="booking_link_other" label="Booking link" hint="Starts with https://" optional error={otherLinkError}>
            <Input
              id="booking_link_other"
              name="booking_link_other"
              type="url"
              inputMode="url"
              spellCheck={false}
              maxLength={2048}
              placeholder="https://"
              defaultValue={values.booking_link_other}
              invalid={otherLinkError !== undefined}
              describedBy={describe('booking_link_other', true, otherLinkError)}
            />
          </Field>
        </div>
        <BookingOption id="booking_none" value="none" checked={values.booking_choice === 'none'} label="I don't use a booking link" />
      </fieldset>

      <SubmitButton pendingLabel="Saving…">Save and continue</SubmitButton>
    </form>
  );
}

function BookingOption({ id, value, checked, label, hint }: { id: string; value: string; checked: boolean; label: string; hint?: string }) {
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="radio"
        name="booking_choice"
        value={value}
        defaultChecked={checked}
        aria-describedby={hint === undefined ? undefined : `${id}-hint`}
        className="mt-0.5 size-6 shrink-0 cursor-pointer accent-neutral-900 dark:accent-neutral-100"
      />
      <div className="flex min-h-11 flex-col">
        <label htmlFor={id} className="cursor-pointer text-base">
          {label}
        </label>
        {hint === undefined ? null : (
          <p id={`${id}-hint`} className="text-sm break-all text-neutral-600 dark:text-neutral-400">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}
