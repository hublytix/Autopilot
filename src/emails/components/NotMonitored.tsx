import { Text } from 'react-email';
import { notice } from './styles';

// The first line of every lead email (D-27): replies to this email reach the owner's own address,
// not the lead, so the owner is told how to answer the lead instead.

/** D-27's wording, for the emails that carry the "Send from my email" button. */
export const NOT_MONITORED_LINE = "This email isn't monitored. To answer the lead, tap 'Send from my email'.";

export interface NotMonitoredProps {
  /** Overrides the second sentence for an email without the send button (reply detected). */
  instead?: string | undefined;
}

export function NotMonitored({ instead }: NotMonitoredProps) {
  return <Text style={notice}>{instead === undefined ? NOT_MONITORED_LINE : `This email isn't monitored. ${instead}`}</Text>;
}
