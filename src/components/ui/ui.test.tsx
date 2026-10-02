import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Alert } from './Alert';
import { Button } from './Button';
import { Checkbox, Field, fieldDescription, Input } from './Field';
import { Page } from './Page';
import { currentStepIndex, Steps } from './Steps';

// The UI kit's accessibility contract: labels tied to controls, descriptions and errors announced,
// 44 px targets, one h1 per page, and the current onboarding step marked for assistive tech.

const STEPS = [
  { label: 'Your email', href: '/onboarding/email' },
  { label: 'Your business', href: '/onboarding/brief' },
  { label: 'Forms', href: '/onboarding/forms' },
];

describe('Steps', () => {
  it('marks the current step with aria-current and says where you are', () => {
    const html = renderToStaticMarkup(<Steps steps={STEPS} current={1} label="Setup progress" />);
    expect(html).toContain('aria-label="Setup progress"');
    expect(html).toContain('Step 2 of 3');
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toContain('Done: </span>Your email');
    expect(html).toContain('Current: </span>Your business');
  });

  it('finds the current step from the path, including pages below a step', () => {
    expect(currentStepIndex(STEPS, '/onboarding/email')).toBe(0);
    expect(currentStepIndex(STEPS, '/onboarding/brief/edit')).toBe(1);
    expect(currentStepIndex(STEPS, '/onboarding/briefcase')).toBe(-1);
    expect(currentStepIndex(STEPS, '/dashboard')).toBe(-1);
  });
});

describe('form fields', () => {
  it('ties the label, hint and error to the control', () => {
    const html = renderToStaticMarkup(
      <Field id="email" label="Email" hint="We send a link here." error="Enter a valid email address.">
        <Input id="email" name="email" invalid describedBy={fieldDescription('email', { hint: true, error: true })} />
      </Field>,
    );
    expect(html).toContain('<label for="email"');
    expect(html).toContain('id="email-hint"');
    expect(html).toContain('id="email-error"');
    expect(html).toContain('aria-describedby="email-hint email-error"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('min-h-11');
  });

  it('gives a checkbox a label and a 44 px row', () => {
    const html = renderToStaticMarkup(<Checkbox id="weekends" name="weekends" label="Skip weekends" hint="No follow-ups on Saturday or Sunday." />);
    expect(html).toContain('<label for="weekends"');
    expect(html).toContain('aria-describedby="weekends-hint"');
    expect(html).toContain('min-h-11');
  });

  it('omits aria-describedby when there is nothing to describe', () => {
    expect(fieldDescription('x', {})).toBeUndefined();
  });
});

describe('Page, Button, Alert', () => {
  it('renders exactly one h1', () => {
    const html = renderToStaticMarkup(<Page title="Sign in" description="One link, no password." />);
    expect(html.match(/<h1/g)).toHaveLength(1);
  });

  it('buttons default to type="button" and are 44 px tall', () => {
    const html = renderToStaticMarkup(<Button>Save</Button>);
    expect(html).toContain('type="button"');
    expect(html).toContain('min-h-11');
  });

  it('announces errors at once and other alerts politely', () => {
    expect(renderToStaticMarkup(<Alert tone="error">Nope</Alert>)).toContain('role="alert"');
    expect(renderToStaticMarkup(<Alert tone="success">Sent</Alert>)).toContain('role="status"');
  });
});
