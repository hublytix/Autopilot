import type { CSSProperties } from 'react';
import { Button, Heading, Text } from 'react-email';
import { Layout } from './Layout';

// The daily lead cap email (D-36, PLAN §8.4 `lead_cap`, key `cap:{acct}:{localDate}`): sent once per
// local day when the account reaches MAX_DRAFTED_LEADS_PER_DAY drafted leads. Honest (law 5): leads
// over the limit are not drafted (now or later); they are listed on the dashboard. Presentational
// only: no lead content, names or addresses.

export interface LeadCapReachedProps {
  /** PRODUCT_NAME. */
  productName: string;
  /** MAX_DRAFTED_LEADS_PER_DAY. */
  limit: number;
  /** `{APP_URL}/dashboard`. */
  dashboardUrl: string;
}

export function leadCapReachedSubject(productName: string, limit: number): string {
  return `${productName}: today's limit of ${limit} drafted leads reached`;
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

export function LeadCapReached({ productName, limit, dashboardUrl }: LeadCapReachedProps) {
  const reached = `You've reached today's limit of ${limit} drafted leads.`;
  return (
    <Layout productName={productName} preview={reached}>
      <Heading as="h1" style={heading}>
        Today&apos;s lead limit is reached
      </Heading>
      <Text style={paragraph}>
        {reached} The rest of today&apos;s leads are listed on your dashboard, not drafted, and you won&apos;t get an
        email for each of them.
      </Text>
      <Text style={paragraph}>Leads that arrive tomorrow are drafted as usual.</Text>
      <Button href={dashboardUrl} style={button}>
        Open your dashboard
      </Button>
    </Layout>
  );
}
