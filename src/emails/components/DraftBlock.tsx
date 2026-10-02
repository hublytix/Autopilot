import { Section, Text } from 'react-email';
import { Lines } from './Lines';
import { draftBody, draftBox, draftSubject, subheading } from './styles';

// The prepared reply: its subject and plain-text body (the validator allows no HTML or markdown),
// line breaks kept. The owner sends it from their own mailbox (law 1).

export interface DraftBlockProps {
  /** Default "Your reply". */
  title?: string | undefined;
  subject: string;
  body: string;
}

export function DraftBlock({ title, subject, body }: DraftBlockProps) {
  return (
    <>
      <Text style={subheading}>{title ?? 'Your reply'}</Text>
      <Section style={draftBox}>
        <Text style={draftSubject}>Subject: {subject}</Text>
        <Text style={draftBody}>
          <Lines text={body} />
        </Text>
      </Section>
    </>
  );
}
