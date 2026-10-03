import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Alert, Card, Field, fieldDescription, Input, LinkButton, Page, SubmitButton } from '@/components/ui';
import { onboardingEmailAction } from '@/server/actions/auth/onboarding-email';
import { getDeps } from '@/server/container';
import { onboardingEmailPageState } from '@/server/http/auth/onboarding-email';
import { ownValue } from '@/shared/own-key';

// /onboarding/email (PLAN §7.5, D-35): the installer confirms which email owns this account. It
// needs this browser's pending_install cookie; the emailed link then works on any device.

const productName = process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'Hublytix Autopilot';

export const metadata: Metadata = {
  title: 'Your email',
  robots: { index: false, follow: false },
};

const ERRORS: Readonly<Record<string, string>> = {
  invalid_email: 'Enter a valid email address, like name@example.com.',
  already_owner: `This email already owns a ${productName} account. Use a different email, or sign in to that account.`,
  rate_limited: 'Too many attempts. Please wait 15 minutes, then try again.',
  too_many_emails: `You've tried 3 different addresses for this install. Use one of them, or install ${productName} again from HubSpot.`,
  send_failed: "We couldn't send the email just now. Please try again in a minute.",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function InstallAgain({ title, body }: { title: string; body: string }) {
  return (
    <Page title={title} description={body}>
      <div className="flex flex-col gap-3 sm:flex-row">
        <LinkButton href="/">Install {productName}</LinkButton>
        <LinkButton href="/login" variant="secondary">
          Sign in
        </LinkButton>
      </div>
    </Page>
  );
}

export default async function OnboardingEmailPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const requestHeaders = await headers();
  const state = await onboardingEmailPageState(await getDeps(), requestHeaders);

  if (state.type === 'no_install') {
    return (
      <InstallAgain
        title="Start from HubSpot"
        body={`This step needs the browser you installed ${productName} in, within 24 hours of installing. Install it again from HubSpot to continue, or sign in if you've finished setup.`}
      />
    );
  }
  if (state.type === 'superseded') {
    return (
      <InstallAgain
        title="This setup page is out of date"
        body={`${productName} was installed again for this HubSpot account, so this page no longer applies. Continue from the newest install, or install again.`}
      />
    );
  }
  if (state.type === 'already_set_up') {
    return (
      <Page title="This account is already set up" description={`This HubSpot account already has a ${productName} owner. Sign in with that email.`}>
        <LinkButton href="/login">Sign in</LinkButton>
      </Page>
    );
  }

  const sent = params.sent === '1' || state.linkSent;
  const errorCode = typeof params.error === 'string' ? params.error : undefined;
  const error = ownValue(ERRORS, errorCode);
  return (
    <Page
      title="Which email should own this account?"
      description={`We'll send a sign-in link to this address. You'll sign in with it, and ${productName} sends account emails here. You choose where lead alerts go in a later step.`}
    >
      {sent && error === undefined ? (
        <Alert tone="success" title="Check your email">
          <p>
            We sent a link to <strong className="break-all">{state.email}</strong>. Open it on any device to continue: it works
            once and expires in 1 hour.
          </p>
          <p>Wrong address, or nothing arrived? Change it below and send again.</p>
        </Alert>
      ) : null}
      {error === undefined ? null : <Alert tone="error">{error}</Alert>}
      <Card>
        <form action={onboardingEmailAction} className="flex flex-col gap-4">
          <Field id="email" label="Email" hint="Usually your own work email." error={error}>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              required
              maxLength={254}
              defaultValue={state.email ?? ''}
              invalid={error !== undefined}
              describedBy={fieldDescription('email', { hint: true, error: error !== undefined })}
            />
          </Field>
          <SubmitButton pendingLabel="Sending…">{sent ? 'Send the link again' : 'Send me the link'}</SubmitButton>
        </form>
      </Card>
      <p className="text-sm text-neutral-700 dark:text-neutral-300">
        One email can own one {productName} account.
      </p>
    </Page>
  );
}
