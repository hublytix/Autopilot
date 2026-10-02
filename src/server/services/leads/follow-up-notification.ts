import 'server-only';
import { createElement } from 'react';
import { FollowUp, followUpSubject } from '@/emails/FollowUp';
import type { NeedsTouchWhy } from '@/emails/NeedsTouch';
import type { Db } from '@/server/db';
import { renderEmail } from '@/server/email/render';
import type { Deps } from '@/server/ports';
import { NotificationKeys, NotificationPredicates } from '@/server/services/notifications/predicates';
import type { NotificationSendPlan, RenderedMail } from '@/server/services/notifications/types';
import { LEAD_EMAIL_BUTTONS, leadActionUrls } from './action-urls';
import { displayMessage, leadCardOf, loadLeadEmailSource, safeNameOf } from './email-source';

// The follow-up email's send plan (brief §5.6, PLAN §8.4, §9.5 step 5, D-27, D-34), built here so the
// first send (M5's follow-up job) and a resumed one (the sweeper, through the registered resumer) are
// the same email. Kind `follow_up` with the checked follow-up draft, or `needs_touch` when the
// follow-up draft is the starter template; both share `notify:{leadId}:fu{n}:s{followup_stream}`.
// Predicates (§8.4): the initial ones plus replied_at null, not superseded (D-44), follow-ups on.
// The `sent` transaction sets `fu{n}_notified_at` (kept if already set). The honest notes (D-34)
// are derived from `send_confirmed_at` and `logging_mode` at render time. "No reply … is logged" is
// said only when the check before this follow-up read every logged email; otherwise the email says
// it could not tell (law 3, D-73).

export type FollowUpKind = 'follow_up' | 'needs_touch';

export interface FollowUpNotificationInput {
  readonly accountId: string;
  readonly leadId: string;
  readonly n: 1 | 2;
  readonly followupStream: number;
  /** For a needs-touch follow-up: why, in the owner's words. Default 'unknown'. */
  readonly why?: NeedsTouchWhy | undefined;
  /**
   * The follow-up job's check read every email logged on the contact (ApplySignalsResult.emailsAvailable),
   * so the email may say no reply is logged. Left out by the resumer, which uses `repliesCheckedSince`.
   */
  readonly repliesChecked?: boolean | undefined;
  /**
   * For a resumed send: the replies count as checked when the last complete read of HubSpot
   * (`signals_checked_at`) is at or after this (the job's check, just before its reservation).
   * Neither given: not checked ("not enough data", law 3).
   */
  readonly repliesCheckedSince?: Date | undefined;
}

export interface FollowUpNotification {
  readonly kind: FollowUpKind;
  readonly dedupeKey: string;
  readonly plan: NotificationSendPlan;
}

/** The `sent` transaction's lead write for follow-up n. */
export async function markFollowUpNotified(tx: Db, input: { accountId: string; leadId: string; n: 1 | 2; now: Date }): Promise<void> {
  const column = input.n === 1 ? 'fu1_notified_at' : 'fu2_notified_at';
  await tx.query(`update leads set ${column} = coalesce(${column}, $3) where id = $1 and account_id = $2`, [input.leadId, input.accountId, input.now]);
}

/**
 * The plan for follow-up n of the lead's stream, or null when it cannot be emailed (the lead, its
 * content or the `fu{n}` draft is gone, or nobody can be emailed). `kind` follows the stored draft.
 */
export async function followUpNotificationPlan(
  deps: Pick<Deps, 'db' | 'env' | 'clock'>,
  input: FollowUpNotificationInput,
): Promise<FollowUpNotification | null> {
  const draftKind = input.n === 1 ? 'fu1' : 'fu2';
  const source = await loadLeadEmailSource(deps.db, { accountId: input.accountId, leadId: input.leadId, draftKind });
  if (source === null || !source.hasContent || source.draft === null || source.to.length === 0) return null;
  const draft = source.draft;
  const { env } = deps;
  const kind: FollowUpKind = draft.needsTouch ? 'needs_touch' : 'follow_up';
  const firstName = safeNameOf(source);
  const lead = leadCardOf(source);
  const message = displayMessage(source.message);
  const to = [...source.to];
  const replyTo = source.replyTo ?? undefined;
  const since = input.repliesCheckedSince;
  const repliesChecked =
    input.repliesChecked ?? (since !== undefined && source.signalsCheckedAt !== null && source.signalsCheckedAt.getTime() >= since.getTime());

  const plan: NotificationSendPlan = {
    predicates: NotificationPredicates.followUp({ accountId: source.accountId, leadId: source.leadId }, input.n),
    buttons: LEAD_EMAIL_BUTTONS,
    draftId: draft.id,
    render: async (tokens): Promise<RenderedMail> => {
      const { html, text } = await renderEmail(
        createElement(FollowUp, {
          productName: env.PRODUCT_NAME,
          n: input.n,
          firstName,
          lead,
          message,
          sendConfirmed: source.sendConfirmedAt !== null,
          repliesUnchecked: !repliesChecked,
          loggingMode: source.loggingMode,
          needsTouch: draft.needsTouch ? (input.why ?? 'unknown') : undefined,
          draftSubject: draft.subject,
          draftBody: draft.body,
          ...leadActionUrls(env.APP_URL, tokens),
        }),
      );
      return {
        to,
        replyTo,
        subject: followUpSubject(input.n, firstName, draft.needsTouch),
        html,
        text,
        tags: [
          { name: 'kind', value: kind },
          { name: 'lead', value: source.leadId },
        ],
      };
    },
    onSent: (tx) => markFollowUpNotified(tx, { accountId: source.accountId, leadId: source.leadId, n: input.n, now: deps.clock.now() }),
  };
  return { kind, dedupeKey: NotificationKeys.followUp(source.leadId, input.n, input.followupStream), plan };
}
