import type { CSSProperties } from 'react';
import { Button, Heading, Text } from 'react-email';
import { Layout } from './Layout';

// A short security or settings alert to the owner (PLAN §8.4 `owner_alert`): reconnect attempts by
// someone else (D-35) now; settings changes later (D-46). Presentational only: the caller supplies
// the fixed copy for the alert kind; it never contains lead content or another person's address.

export interface OwnerAlertProps {
  /** PRODUCT_NAME. */
  productName: string;
  heading: string;
  /** Plain-text paragraphs. */
  paragraphs: readonly string[];
  /** An optional call to action, e.g. "Sign in". */
  action?: { label: string; url: string } | undefined;
}

const headingStyle: CSSProperties = { margin: '0 0 16px', fontSize: '22px', lineHeight: '28px', fontWeight: 600 };
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

export function OwnerAlert({ productName, heading, paragraphs, action }: OwnerAlertProps) {
  return (
    <Layout productName={productName} preview={paragraphs[0]}>
      <Heading as="h1" style={headingStyle}>
        {heading}
      </Heading>
      {paragraphs.map((text, index) => (
        <Text key={index} style={paragraph}>
          {text}
        </Text>
      ))}
      {action === undefined ? null : (
        <Button href={action.url} style={button}>
          {action.label}
        </Button>
      )}
    </Layout>
  );
}
