import { Text } from 'react-email';
import { honestNote } from './styles';

// Honest notes (law 3, D-14, D-34): what HubSpot can and cannot confirm for this owner, said plainly
// so a missing "sent" or "replied" never reads as a fact. The account's `logging_mode` comes from the
// inbox check (D-14): `log_all` (sends and replies logged), `sends_only`, `none`, `unknown` (not
// checked, or skipped).

/** How HubSpot logs this owner's mail, as far as the inbox check showed (`accounts.logging_mode`). */
export type LoggingMode = 'unknown' | 'log_all' | 'sends_only' | 'none';

/** The note on a first ("new lead" or "needs your touch") email; null when nothing needs saying. */
export function initialLoggingNote(mode: LoggingMode): string | null {
  switch (mode) {
    case 'log_all':
      return null;
    case 'sends_only':
      return "HubSpot logs the emails you send but not the replies you get, so we can confirm your send but won't see the lead's answer. Check your inbox before each follow-up.";
    case 'none':
      return "HubSpot isn't logging your emails, so we can't confirm that you sent this reply or see the lead's answer.";
    case 'unknown':
      return "We haven't confirmed that HubSpot logs your emails, so we may not be able to confirm your send or see the lead's answer.";
  }
}

/** D-34's sentence when HubSpot has not confirmed the first send. */
export const FIRST_SEND_UNCONFIRMED_NOTE = "We couldn't confirm in HubSpot that your first reply was sent.";
/** D-34's sentence when replies are not logged. */
export const REPLIES_NOT_LOGGED_NOTE = "HubSpot isn't logging replies for you, so check your inbox before sending.";
/** The same advice when the inbox check has not shown either way (never overstate). */
export const REPLIES_UNKNOWN_NOTE = "We haven't confirmed that HubSpot logs replies for you, so check your inbox before sending.";

/** The notes on a follow-up email (D-34), in order. */
export function followUpNotes(input: { sendConfirmed: boolean; loggingMode: LoggingMode }): string[] {
  const notes: string[] = [];
  if (!input.sendConfirmed) notes.push(FIRST_SEND_UNCONFIRMED_NOTE);
  if (input.loggingMode === 'sends_only' || input.loggingMode === 'none') notes.push(REPLIES_NOT_LOGGED_NOTE);
  else if (input.loggingMode === 'unknown') notes.push(REPLIES_UNKNOWN_NOTE);
  return notes;
}

export function HonestNotes({ notes }: { notes: readonly string[] }) {
  if (notes.length === 0) return null;
  return (
    <>
      {notes.map((text) => (
        <Text key={text} style={honestNote}>
          {text}
        </Text>
      ))}
    </>
  );
}
