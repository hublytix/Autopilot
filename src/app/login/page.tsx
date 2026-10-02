import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Card, Field, fieldDescription, Input, Page, SubmitButton } from '@/components/ui';
import { loginAction } from '@/server/actions/auth/login';

// /login (PLAN §7.2, D-22): one email field. Whatever happens, the page afterwards says the same
// thing, so it never reveals whether an address has an account.

const productName = process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'Hublytix Autopilot';

export const metadata: Metadata = {
  title: 'Sign in',
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const sent = params.sent === '1';
  const signedOut = params.signed_out === '1';
  return (
    <Page
      centered
      eyebrow={productName}
      title="Sign in"
      description="We'll email you a one-time sign-in link. There is no password."
    >
      {sent ? (
        <Alert tone="success" title="Check your email">
          <p>If that email can sign in, we&apos;ve sent a link. It works once and expires in 1 hour.</p>
          <p>Nothing arrived after a few minutes? Check your spam folder, or try again below.</p>
        </Alert>
      ) : null}
      {signedOut ? <Alert tone="info">You&apos;re signed out.</Alert> : null}
      <Card>
        <form action={loginAction} className="flex flex-col gap-4">
          <Field id="email" label="Email" hint={`Use the email you set up ${productName} with.`}>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              required
              maxLength={254}
              describedBy={fieldDescription('email', { hint: true })}
            />
          </Field>
          <SubmitButton pendingLabel="Sending…">Email me a sign-in link</SubmitButton>
        </form>
      </Card>
      <p className="text-sm text-neutral-700 dark:text-neutral-300">
        New here? Setup starts from HubSpot.{' '}
        <Link href="/" className="font-medium underline underline-offset-4">
          Install {productName}
        </Link>
      </p>
    </Page>
  );
}
