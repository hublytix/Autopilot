import { Section, Text } from 'react-email';
import { cardLabel, cardLine, subheading } from './styles';

// The lead's name, company and email address (D-31's stored fields). Every value comes from a public
// form, so the caller passes it already cleaned and defanged (D-47): controls removed, web and email
// addresses written so no mail client turns them into links.

export interface LeadCardProps {
  /** First and last name, defanged; null when the form gave none. */
  name: string | null;
  /** Defanged; null when the form gave none. */
  company: string | null;
  /** The lead's address, defanged; null when missing. */
  email: string | null;
}

export function LeadCard({ name, company, email }: LeadCardProps) {
  return (
    <Section>
      <Text style={subheading}>The lead</Text>
      <Text style={cardLine}>
        <span style={cardLabel}>Name: </span>
        {name ?? 'Not given'}
      </Text>
      {company === null ? null : (
        <Text style={cardLine}>
          <span style={cardLabel}>Company: </span>
          {company}
        </Text>
      )}
      <Text style={cardLine}>
        <span style={cardLabel}>Email: </span>
        {email ?? 'Not given'}
      </Text>
    </Section>
  );
}
