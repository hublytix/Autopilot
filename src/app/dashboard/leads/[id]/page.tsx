import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Card, Page, SubmitButton } from '@/components/ui';
import { markRealLeadAction, notARealLeadAction, resumeFollowUpsAction } from '@/server/actions/dashboard/lead';
import { getDeps } from '@/server/container';
import { requireOwnerPage } from '@/server/http/auth/guards';
import { leadDetailView, refreshLeadSignals, type LeadDetailView, type LeadRefreshOutcome } from '@/server/views/dashboard';
import { ownValue } from '@/shared/own-key';
import {
  DRAFT_TITLES,
  LEAD_RESULTS,
  leadNameText,
  NOT_PROCESSED_TEXT,
  REAL_LEAD_TEXT,
  RESUME_TEXT,
  SIGNALS_TEXT,
  STOP_TEXT,
  timelineText,
} from '../../copy';
import { StatusBadge } from '../../status-badge';

// /dashboard/leads/[id] (PLAN §7.5, D-31, D-32, D-42, D-47): one of the owner's leads. On view, the
// lead's signals are refreshed from HubSpot (at most once per 5 minutes per lead, never for a test
// lead, never in the way of the page). Then: the status, the timeline, the drafts until they are
// purged ("This draft has expired"), the lead's message as "Message from the lead (unverified)",
// defanged, until it is purged, and the controls that apply: "This is a real lead" (filtered leads),
// "Resume follow-ups" (leads that replied), "Not a real lead". Another account's lead, or an id that
// is not a lead, is a 404. No-store and noindex come from the proxy (D-49).

export const metadata: Metadata = {
  title: 'Lead',
  robots: { index: false, follow: false },
};

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const MUTED = 'text-neutral-700 dark:text-neutral-300';

function SignalsNotes({ view, refresh }: { view: LeadDetailView; refresh: LeadRefreshOutcome }) {
  const emailed = view.timeline.some((event) => event.kind === 'emailed');
  if (view.isTest || !emailed) return null;
  const notes: { text: string; tone: 'info' | 'warning' | 'success' }[] = [];
  if (refresh.type === 'checked' && refresh.markedReplied) notes.push({ text: SIGNALS_TEXT.markedReplied, tone: 'success' });
  // The reason that is true: a disconnected account (the reconnect banner explains it), else a grant
  // without the email scope, else a read that couldn't see every logged email.
  if (!view.signals.connectionActive) notes.push({ text: SIGNALS_TEXT.disconnected, tone: 'warning' });
  else if (!view.signals.emailScope) notes.push({ text: SIGNALS_TEXT.noScope, tone: 'warning' });
  else if (refresh.type === 'checked' && !refresh.emailsAvailable) notes.push({ text: SIGNALS_TEXT.unavailableNow, tone: 'warning' });
  if (refresh.type === 'failed') notes.push({ text: SIGNALS_TEXT.failedNow, tone: 'warning' });
  return (
    <div className="flex flex-col gap-2" data-testid="signals">
      {notes.map((note) => (
        <Alert key={note.text} tone={note.tone}>
          {note.text}
        </Alert>
      ))}
      <p className={`text-sm ${MUTED}`}>{view.signals.checkedAt === null ? SIGNALS_TEXT.notChecked : SIGNALS_TEXT.checkedAt(view.signals.checkedAt)}</p>
    </div>
  );
}

function Controls({ view }: { view: LeadDetailView }) {
  const { realLead, resumeFollowUps, dismiss } = view.controls;
  if (realLead === null && resumeFollowUps === null && !dismiss) return null;
  return (
    <Card title="What you can do">
      {realLead === null ? null : (
        <div className="flex flex-col gap-2">
          {realLead === 'available' ? (
            <form action={markRealLeadAction}>
              <input type="hidden" name="lead_id" value={view.id} />
              <SubmitButton pendingLabel="Saving…">This is a real lead</SubmitButton>
            </form>
          ) : null}
          <p className={`text-sm ${MUTED}`}>{REAL_LEAD_TEXT[realLead]}</p>
        </div>
      )}
      {resumeFollowUps === null ? null : (
        <div className="flex flex-col gap-2">
          {resumeFollowUps === 'available' ? (
            <form action={resumeFollowUpsAction}>
              <input type="hidden" name="lead_id" value={view.id} />
              <SubmitButton pendingLabel="Resuming…">Resume follow-ups</SubmitButton>
            </form>
          ) : null}
          <p className={`text-sm ${MUTED}`}>{RESUME_TEXT[resumeFollowUps]}</p>
        </div>
      )}
      {dismiss ? (
        <div className="flex flex-col gap-2">
          <form action={notARealLeadAction}>
            <input type="hidden" name="lead_id" value={view.id} />
            <SubmitButton variant="secondary" pendingLabel="Saving…">
              Not a real lead
            </SubmitButton>
          </form>
          <p className={`text-sm ${MUTED}`}>Follow-ups for this lead stop. Nothing changes in HubSpot.</p>
        </div>
      ) : null}
    </Card>
  );
}

