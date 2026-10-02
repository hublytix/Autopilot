import type { Metadata } from 'next';
import { Card, LinkButton, Page } from '@/components/ui';
import type { AuthErrorReason } from '@/server/http/auth/confirm';

// Where POST /auth/confirm lands when it cannot sign anyone in (PLAN §7.2, §9.1 step 2). The reason
// is a code; nothing about the link or the address is in the URL.

const productName = process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'Hublytix Autopilot';

export const metadata: Metadata = {
  title: 'Sign-in link',
  robots: { index: false, follow: false },
};

const COPY: Record<AuthErrorReason, { title: string; body: string; action: { label: string; href: string } }> = {
  link: {
    title: 'This link has expired or was already used',
    body: 'Sign-in links work once and expire after 1 hour. Ask for a new one and use the newest email.',
    action: { label: 'Get a new link', href: '/login' },
  },
  already_owner: {
    title: `This email already owns a ${productName} account`,
    body: `Each email can own one ${productName} account. Sign in to that account, or set this one up with a different email.`,
    action: { label: 'Sign in', href: '/login' },
  },
  unavailable: {
    title: "We couldn't sign you in just now",
    body: 'Something went wrong on our side. Open the link in the email again in a minute. If it says the link has expired, ask for a new one.',
    action: { label: 'Get a new link', href: '/login' },
  },
  setup: {
    title: "This link can't finish setup",
    body: "The setup email changed since this link was sent, or setup was finished in another way. Use the newest email we sent, or ask for a new link.",
    action: { label: 'Get a new link', href: '/login' },
  },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function isReason(value: unknown): value is AuthErrorReason {
  return typeof value === 'string' && Object.hasOwn(COPY, value);
}

export default async function AuthErrorPage({ searchParams }: { searchParams: SearchParams }) {
  const { reason } = await searchParams;
  const copy = COPY[isReason(reason) ? reason : 'link'];
  return (
    <Page centered eyebrow={productName} title={copy.title}>
      <Card>
        <p className="text-base text-neutral-700 dark:text-neutral-300">{copy.body}</p>
        <LinkButton href={copy.action.href}>{copy.action.label}</LinkButton>
      </Card>
    </Page>
  );
}
