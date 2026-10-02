import type { CSSProperties } from 'react';
import { Button, Heading, Link, Text } from 'react-email';
import { Layout } from './Layout';

// The confirmation email for an extra lead-alert address (D-46, PLAN §8.4 `verify_notify`). The
// address receives nothing else until someone opens the link and confirms on the page it leads to
// (opening the link alone changes nothing, so mail scanners cannot confirm it). Honest copy (law 5):
// what happens, how long the link works, and that ignoring it is safe. Presentational only: the
// caller builds the URL; nothing here is logged.

export function verifyNotifySubject(productName: string): string {
  return `Confirm lead alerts from ${productName}`;
}

export interface VerifyNotifyProps {
  /** PRODUCT_NAME. */
  productName: string;
  /** The owner's saved business name, when they have saved their brief; null otherwise. */
  businessName: string | null;
  /** `${APP_URL}/a/<token>/verify-notify`. */
  url: string;
  /** How long the link works, in days. */
  validDays: number;
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

export function VerifyNotify({ productName, businessName, url, validDays }: VerifyNotifyProps) {
  const who = businessName === null ? `Someone using ${productName}` : `${businessName}, using ${productName},`;
  return (
    <Layout productName={productName} preview="Confirm this address to receive new-lead alerts. Nothing is sent here until you do.">
      <Heading as="h1" style={heading}>
        Confirm this address for lead alerts
      </Heading>
      <Text style={paragraph}>
        {who} added this email address to receive alerts about new leads from their website forms. Nothing will be sent here
        until you confirm.
      </Text>
      <Button href={url} style={button}>
        Review and confirm
      </Button>
      <Text style={note}>
        The link works for {validDays} days. If you don&apos;t recognise this, ignore this email: no alerts will be sent to
        this address.
      </Text>
      <Text style={fallback}>
        If the button doesn&apos;t work, open this link: <Link href={url}>{url}</Link>
      </Text>
    </Layout>
  );
}
