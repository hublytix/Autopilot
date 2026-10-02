import 'server-only';
import { createElement } from 'react';
import { NeedsTouch, needsTouchSubject, type NeedsTouchWhy } from '@/emails/NeedsTouch';
import { NewLead } from '@/emails/NewLead';
import { newLeadSubject } from '@/server/domain/subject';
import type { Db } from '@/server/db';
import { renderEmail } from '@/server/email/render';
import type { JobRow } from '@/server/jobs/types';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { scheduleFollowUpsInTx } from '@/server/services/followups/schedule';
import { NotificationKeys, NotificationPredicates } from '@/server/services/notifications/predicates';
import { reserveAndSend } from '@/server/services/notifications/send';
import type { NotificationSendPlan, RenderedMail, SendResult } from '@/server/services/notifications/types';
import { LEAD_EMAIL_BUTTONS, leadActionUrls } from './action-urls';
import { displayMessage, leadCardOf, loadLeadEmailSource, safeNameOf, type LeadEmailSource } from './email-source';

// The lead's first email (PLAN §8.4, §9.3 step 6, D-24, D-27, D-45, D-47): `new_lead` with the
// checked draft, or `needs_touch` with the draft we have (usually the minimal safe template). Both
// share the key `notify:{leadId}:initial:r{process_rev}`, so a needs-touch email can take over an
// unsent new-lead reservation and a lead gets at most one of the two. Predicates (§8.4): the lead is
// not dismissed, has no stop_reason and is not a test lead; account and connection active — checked
// at the reservation and again at every takeover, so a dismissal or pause during drafting is honoured.
//
// The `sent` transaction (onSent) writes `first_notified_at` (kept if already set) and, for a lead
// still `processing` at this revision, `processing_state = 'notified'` plus the two follow-up job
// rows (PLAN §9.3 step 6; none when follow-ups are off or for a test lead). A lead the failure path
// already marked `failed` keeps that state ("not processed", D-32) and gets no follow-ups: its email
// is the needs-touch notice, not a processed lead.

export type InitialNotificationKind = 'new_lead' | 'needs_touch';

export interface InitialNotificationInput {
  readonly accountId: string;
  readonly leadId: string;
  readonly processRev: number;
  readonly kind: InitialNotificationKind;
  /** For needs_touch: why, in the owner's words. Default: 'failed' for a lead the failure path marked failed, else 'unknown'. */
  readonly why?: NeedsTouchWhy | undefined;
}

/** Why the source cannot be emailed. */
export type InitialPlanProblem = 'lead_missing' | 'content_missing' | 'draft_missing' | 'no_recipients';

export type InitialPlanResult = { readonly ok: true; readonly plan: NotificationSendPlan } | { readonly ok: false; readonly problem: InitialPlanProblem };

function problemOf(source: LeadEmailSource): InitialPlanProblem | null {
  if (!source.hasContent) return 'content_missing';
  if (source.draft === null) return 'draft_missing';
  if (source.to.length === 0) return 'no_recipients';
  return null;
}

/** The `sent` transaction's lead writes (PLAN §8.4 step 5). Returns the follow-up job rows to publish. */
export async function markInitialNotified(
  tx: Db,
  input: { accountId: string; leadId: string; processRev: number; now: Date },
): Promise<readonly (JobRow | null)[]> {
  const row = await tx.maybeOne<{ previous_state: string; state: string; first_notified_at: Date }>(
    `with prev as (
       select id, processing_state, process_rev from leads where id = $1 and account_id = $2 for update
     )
     update leads l
        set first_notified_at = coalesce(l.first_notified_at, $3),
            processing_state = case when prev.processing_state = 'processing' and prev.process_rev = $4 then 'notified'
                                    else l.processing_state end
       from prev
      where l.id = prev.id
     returning prev.processing_state as previous_state, l.processing_state as state, l.first_notified_at`,
    [input.leadId, input.accountId, input.now, input.processRev],
  );
  if (row === null || !(row.previous_state === 'processing' && row.state === 'notified')) return [];
  const scheduled = await scheduleFollowUpsInTx(tx, {
    accountId: input.accountId,
    leadId: input.leadId,
    firstNotifiedAt: row.first_notified_at,
    now: input.now,
  });
  return scheduled.type === 'scheduled' ? scheduled.jobs : [];
}

/** The send plan of the lead's first email, rebuilt from the stored rows (also the sweeper's resume). */
export async function initialNotificationPlan(deps: Pick<Deps, 'db' | 'env' | 'clock'>, input: InitialNotificationInput): Promise<InitialPlanResult> {
  const source = await loadLeadEmailSource(deps.db, { accountId: input.accountId, leadId: input.leadId, draftKind: 'initial' });
  if (source === null) return { ok: false, problem: 'lead_missing' };
  const problem = problemOf(source);
  const draft = source.draft;
  if (problem !== null || draft === null) return { ok: false, problem: problem ?? 'draft_missing' };
  const { env } = deps;
  const firstName = safeNameOf(source);
  const lead = leadCardOf(source);
  const message = displayMessage(source.message);
  const to = [...source.to];
  const replyTo = source.replyTo ?? undefined;
  const why: NeedsTouchWhy = input.why ?? (source.processingState === 'failed' ? 'failed' : 'unknown');

  const plan: NotificationSendPlan = {
    predicates: NotificationPredicates.initial({ accountId: source.accountId, leadId: source.leadId }),
    buttons: LEAD_EMAIL_BUTTONS,
    draftId: draft.id,
    render: async (tokens): Promise<RenderedMail> => {
      const urls = leadActionUrls(env.APP_URL, tokens);
      const common = {
        productName: env.PRODUCT_NAME,
        firstName,
        lead,
        message,
        draftSubject: draft.subject,
        draftBody: draft.body,
        loggingMode: source.loggingMode,
        flags: draft.flags,
        allowPricing: source.allowPricing,
        ...urls,
      };
      const element =
        input.kind === 'new_lead'
          ? createElement(NewLead, common)
          : createElement(NeedsTouch, { ...common, why, starterReply: draft.needsTouch });
      const { html, text } = await renderEmail(element);
      return {
        to,
        replyTo,
        subject: input.kind === 'new_lead' ? newLeadSubject(source.firstName) : needsTouchSubject(firstName),
        html,
        text,
        tags: [
          { name: 'kind', value: input.kind },
          { name: 'lead', value: source.leadId },
        ],
      };
    },
    onSent: (tx) => markInitialNotified(tx, { accountId: source.accountId, leadId: source.leadId, processRev: input.processRev, now: deps.clock.now() }),
  };
  return { ok: true, plan };
}

export type InitialNotificationResult = SendResult | { readonly status: 'unsendable'; readonly problem: InitialPlanProblem };

/**
 * Reserves and sends the lead's first email (PLAN §8.4). Throws TransientError when the send should
 * be retried (the reservation stays `sending` for the job's retry or the sweeper).
 */
export async function sendInitialNotification(deps: Deps, input: InitialNotificationInput): Promise<InitialNotificationResult> {
  const built = await initialNotificationPlan(deps, input);
  if (!built.ok) {
    log.warn('lead email cannot be built', {
      event: 'lead.notification_unsendable',
      accountId: input.accountId,
      leadId: input.leadId,
      notificationKind: input.kind,
      reason: built.problem,
    });
    return { status: 'unsendable', problem: built.problem };
  }
  return reserveAndSend(deps, {
    kind: input.kind,
    dedupeKey: NotificationKeys.initial(input.leadId, input.processRev),
    accountId: input.accountId,
    leadId: input.leadId,
    ...built.plan,
  });
}
