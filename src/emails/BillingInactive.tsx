import type { CSSProperties } from 'react';
import { Button, Heading, Text } from 'react-email';
import { Layout } from './Layout';

// Sent once per non-entitled period, on the → inactive transition (PLAN §6.1, §8.4, D-18, D-48), to
// the owner, Reply-To EMAIL_REPLY_TO (D-27). Honest (laws 3 and 5): processing has stopped, nothing
// is drafted while it is stopped and leads that arrive meanwhile are not drafted later; settings and
// the brief are kept and nothing is deleted because of billing; the button opens the billing page,
// where the owner subscribes again or updates the payment method.

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
const note: CSSProperties = { margin: '16px 0 0', fontSize: '14px', lineHeight: '20px', color: '#52525b' };
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
    <Layout productName={productName} preview={`${productName} has stopped: your trial or subscription isn't active.`}>
      <Heading as="h1" style={heading}>
        {productName} has stopped
      </Heading>
      <Text style={paragraph}>
        Your free trial has ended or your subscription isn&apos;t active, so {productName} has stopped checking HubSpot for
        new leads and stopped drafting your replies.
      </Text>
      <Text style={paragraph}>
        While it&apos;s stopped, nothing is drafted: new leads get no draft, and no follow-up drafts are emailed to you.
        Leads that arrive in the meantime won&apos;t be drafted later, so check new form submissions in HubSpot.
      </Text>
      <Text style={paragraph}>
        Your brief and settings are kept, and nothing is deleted because of billing. To start again, subscribe or update
        your payment method on the billing page. {productName} picks up new leads from then on.
      </Text>
      <Button href={billingUrl} style={button}>
        Open billing
      </Button>
      <Text style={note}>A subscription is $49/month. Payments are handled by Razorpay.</Text>
    </Layout>
  );
}
