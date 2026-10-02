import 'server-only';
import { DateTime } from 'luxon';
import { createElement } from 'react';
import { ReplyDetected, replyDetectedSubject } from '@/emails/ReplyDetected';
import { renderEmail } from '@/server/email/render';
import type { Deps } from '@/server/ports';
import { NotificationKeys, NotificationPredicates } from '@/server/services/notifications/predicates';
import type { NotificationSendPlan, RenderedMail } from '@/server/services/notifications/types';
import { loadLeadEmailSource, safeNameOf } from './email-source';
import { hubspotContactRecordUrl } from './record-link';

// "{Name} replied — follow-ups stopped" (PLAN §8.4, §9.5 step 4, D-08, D-37): reserved by M5's
// markReplied() transaction (key `reply:{leadId}:s{followup_stream}`, only while follow-ups were
// still scheduled) and sent after commit through sendReserved, which rebuilds this plan through the
// registered resumer. Predicates (§8.4): replied_at set, lead not dismissed, account and connection
// active. No buttons (nothing to send), no lead content beyond the safe first name: the email links
// to the contact's record in HubSpot, where the owner reads the reply. The reply time is HubSpot's
// (`replied_at`), shown in the account's timezone. No "resume follow-ups" line yet: no page offers it
// before M6's lead page, which passes `resumeFollowUpsUrl` (law 5, D-68 open point, D-73).

/** "Tue 6 Oct, 10:15" in `zone` (UTC when unknown or invalid). */
export function formatReplyTime(at: Date, zone: string | null): string {
  const zoned = DateTime.fromJSDate(at, { zone: zone ?? 'UTC' });
  const local = zoned.isValid ? zoned : DateTime.fromJSDate(at, { zone: 'UTC' });
  return local.setLocale('en-GB').toFormat('ccc d LLL, HH:mm');
}

export function replyDetectedKey(leadId: string, followupStream: number): string {
  return NotificationKeys.replyDetected(leadId, followupStream);
}

/** The reply_detected plan for the lead, or null when the lead is gone or nobody can be emailed. */
export async function replyDetectedNotificationPlan(
  deps: Pick<Deps, 'db' | 'env'>,
  input: { accountId?: string | null | undefined; leadId: string },
): Promise<NotificationSendPlan | null> {
  const source = await loadLeadEmailSource(deps.db, { accountId: input.accountId, leadId: input.leadId });
  if (source === null || source.to.length === 0) return null;
  const { env } = deps;
  // The name only while the lead's content is stored (D-31); never more of it.
  const firstName = source.hasContent ? safeNameOf(source) : null;
  const to = [...source.to];
  const replyTo = source.replyTo ?? undefined;
  return {
    predicates: NotificationPredicates.replyDetected({ accountId: source.accountId, leadId: source.leadId }),
    render: async (): Promise<RenderedMail> => {
      const { html, text } = await renderEmail(
        createElement(ReplyDetected, {
          productName: env.PRODUCT_NAME,
          firstName,
          repliedAtText: source.repliedAt === null ? null : formatReplyTime(source.repliedAt, source.timezone),
          hubspotRecordUrl: hubspotContactRecordUrl(source.uiDomain, source.portalId, source.hubspotContactId),
        }),
      );
      return {
        to,
        replyTo,
        subject: replyDetectedSubject(firstName),
        html,
        text,
        tags: [
          { name: 'kind', value: 'reply_detected' },
          { name: 'lead', value: source.leadId },
        ],
      };
    },
  };
}
