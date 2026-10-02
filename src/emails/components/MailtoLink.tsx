import { Link, Text } from 'react-email';
import { link, note } from './styles';

// D-13: every three-button email also has an "Open in default mail app" link
// (`/a/{send token}/send?via=mailto`), for owners whose mail app is not Gmail or Outlook on the web.

export const MAILTO_LINK_LABEL = 'Open in default mail app';

export function MailtoLink({ href }: { href: string }) {
  return (
    <Text style={note}>
      <Link href={href} style={link}>
        {MAILTO_LINK_LABEL}
      </Link>
    </Text>
  );
}
