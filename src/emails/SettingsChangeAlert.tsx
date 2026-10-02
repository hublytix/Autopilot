import type { CSSProperties } from 'react';
import { Button, Heading, Text } from 'react-email';
import { Layout } from './Layout';

// The owner alert sent when the lead-alert addresses or the BCC address change after onboarding
// (D-46, PLAN §8.4 `owner_alert`). It goes to the owner's own sign-in address only, and shows the
// settings as they are now, so a change the owner did not make is easy to spot. Presentational only:
// the caller passes the current values; nothing here is logged.

export function settingsChangeAlertSubject(productName: string): string {
  return `Your ${productName} alert settings changed`;
}

export interface SettingsChangeAlertAddress {
  address: string;
  /** False while the address is waiting for its confirmation (it gets nothing until then). */
  confirmed: boolean;
}

export interface SettingsChangeAlertProps {
  /** PRODUCT_NAME. */
  productName: string;
  /** When the change was saved, already formatted in the account's timezone. */
  changedOn: string;
  notifyAddresses: readonly SettingsChangeAlertAddress[];
  bccAddress: string | null;
  /** The settings page; the owner signs in first if needed. */
  settingsUrl: string;
}

const heading: CSSProperties = { margin: '0 0 16px', fontSize: '22px', lineHeight: '28px', fontWeight: 600 };
const paragraph: CSSProperties = { margin: '0 0 16px' };
const label: CSSProperties = { margin: '0 0 4px', fontWeight: 600 };
const item: CSSProperties = { margin: '0 0 4px', wordBreak: 'break-all' };
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

export function SettingsChangeAlert({ productName, changedOn, notifyAddresses, bccAddress, settingsUrl }: SettingsChangeAlertProps) {
  return (
    <Layout productName={productName} preview={`The addresses for your ${productName} alerts or your BCC address changed on ${changedOn}.`}>
      <Heading as="h1" style={heading}>
        Your alert settings changed
      </Heading>
      <Text style={paragraph}>
        On {changedOn}, the addresses that get your lead alerts, or your BCC address, were changed. This is how they are set now.
      </Text>
      <Text style={label}>Lead alerts go to</Text>
      {notifyAddresses.map((entry) => (
        <Text key={entry.address} style={item}>
          {entry.address}
          {entry.confirmed ? '' : ' (waiting for confirmation: gets nothing until confirmed)'}
        </Text>
      ))}
      <Text style={{ ...label, marginTop: '16px' }}>BCC address</Text>
      <Text style={item}>{bccAddress ?? 'None'}</Text>
      <Text style={{ ...paragraph, marginTop: '16px' }}>
        If you made this change, there&apos;s nothing to do. If you didn&apos;t, sign in and check your settings.
      </Text>
      <Button href={settingsUrl} style={button}>
        Review your settings
      </Button>
    </Layout>
  );
}
