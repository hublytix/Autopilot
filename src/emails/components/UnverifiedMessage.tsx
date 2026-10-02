import { Text } from 'react-email';
import { Lines } from './Lines';
import { paragraph, quote, subheading } from './styles';

// The lead's own message, quoted under "Message from the lead (unverified)" (D-47): anyone can type
// anything into a public form, so it is labelled as unverified and shown defanged (the caller passes
// it already cleaned: controls removed, addresses defanged). Line breaks are kept.

export const UNVERIFIED_MESSAGE_HEADING = 'Message from the lead (unverified)';

export interface UnverifiedMessageProps {
  /** Defanged message text; null or empty when the form had none. */
  message: string | null;
}

export function UnverifiedMessage({ message }: UnverifiedMessageProps) {
  const text = message?.trim() ?? '';
  return (
    <>
      <Text style={subheading}>{UNVERIFIED_MESSAGE_HEADING}</Text>
      {text === '' ? (
        <Text style={paragraph}>The form had no message.</Text>
      ) : (
        <Text style={quote}>
          <Lines text={text} />
        </Text>
      )}
    </>
  );
}
