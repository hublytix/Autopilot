import { Button, Section } from 'react-email';
import { MailtoLink } from './MailtoLink';
import { primaryButton, secondaryButton } from './styles';

// The three buttons of a lead email (brief §5.5, PLAN §7.4, D-13, D-26, D-45), each an action link
// with its own token: "Send from my email" opens the owner's own mail app pre-filled (law 1: we never
// send), "Edit first" opens the editable draft, "Not a real lead" asks to confirm a dismissal (a link
// scanner's GET changes nothing). Below them, the "Open in default mail app" link (D-13).

export const BUTTON_LABELS = { send: 'Send from my email', edit: 'Edit first', dismiss: 'Not a real lead' } as const;

export interface ActionLinks {
  /** `/a/{send token}/send`. */
  sendUrl: string;
  /** `/a/{edit token}/edit`. */
  editUrl: string;
  /** `/a/{dismiss token}/dismiss`. */
  dismissUrl: string;
  /** `/a/{send token}/send?via=mailto`. */
  mailtoUrl: string;
}

export function ActionButtons({ sendUrl, editUrl, dismissUrl, mailtoUrl }: ActionLinks) {
  return (
    <Section style={{ margin: '8px 0 0' }}>
      {/* One button per row: easy to tap on a phone, and one link per line in the plain-text part. */}
      <Section>
        <Button href={sendUrl} style={primaryButton}>
          {BUTTON_LABELS.send}
        </Button>
      </Section>
      <Section>
        <Button href={editUrl} style={secondaryButton}>
          {BUTTON_LABELS.edit}
        </Button>
      </Section>
      <Section>
        <Button href={dismissUrl} style={secondaryButton}>
          {BUTTON_LABELS.dismiss}
        </Button>
      </Section>
      <MailtoLink href={mailtoUrl} />
    </Section>
  );
}
