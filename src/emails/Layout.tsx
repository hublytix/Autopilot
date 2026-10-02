import type { CSSProperties, ReactNode } from 'react';
import { Body, Container, Head, Hr, Html, Preview, Section, Text } from 'react-email';

// The shared layout of every owner email: presentational only (no server imports), mobile-first
// (one fluid column, max 560 px), readable type (16 px body, high-contrast colours) and plain
// semantics, so screen readers and plain-text rendering both work. Copy follows the product laws:
// the footer states that the product never sends email on the owner's behalf.

export interface LayoutProps {
  /** PRODUCT_NAME, passed in by the caller. */
  productName: string;
  /** The inbox preview line; plain text. */
  preview?: string | undefined;
  children: ReactNode;
}

const body: CSSProperties = {
  margin: 0,
  padding: '16px 0',
  backgroundColor: '#f4f4f5',
  color: '#18181b',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  fontSize: '16px',
  lineHeight: '24px',
};

const container: CSSProperties = {
  width: '100%',
  maxWidth: '560px',
  margin: '0 auto',
  padding: '24px 16px',
  backgroundColor: '#ffffff',
  borderRadius: '8px',
};

const brand: CSSProperties = {
  margin: '0 0 16px',
  fontSize: '14px',
  lineHeight: '20px',
  fontWeight: 600,
  color: '#3f3f46',
};

const rule: CSSProperties = {
  margin: '24px 0 16px',
  borderColor: '#e4e4e7',
};

const footer: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  lineHeight: '20px',
  color: '#52525b',
};

export function Layout({ productName, preview, children }: LayoutProps) {
  return (
    <Html lang="en" dir="ltr">
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
      </Head>
      {preview === undefined || preview.length === 0 ? null : <Preview>{preview}</Preview>}
      <Body style={body}>
        <Container style={container}>
          <Text style={brand}>{productName}</Text>
          <Section>{children}</Section>
          <Hr style={rule} />
          <Text style={footer}>{productName} prepares drafts; it never sends email on your behalf.</Text>
        </Container>
      </Body>
    </Html>
  );
}
