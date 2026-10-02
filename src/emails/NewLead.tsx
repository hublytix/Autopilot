import { Heading } from 'react-email';
import { ActionButtons, type ActionLinks } from './components/ActionButtons';
import { DraftBlock } from './components/DraftBlock';
import { DraftFlags, type DraftFlagCode } from './components/DraftFlags';
import { HonestNotes, initialLoggingNote, type LoggingMode } from './components/HonestNotes';
import { LeadCard, type LeadCardProps } from './components/LeadCard';
import { NotMonitored } from './components/NotMonitored';
import { heading } from './components/styles';
import { UnverifiedMessage } from './components/UnverifiedMessage';
import { Layout } from './Layout';

// The "new lead" email (brief §5.5, PLAN §9.3 step 6, D-13, D-27, D-47): a new form lead with the
// reply we drafted, ready for the owner to send from their own mailbox (law 1). It opens with the
// "isn't monitored" line (D-27), shows the lead's name, company and address and their message under
// "Message from the lead (unverified)" (all defanged by the caller, D-47), the draft, the three
// buttons and the "Open in default mail app" link (D-13), an honest note when HubSpot cannot
// confirm the send or see a reply (law 3), and the draft's flags in plain words ("Worth knowing"). No tracking pixels or tracked links (D-26). The subject
// comes from `newLeadSubject` (the lead's safe first name, D-47). Presentational only.

export interface NewLeadProps extends ActionLinks {
  /** PRODUCT_NAME. */
  productName: string;
  /** `safeFirstName` of the lead's first name (D-47), or null. */
  firstName: string | null;
  lead: LeadCardProps;
  /** The lead's message, defanged (D-47); null when there was none. */
  message: string | null;
  draftSubject: string;
  /** Plain text; line breaks are kept. */
  draftBody: string;
  /** `accounts.logging_mode`. */
  loggingMode: LoggingMode;
  /** The draft's flags (`drafts.flags`), shown in plain words; default none. */
  flags?: readonly DraftFlagCode[] | undefined;
  /** The brief in force allows prices (`allow_pricing`); words the pricing flag. Default false. */
  allowPricing?: boolean | undefined;
}

export function NewLead(props: NewLeadProps) {
  const note = initialLoggingNote(props.loggingMode);
  const who = props.firstName ?? 'your new lead';
  return (
    <Layout productName={props.productName} preview={`Your reply to ${who} is ready to send from your own email.`}>
      <NotMonitored />
      <Heading as="h1" style={heading}>
        {props.firstName === null ? 'New lead' : `New lead: ${props.firstName}`}
      </Heading>
      <HonestNotes notes={note === null ? [] : [note]} />
      <LeadCard {...props.lead} />
      <UnverifiedMessage message={props.message} />
      <DraftFlags flags={props.flags ?? []} allowPricing={props.allowPricing ?? false} />
      <DraftBlock subject={props.draftSubject} body={props.draftBody} />
      <ActionButtons sendUrl={props.sendUrl} editUrl={props.editUrl} dismissUrl={props.dismissUrl} mailtoUrl={props.mailtoUrl} />
    </Layout>
  );
}
