import type { CSSProperties } from 'react';
import { Button, Heading, Text } from 'react-email';
import { Layout } from './Layout';

// Sent once when HubSpot stops accepting the connection (a refresh classified `revoked`, or the daily
// introspection probe; D-10, PLAN §9.1). Honest copy (law 5): processing has stopped, the account's
// data is deleted on the purge date unless the owner reconnects, and reconnecting needs the right
// HubSpot permission. Presentational only: every prop is ready-made by the caller.

export const RECONNECT_HUBSPOT_SUBJECT = 'Reconnect HubSpot to keep Autopilot running';

export interface ReconnectHubSpotProps {
  /** PRODUCT_NAME. */
  productName: string;
  /** Starts the HubSpot install again (`{APP_URL}/api/hubspot/install`). */
  reconnectUrl: string;
  /** The purge date in the account's timezone, e.g. "November 5, 2026"; null when unknown. */
  purgeDate: string | null;
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

export function ReconnectHubSpot({ productName, reconnectUrl, purgeDate }: ReconnectHubSpotProps) {
  const deadline = purgeDate === null ? 'in 30 days' : `on ${purgeDate}`;
  return (
    <Layout productName={productName} preview={`HubSpot disconnected: ${productName} has stopped. Reconnect to keep it running.`}>
      <Heading as="h1" style={heading}>
        Reconnect HubSpot
      </Heading>
      <Text style={paragraph}>
        HubSpot no longer accepts {productName}&apos;s access to your account: the app was uninstalled or its access was
        revoked. {productName} has stopped checking for new leads and drafting replies.
      </Text>
      <Text style={paragraph}>
        If you don&apos;t reconnect, we delete your {productName} data for this HubSpot account {deadline}. Reconnecting
        before then keeps your settings and leads, and {productName} starts again.
      </Text>
      <Button href={reconnectUrl} style={button}>
        Reconnect HubSpot
      </Button>
      <Text style={note}>Reconnecting needs a HubSpot Super Admin, or a user with App Marketplace Access.</Text>
    </Layout>
  );
}
