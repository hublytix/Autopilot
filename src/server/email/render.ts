import 'server-only';
import type { ReactElement } from 'react';
import { render, toPlainText } from 'react-email';

// Renders a React Email template to the HTML and plain-text bodies every owner email carries (PLAN
// §8.4, RS-REACT-EMAIL). Both the live Resend mailer and the fake outbox receive exactly this output.
// Templates in src/emails are presentational: they take ready-made, already-sanitised props.

export interface RenderedEmail {
  html: string;
  text: string;
}

export async function renderEmail(element: ReactElement): Promise<RenderedEmail> {
  const html = await render(element);
  return { html, text: toPlainText(html) };
}
