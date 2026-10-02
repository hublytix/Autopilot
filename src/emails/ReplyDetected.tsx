import { Button, Heading, Link, Text } from 'react-email';
import { NotMonitored } from './components/NotMonitored';
import { heading, link, note, paragraph, primaryButton } from './components/styles';
import { Layout } from './Layout';

// "{Name} replied — follow-ups stopped" (PLAN §9.5 step 4, D-08, D-37): HubSpot logged a reply from
// the lead while follow-ups were still scheduled, so the remaining follow-ups were cancelled. A
// "reply" here always means the lead's reply (D-37). It links to the contact's record in HubSpot
// (read-only for us, law 2) where the owner reads and answers it. It has no send button, so the
// "isn't monitored" line says to answer from the owner's own mailbox. The "resume follow-ups" line
// (D-42) appears only with `resumeFollowUpsUrl`: the page that offers "Resume follow-ups" (M6's lead
// page). Until a page offers it, the email does not promise it (law 5, D-73). Presentational only.

/** `{Name} replied — follow-ups stopped`, or "Your lead replied — …" when there is no safe name. */
export function replyDetectedSubject(safeFirstName: string | null): string {
  return `${safeFirstName ?? 'Your lead'} replied — follow-ups stopped`;
}

export interface ReplyDetectedProps {
  /** PRODUCT_NAME. */
  productName: string;
  /** `safeFirstName` of the lead's first name (D-47), or null. */
  firstName: string | null;
  /** When HubSpot logged the reply, already formatted in the account's timezone; null when unknown. */
  repliedAtText: string | null;
  /** https://{uiDomain}/contacts/{portalId}/record/0-1/{contactId}; null when unknown. */
  hubspotRecordUrl: string | null;
  /** The page with "Resume follow-ups" for this lead; null (no promise of it) until a page offers it (law 5). */
  resumeFollowUpsUrl?: string | null | undefined;
}

export function ReplyDetected(props: ReplyDetectedProps) {
  const who = props.firstName ?? 'your lead';
  const when = props.repliedAtText === null ? '' : ` on ${props.repliedAtText}`;
  return (
    <Layout productName={props.productName} preview={`HubSpot logged a reply from ${who}. We stopped the follow-ups.`}>
      <NotMonitored instead="To answer the lead, send your reply from your own mailbox." />
      <Heading as="h1" style={heading}>
        {replyDetectedSubject(props.firstName)}
      </Heading>
      <Text style={paragraph}>
        {`HubSpot logged a reply from ${who}${when}.`} We&apos;ve stopped the follow-ups for this lead, so you won&apos;t get any
        more drafts for it.
      </Text>
      {props.hubspotRecordUrl === null ? null : (
        <Button href={props.hubspotRecordUrl} style={primaryButton}>
          Open the contact in HubSpot
        </Button>
      )}
      {props.resumeFollowUpsUrl === null || props.resumeFollowUpsUrl === undefined ? null : (
        <Text style={note}>
          If it was an automatic reply, such as an out-of-office message, you can{' '}
          <Link href={props.resumeFollowUpsUrl} style={link}>
            resume follow-ups
          </Link>
          .
        </Text>
      )}
    </Layout>
  );
}
