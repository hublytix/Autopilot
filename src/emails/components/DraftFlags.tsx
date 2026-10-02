import { Text } from 'react-email';
import { BUTTON_LABELS } from './ActionButtons';
import { cardLine, subheading } from './styles';

// What the draft's flags mean for the owner (brief §5.4, PLAN §9.3 step 5): the model marks a draft
// with codes from a closed list (`drafts.flags`), and the lead email says each one in plain words,
// one line per flag, never the code itself (law 5). The pricing line depends on the brief's
// `allow_pricing`: without it, the validator keeps every amount out of the draft, so the line can say
// so. Presentational only.

/** `drafts.flags` values (DRAFT_FLAGS in the server's domain types), in their stored order. */
export type DraftFlagCode = 'asks_pricing' | 'urgent' | 'non_english' | 'missing_info' | 'possible_spam' | 'sensitive_topic' | 'other';

export interface DraftFlagContext {
  /** The brief in force allows prices in drafts (`allow_pricing`). */
  allowPricing: boolean;
}

/** The plain-words line for one flag. */
export function draftFlagLine(flag: DraftFlagCode, context: DraftFlagContext): string {
  switch (flag) {
    case 'asks_pricing':
      return context.allowPricing
        ? 'The lead asked about prices. Check any prices in the draft before you send it.'
        : "The lead asked about prices. Your business details say not to quote them, so the draft doesn't.";
    case 'urgent':
      return 'The message may be urgent.';
    case 'non_english':
      return "The message isn't in English. Check the draft's language before you send it.";
    case 'missing_info':
      return 'The message is short or unclear, so you may need to add details to the draft.';
    case 'possible_spam':
      return `This may not be a genuine enquiry. If it isn't, tap "${BUTTON_LABELS.dismiss}".`;
    case 'sensitive_topic':
      return 'The message touches on something sensitive. Read the draft closely before you send it.';
    case 'other':
      return 'Something in the message may need your attention.';
  }
}

/** One line per flag, duplicates removed, in the order given. */
export function draftFlagLines(flags: readonly DraftFlagCode[], context: DraftFlagContext): string[] {
  return [...new Set(flags)].map((flag) => draftFlagLine(flag, context));
}

export interface DraftFlagsProps extends DraftFlagContext {
  flags: readonly DraftFlagCode[];
}

/** "Worth knowing" with one plain line per flag; nothing when there are none. */
export function DraftFlags({ flags, allowPricing }: DraftFlagsProps) {
  const lines = draftFlagLines(flags, { allowPricing });
  if (lines.length === 0) return null;
  return (
    <>
      <Text style={subheading}>Worth knowing</Text>
      {lines.map((line) => (
        <Text key={line} style={cardLine}>
          {line}
        </Text>
      ))}
    </>
  );
}
