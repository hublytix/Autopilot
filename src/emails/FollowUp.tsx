import { Heading, Text } from 'react-email';
import { ActionButtons, type ActionLinks } from './components/ActionButtons';
import { DraftBlock } from './components/DraftBlock';
import { followUpNotes, HonestNotes, type LoggingMode } from './components/HonestNotes';
import { LeadCard, type LeadCardProps } from './components/LeadCard';
import { NotMonitored } from './components/NotMonitored';
import { heading, paragraph } from './components/styles';
import { UnverifiedMessage } from './components/UnverifiedMessage';
import { Layout } from './Layout';
import { needsTouchReasonText, type NeedsTouchWhy } from './NeedsTouch';

// The follow-up email (brief §5.6, PLAN §9.5 step 5, D-27, D-34): follow-up 1 (day 2) or 2 (day 5)
// for a lead with no logged reply, drafted for the owner to send from their own mailbox (law 1).
// It opens with the "isn't monitored" line (D-27), states the honest notes from D-34 when HubSpot
// has not confirmed the first send or does not log replies (law 3), shows the lead card, the lead's
// message (unverified, defanged; while it is stored), the follow-up draft and the three buttons.
// When the follow-up draft is the starter template (`needsTouch`), it says why. Presentational only.

/** `Follow-up {n} for {Name} — your draft is ready` (or "needs your touch"), without the name when there is no safe one. */
export function followUpSubject(n: 1 | 2, safeFirstName: string | null, needsTouch = false): string {
  const tail = needsTouch ? 'your draft needs your touch' : 'your draft is ready';
  return safeFirstName === null ? `Follow-up ${n} — ${tail}` : `Follow-up ${n} for ${safeFirstName} — ${tail}`;
}

export interface FollowUpProps extends ActionLinks {
  /** PRODUCT_NAME. */
  productName: string;
  /** 1 (day 2) or 2 (day 5). */
  n: 1 | 2;
  /** `safeFirstName` of the lead's first name (D-47), or null. */
  firstName: string | null;
  lead: LeadCardProps;
  /** The lead's message, defanged (D-47); null when there was none. */
  message: string | null;
  /** `leads.send_confirmed_at` is set: HubSpot shows the first reply was sent. */
  sendConfirmed: boolean;
  /** `accounts.logging_mode`. */
  loggingMode: LoggingMode;
  /** Set when the follow-up draft is the starter template: why. */
  needsTouch?: NeedsTouchWhy | undefined;
  draftSubject: string;
  /** Plain text; line breaks are kept. */
  draftBody: string;
}

export function FollowUp(props: FollowUpProps) {
  const who = props.firstName ?? 'your lead';
  const notes = followUpNotes({ sendConfirmed: props.sendConfirmed, loggingMode: props.loggingMode });
  return (
    <Layout productName={props.productName} preview={`Follow-up ${props.n} for ${who} is ready to send from your own email.`}>
      <NotMonitored />
      <Heading as="h1" style={heading}>
        {props.firstName === null ? `Follow-up ${props.n}` : `Follow-up ${props.n} for ${props.firstName}`}
      </Heading>
      <Text style={paragraph}>
        {props.n === 1
          ? 'No reply from this lead is logged in HubSpot since your first email. Here is a short follow-up you can send.'
          : 'Still no reply from this lead is logged in HubSpot. Here is a last short follow-up you can send.'}
      </Text>
      <HonestNotes notes={notes} />
      {props.needsTouch === undefined ? null : (
        <Text style={paragraph}>
          {needsTouchReasonText(props.needsTouch)} So this is a short starter follow-up. Check it before you send it.
        </Text>
      )}
      <LeadCard {...props.lead} />
      <UnverifiedMessage message={props.message} />
      <DraftBlock title={`Follow-up ${props.n}`} subject={props.draftSubject} body={props.draftBody} />
      <ActionButtons sendUrl={props.sendUrl} editUrl={props.editUrl} dismissUrl={props.dismissUrl} mailtoUrl={props.mailtoUrl} />
    </Layout>
  );
}
