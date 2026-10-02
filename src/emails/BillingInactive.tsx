import type { CSSProperties } from 'react';
import { Button, Heading, Text } from 'react-email';
import { Layout } from './Layout';

// Sent once per non-entitled period, on the → inactive transition (PLAN §6.1, D-18, D-48). Minimal
// for now; M7 polishes the copy with the billing page. Honest (law 5): processing has stopped, leads
// that arrive meanwhile are not drafted later, and nothing is deleted because of billing.

export interface BillingInactiveProps {
  /** PRODUCT_NAME. */
  productName: string;
  /** `{APP_URL}/dashboard/billing`. */
  billingUrl: string;
}

export function billingInactiveSubject(productName: string): string {
  return `Your ${productName} trial or subscription isn't active`;
}

const heading: CSSProperties = { margin: '0 0 16px', fontSize: '22px', lineHeight: '28px', fontWeight: 600 };
const paragraph: CSSProperties = { margin: '0 0 16px' };
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

export function BillingInactive({ productName, billingUrl }: BillingInactiveProps) {
  return (
    <Layout productName={productName} preview={`${productName} has stopped drafting replies.`}>
      <Heading as="h1" style={heading}>
        {productName} has stopped
      </Heading>
      <Text style={paragraph}>
        Your free trial has ended or your subscription isn&apos;t active, so {productName} has stopped drafting replies
        for new leads. Leads that arrive while it is stopped won&apos;t be drafted later.
      </Text>
      <Text style={paragraph}>Your settings and brief are kept. To start again, subscribe or update your payment method.</Text>
      <Button href={billingUrl} style={button}>
        Open billing
      </Button>
    </Layout>
  );
}
