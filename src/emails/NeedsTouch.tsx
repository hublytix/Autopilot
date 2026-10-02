import { Heading, Text } from 'react-email';
import { ActionButtons, type ActionLinks } from './components/ActionButtons';
import { DraftBlock } from './components/DraftBlock';
import { DraftFlags, type DraftFlagCode } from './components/DraftFlags';
import { HonestNotes, initialLoggingNote, type LoggingMode } from './components/HonestNotes';
import { LeadCard, type LeadCardProps } from './components/LeadCard';
import { NotMonitored } from './components/NotMonitored';
import { heading, paragraph } from './components/styles';
import { UnverifiedMessage } from './components/UnverifiedMessage';
import { Layout } from './Layout';

// The "needs your touch" email (brief §5.4, PLAN §9.3 step 5, §8.3 step 6, D-24, D-36): sent instead
// of the "new lead" email when no checked draft could be made (the model declined, the draft failed
// our checks twice, drafting is unavailable, or the job failed), so a lead is never silent. It has
// the same lead card, the reply we have (usually the short starter reply, the minimal safe template),
// why it needs a look, in plain words with no error codes, and the same three buttons. It shares
// the new-lead email's dedupe key, so a lead gets at most one of the two. Presentational only.

/** Why the email needs the owner's touch, as the owner reads it (no codes). */
export type NeedsTouchWhy = 'declined' | 'checks' | 'unavailable' | 'failed' | 'no_brief' | 'unknown';

const WHY_TEXT: Readonly<Record<NeedsTouchWhy, string>> = {
  declined: 'The AI model that writes your drafts declined to write your reply to this message.',
  checks: "The draft of your reply didn't pass our checks, so we haven't used it.",
  unavailable: 'Drafting is unavailable right now.',
  failed: 'Something went wrong while we were preparing this lead.',
  no_brief: "Your business details aren't saved yet, so we couldn't write your full reply.",
  unknown: "We couldn't prepare a full draft for this lead.",
};

export function needsTouchReasonText(why: NeedsTouchWhy): string {
  return WHY_TEXT[why];
}

/** `New lead: {Name} — your reply needs your touch`, or without the name when there is no safe one. */
export function needsTouchSubject(safeFirstName: string | null): string {
  return safeFirstName === null ? 'New lead — your reply needs your touch' : `New lead: ${safeFirstName} — your reply needs your touch`;
}

export interface NeedsTouchProps extends ActionLinks {
  /** PRODUCT_NAME. */
  productName: string;
  /** `safeFirstName` of the lead's first name (D-47), or null. */
  firstName: string | null;
  lead: LeadCardProps;
  /** The lead's message, defanged (D-47); null when there was none. */
  message: string | null;
  why: NeedsTouchWhy;
  /** True when the reply below is the short starter reply (the minimal safe template). */
  starterReply: boolean;
  draftSubject: string;
  /** Plain text; line breaks are kept. */
  draftBody: string;
  /** `accounts.logging_mode`. */
  loggingMode: LoggingMode;
  /** The draft's flags (`drafts.flags`; none on the starter reply), shown in plain words; default none. */
  flags?: readonly DraftFlagCode[] | undefined;
  /** The brief in force allows prices (`allow_pricing`); words the pricing flag. Default false. */
  allowPricing?: boolean | undefined;
}

export function NeedsTouch(props: NeedsTouchProps) {
  const note = initialLoggingNote(props.loggingMode);
  const who = props.firstName ?? 'your new lead';
  const next = props.starterReply
    ? "So we've written a short starter version of your reply instead. Read it, add what the lead asked about, then send it."
    : 'Here is your reply as we have it. Check it before you send it.';
  return (
    <Layout productName={props.productName} preview={`Your reply to ${who} needs a look before you send it.`}>
      <NotMonitored />
      <Heading as="h1" style={heading}>
        {props.firstName === null ? 'New lead: your reply needs your touch' : `New lead: ${props.firstName}`}
      </Heading>
      <Text style={paragraph}>{needsTouchReasonText(props.why)}</Text>
      <Text style={paragraph}>{next}</Text>
      <HonestNotes notes={note === null ? [] : [note]} />
      <LeadCard {...props.lead} />
      <UnverifiedMessage message={props.message} />
      <DraftFlags flags={props.flags ?? []} allowPricing={props.allowPricing ?? false} />
      <DraftBlock title={props.starterReply ? 'Your starter reply (needs your touch)' : 'Your reply'} subject={props.draftSubject} body={props.draftBody} />
      <ActionButtons sendUrl={props.sendUrl} editUrl={props.editUrl} dismissUrl={props.dismissUrl} mailtoUrl={props.mailtoUrl} />
    </Layout>
  );
}
