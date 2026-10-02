import { Fragment, type CSSProperties } from 'react';
import { Button, Heading, Link, Section, Text } from 'react-email';
import { Layout } from './Layout';

// The inbox check's test email (PLAN §9.7 step 2, D-14, D-27): a lead email for a test lead whose
// address is the owner's own other address. Until M4 builds /a/{t}/edit and /a/{t}/dismiss it has
// only the send button and the default-mail-app link (law 5: no button that leads nowhere); the
// edit and dismiss buttons render only when the caller passes their URLs (D-62).
// The owner taps "Send from my email", sends the draft from their own mailbox, then replies to it
// from the other address; the `inbox_check` job looks for both in HubSpot. It opens with the
// "isn't monitored" line every lead email carries (D-27). Honest copy (law 5): it says plainly
// that this is a test. Presentational only: the caller passes ready-made text and URLs; the
// address shown is the owner's own.

export function inboxTestSubject(productName: string): string {
  return `${productName} inbox check: your test reply is ready`;
}

export interface InboxTestProps {
  /** PRODUCT_NAME. */
  productName: string;
  /** The owner's other address (the test lead's address). */
  testAddress: string;
  /** The test lead's message (fixed template text). */
  leadMessage: string;
  draftSubject: string;
  /** Plain text; line breaks are kept. */
  draftBody: string;
  /** `/a/{send token}/send`. */
  sendUrl: string;
  /** `/a/{send token}/send?via=mailto`: the default mail app. */
  mailtoUrl: string;
  /** `/a/{edit token}/edit`; M4. Without it the button is left out. */
  editUrl?: string | undefined;
  /** `/a/{dismiss token}/dismiss`; M4. Without it the button is left out. */
  dismissUrl?: string | undefined;
  /** The setup page that shows the result (`/onboarding/inbox`). */
  checkUrl: string;
}

const notice: CSSProperties = { margin: '0 0 16px', fontSize: '14px', lineHeight: '20px', color: '#52525b' };
const heading: CSSProperties = { margin: '0 0 16px', fontSize: '22px', lineHeight: '28px', fontWeight: 600 };
const subheading: CSSProperties = { margin: '24px 0 8px', fontSize: '16px', lineHeight: '24px', fontWeight: 600 };
const paragraph: CSSProperties = { margin: '0 0 12px' };
const quote: CSSProperties = {
  margin: '0 0 16px',
  padding: '8px 12px',
  borderLeft: '3px solid #d4d4d8',
  color: '#3f3f46',
  whiteSpace: 'pre-wrap',
};
const draft: CSSProperties = {
  margin: '0 0 16px',
  padding: '12px',
  border: '1px solid #e4e4e7',
  borderRadius: '6px',
  whiteSpace: 'pre-wrap',
};
const primary: CSSProperties = {
  display: 'inline-block',
  margin: '0 8px 8px 0',
  padding: '12px 20px',
  borderRadius: '6px',
  backgroundColor: '#18181b',
  color: '#ffffff',
  fontSize: '16px',
  fontWeight: 600,
  textDecoration: 'none',
};
const secondary: CSSProperties = {
  ...primary,
  backgroundColor: '#ffffff',
  color: '#18181b',
  border: '1px solid #a1a1aa',
};
const note: CSSProperties = { margin: '16px 0 0', fontSize: '14px', lineHeight: '20px', color: '#52525b' };
const link: CSSProperties = { color: '#1d4ed8', textDecoration: 'underline' };

export function InboxTest(props: InboxTestProps) {
  const { productName, testAddress } = props;
  return (
    <Layout productName={productName} preview={`A test lead from your ${productName} inbox check. Tap "Send from my email", then answer it from your other address.`}>
      <Text style={notice}>This email isn&apos;t monitored. To run the test, tap &quot;Send from my email&quot;.</Text>
      <Heading as="h1" style={heading}>
        Your inbox check: a test lead
      </Heading>
      <Text style={paragraph}>
        This is a test, not a real lead. It looks like the emails {productName} sends you for real leads, and it checks that
        HubSpot logs your email.
      </Text>
      <Text style={paragraph}>1. Tap &quot;Send from my email&quot; and send your reply from your usual mailbox. Keep the recipient: {testAddress}.</Text>
      <Text style={paragraph}>2. Open {testAddress} and answer that email. A short answer is fine.</Text>
      <Text style={paragraph}>3. Go back to the setup page. We check HubSpot every minute for about 10 minutes.</Text>

      <Text style={subheading}>Test lead</Text>
      <Text style={paragraph}>
        {testAddress}
      </Text>
      <Text style={quote}>{props.leadMessage}</Text>

      <Text style={subheading}>Your reply</Text>
      <Section style={draft}>
        <Text style={{ margin: '0 0 8px', fontWeight: 600 }}>{props.draftSubject}</Text>
        <Text style={{ margin: 0 }}>
          {props.draftBody.split('\n').map((line, index) => (
            <Fragment key={index}>
              {index > 0 ? <br /> : null}
              {line}
            </Fragment>
          ))}
        </Text>
      </Section>

      <Section>
        <Button href={props.sendUrl} style={primary}>
          Send from my email
        </Button>
      </Section>
      {props.editUrl === undefined ? null : (
        <Section>
          <Button href={props.editUrl} style={secondary}>
            Edit first
          </Button>
        </Section>
      )}
      {props.dismissUrl === undefined ? null : (
        <Section>
          <Button href={props.dismissUrl} style={secondary}>
            Not a real lead
          </Button>
        </Section>
      )}
      <Text style={note}>
        <Link href={props.mailtoUrl} style={link}>
          Open in default mail app
        </Link>
      </Text>
      <Text style={note}>
        See the result on the{' '}
        <Link href={props.checkUrl} style={link}>
          setup page
        </Link>
        .
      </Text>
    </Layout>
  );
}
