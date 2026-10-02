import type { CSSProperties } from 'react';
import { Button, Heading, Link, Text } from 'react-email';
import { Layout } from './Layout';

// The sign-in email (D-22): a one-time link to `/auth/confirm`, with the token in the URL fragment.
// Sent by our own Mailer (never by Supabase) for a login, the onboarding email step, and branch (d)
// of the HubSpot callback ("sign in to finish reconnecting"). Honest copy (law 5): the link works
// once, for 1 hour, and an unexpected email can be ignored. An onboarding link names the HubSpot
// account it sets up (anyone can install the app and type any address), so the reader can tell a
// stranger's portal from their own. Presentational only: the caller builds the URL and the portal
// label; nothing here is logged.

export type MagicLinkVariant = 'sign_in' | 'onboarding' | 'reconnect';

export function magicLinkSubject(variant: MagicLinkVariant, productName: string): string {
  switch (variant) {
    case 'sign_in':
      return `Your sign-in link for ${productName}`;
    case 'onboarding':
      return `Confirm your email for ${productName}`;
    case 'reconnect':
      return `Sign in to finish reconnecting HubSpot to ${productName}`;
  }
}

export interface MagicLinkProps {
  /** PRODUCT_NAME. */
  productName: string;
  variant: MagicLinkVariant;
  /** `${APP_URL}/auth/confirm#th=…&type=email`. */
  url: string;
  /** Onboarding only: the HubSpot account being set up, e.g. "brightside.example (ID 4400123)" or "with ID 4400123". */
  portal?: string | null | undefined;
}

const heading: CSSProperties = { margin: '0 0 16px', fontSize: '22px', lineHeight: '28px', fontWeight: 600 };
const paragraph: CSSProperties = { margin: '0 0 16px' };
const note: CSSProperties = { margin: '16px 0 0', fontSize: '14px', lineHeight: '20px', color: '#52525b' };
const fallback: CSSProperties = { margin: '8px 0 0', fontSize: '13px', lineHeight: '20px', color: '#52525b', wordBreak: 'break-all' };
const button: CSSProperties = {
  display: 'inline-block',
  padding: '12px 20px',
  borderRadius: '6px',
  backgroundColor: '#18181b',
  color: '#ffffff',
  fontSize: '16px',
  fontWeight: 600,
  textDecoration: 'none',
};

const COPY: Record<MagicLinkVariant, { heading: (productName: string) => string; body: (productName: string, portal: string | null) => string; button: string }> = {
  sign_in: {
    heading: (productName) => `Sign in to ${productName}`,
    body: () => 'Tap the button below to sign in. There is no password: this link is how you sign in.',
    button: 'Sign in',
  },
  onboarding: {
    heading: () => 'Confirm your email',
    body: (productName, portal) =>
      portal === null
        ? `Tap the button below to confirm this is your email and continue setting up ${productName}. You can open it on any device.`
        : `Tap the button below to confirm this is your email and continue setting up ${productName} for the HubSpot account ${portal}. You can open it on any device.`,
    button: 'Confirm and continue',
  },
  reconnect: {
    heading: () => 'Sign in to finish reconnecting',
    body: (productName) =>
      `You tried to reconnect HubSpot to ${productName}. Nothing has changed yet. Sign in with the button below, then tap Reconnect on your dashboard.`,
    button: 'Sign in',
  },
};

export function MagicLink({ productName, variant, url, portal }: MagicLinkProps) {
  const copy = COPY[variant];
  const portalLabel = variant === 'onboarding' ? (portal ?? null) : null;
  return (
    <Layout productName={productName} preview={`${copy.heading(productName)}. The link works once and expires in 1 hour.`}>
      <Heading as="h1" style={heading}>
        {copy.heading(productName)}
      </Heading>
      <Text style={paragraph}>{copy.body(productName, portalLabel)}</Text>
      <Button href={url} style={button}>
        {copy.button}
      </Button>
      <Text style={note}>This link works once and expires in 1 hour.</Text>
      {portalLabel === null ? null : (
        <Text style={note}>
          Not your HubSpot account? Don&apos;t tap the button. Someone else typed your address while setting up {productName}; ignore this
          email and nothing happens.
        </Text>
      )}
      <Text style={note}>If you didn&apos;t ask for this email, you can ignore it. Nobody can sign in without the link.</Text>
      <Text style={fallback}>
        Button not working? Open this address in your browser: <Link href={url}>{url}</Link>
      </Text>
    </Layout>
  );
}