function Timeline({ view }: { view: LeadDetailView }) {
  return (
    <Card title="Timeline" description={`Times are in ${view.zone}.`}>
      <ol className="flex flex-col gap-3" data-testid="timeline">
        {view.timeline.map((event, index) => (
          <li key={`${event.kind}-${index}`} className="flex flex-col gap-0.5 sm:flex-row sm:gap-4" data-kind={event.kind}>
            <time className={`shrink-0 text-sm sm:w-40 ${MUTED}`}>{event.at}</time>
            <span>{timelineText(event)}</span>
          </li>
        ))}
      </ol>
      {view.upcomingFollowUps.map((followUp) => (
        <p key={followUp.n} className={MUTED}>
          Follow-up {followUp.n} draft due {followUp.at}.
        </p>
      ))}
      {view.failedFollowUps.map((n) => (
        <p key={n} className={MUTED}>
          Follow-up {n} couldn&apos;t be drafted or emailed to you.
        </p>
      ))}
      {view.stopReason === null || view.stopReason === 'test_lead' ? null : (
        <p className={MUTED} data-testid="stop-reason">
          Follow-ups stopped: {STOP_TEXT[view.stopReason]}
        </p>
      )}
    </Card>
  );
}

function Drafts({ view }: { view: LeadDetailView }) {
  if (view.drafts.length === 0) return null;
  return (
    <>
      {view.drafts.map((draft) => (
        <Card key={draft.kind} title={DRAFT_TITLES[draft.kind]}>
          {draft.state === 'expired' ? (
            <p className={MUTED}>This draft has expired. Drafts are deleted 30 days after the form was submitted.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {draft.needsTouch ? <Alert tone="warning">This is a starter draft: it needs your touch before you send it.</Alert> : null}
              <p>
                <span className="font-semibold">Subject: </span>
                <span className="break-words">{draft.subject}</span>
              </p>
              <p className="whitespace-pre-wrap break-words rounded-md border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-900">
                {draft.body}
              </p>
            </div>
          )}
        </Card>
      ))}
    </>
  );
}

function Message({ view }: { view: LeadDetailView }) {
  const { message } = view;
  return (
    <Card title="Message from the lead (unverified)" description="Written by whoever filled in the form. Links and addresses are shown as plain text.">
      {message.state === 'available' ? (
        <p className="whitespace-pre-wrap break-words" data-testid="lead-message">
          {message.text}
        </p>
      ) : message.state === 'empty' ? (
        <p className={MUTED}>The form had no message.</p>
      ) : message.reason === 'privacy_deleted' ? (
        <p className={MUTED}>Deleted at the contact&apos;s request.</p>
      ) : (
        <p className={MUTED}>Removed 30 days after the form was submitted.</p>
      )}
    </Card>
  );
}

export default async function LeadPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const requestHeaders = await headers();
  const deps = await getDeps();
  const scope = await requireOwnerPage(deps, requestHeaders);
  const { id } = await params;
  // HubSpot first (bounded, never throws), so the page shows what it found.
  const refresh = await refreshLeadSignals(scope, deps, id);
  const view = await leadDetailView(scope, deps, id);
  if (view === null) notFound();
  const query = await searchParams;
  const result = ownValue(LEAD_RESULTS, typeof query.result === 'string' ? query.result : undefined);

  return (
    <Page
      width="wide"
      eyebrow={
        <Link href="/dashboard" prefetch={false} className="inline-flex min-h-11 items-center underline underline-offset-4">
          All leads
        </Link>
      }
      title={leadNameText(view.name)}
    >
      {result === undefined ? null : <Alert tone={result.tone}>{result.text}</Alert>}
      {view.isTest ? (
        <Alert tone="info">This is the test lead from your inbox check. It never gets follow-ups and isn&apos;t counted anywhere.</Alert>
      ) : null}
      <Card>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge status={view.status} label={view.statusLabel} />
            {view.recordUrl === null ? null : (
              <a href={view.recordUrl} className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4" rel="noopener noreferrer" target="_blank">
                Open in HubSpot
              </a>
            )}
          </div>
          {view.notProcessed === null ? null : <p>{NOT_PROCESSED_TEXT[view.notProcessed]}</p>}
          <p className={MUTED}>Received {view.receivedAt}.</p>
          {view.company === null ? null : <p className={`break-words ${MUTED}`}>Company: {view.company}</p>}
        </div>
        <SignalsNotes view={view} refresh={refresh} />
      </Card>
      <Controls view={view} />
      <Timeline view={view} />
      <Drafts view={view} />
      <Message view={view} />
    </Page>
  );
}
