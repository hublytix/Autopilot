import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Card, LinkButton, Page } from '@/components/ui';
import { getDeps } from '@/server/container';
import { requireOwnerPage } from '@/server/http/auth/guards';
import { BILLING_PATH, openCheckoutLink } from '@/server/views/billing';
import { CONTINUE_TEXT } from '../copy';
import { AutoContinue } from './auto-continue';

// /dashboard/billing/checkout (PLAN §9.9 step 5, D-20): where Subscribe lands. It reads the owner's
// open checkout (the one just created or reused) from our database and sends the browser on to its
// Razorpay link: automatically, and with a link for anyone without JavaScript. The form POST itself
// never redirects to Razorpay, because CSP form-action 'self' also applies to the redirects after a
// form submission (D-56). No link from the query string is ever followed: only the stored one.

export const metadata: Metadata = {
  title: 'Continue to Razorpay',
  robots: { index: false, follow: false },
};

export default async function BillingCheckoutPage() {
  const requestHeaders = await headers();
  const deps = await getDeps();
  const scope = await requireOwnerPage(deps, requestHeaders);
  const link = await openCheckoutLink(deps, scope);

  if (link === null) {
    return (
      <Page title={CONTINUE_TEXT.missingTitle}>
        <Card>
          <p className="text-neutral-700 dark:text-neutral-300">{CONTINUE_TEXT.missing}</p>
          <LinkButton href={BILLING_PATH}>{CONTINUE_TEXT.back}</LinkButton>
        </Card>
      </Page>
    );
  }

  return (
    <Page title={CONTINUE_TEXT.title} description={CONTINUE_TEXT.description}>
      <Card>
        <p className="text-neutral-700 dark:text-neutral-300" role="status">
          {CONTINUE_TEXT.automatic}
        </p>
        <LinkButton href={link} plain>
          {CONTINUE_TEXT.button}
        </LinkButton>
        <LinkButton href={BILLING_PATH} variant="ghost">
          {CONTINUE_TEXT.back}
        </LinkButton>
      </Card>
      <AutoContinue href={link} />
    </Page>
  );
}
