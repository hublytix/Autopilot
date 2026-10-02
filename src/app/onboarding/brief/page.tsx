import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { Alert, Card, LinkButton, Page } from '@/components/ui';
import { generateBriefAction, saveBriefAction } from '@/server/actions/onboarding/brief';
import { getDeps } from '@/server/container';
import { requireOwnerPage } from '@/server/http/auth/guards';
import { briefPageView } from '@/server/views/onboarding/brief';
import { BriefEditor } from './brief-editor';
import { GenerateForm } from './generate-form';
import { StatusPoller } from './status-poller';

// /onboarding/brief (PLAN §7.5, §9.7): the owner's website → a brief_generate job in the
// background (the owner may go on to the forms meanwhile), then the editor. Saving creates the
// owner's version, which is what drafts use. While a read runs the editor is not shown: the result
// replaces what it would show, and anything typed meanwhile would be lost when the page refreshes.

export const metadata: Metadata = {
  title: 'Your business',
  robots: { index: false, follow: false },
};

function failureText(code: string | null): string {
  if (code !== null && code.startsWith('site_robots')) {
    return "Your website's robots.txt asks automated readers like ours not to read it, so we didn't. Fill in your brief below; it takes a few minutes.";
  }
  if (code !== null && code.startsWith('site_')) {
    return "We couldn't read your website. Check the address and try again, or fill in your brief below.";
  }
  return "We couldn't build a brief from your website this time. Fill it in below; it takes a few minutes.";
}

export default async function OnboardingBriefPage() {
  const deps = await getDeps();
  const scope = await requireOwnerPage(deps, await headers());
  const view = await briefPageView(scope, deps);
  const { editor } = view;
  const running = editor.generation.inProgress;
  const noneLeft = !running && editor.generation.remainingToday === 0;
  const failed = !running && editor.job?.status === 'failed';

  return (
    <Page
      title="Tell us about your business"
      description="Drafts use this brief to answer your leads in your voice. We can start it from your website; you check and edit everything before it's used."
    >
      <Card title="Start from your website" description="Optional. You can also fill in the brief yourself.">
        {running ? (
          <Alert tone="info" title="Reading your website">
            <p>This can take a few minutes. This page updates when it&apos;s done.</p>
            <p>
              You can{' '}
              <Link href="/onboarding/forms" prefetch={false} className="font-medium underline underline-offset-4">
                continue to your forms while it runs
              </Link>{' '}
              and come back to check the brief.
            </p>
            <p>
              <Link href="/onboarding/brief" prefetch={false} className="underline underline-offset-4">
                Check again
              </Link>
            </p>
          </Alert>
        ) : null}
        {running ? <StatusPoller watch="brief" /> : null}
        {failed ? <Alert tone="warning">{failureText(editor.job?.errorCode ?? null)}</Alert> : null}
        {editor.job?.status === 'done' && editor.form.origin === 'generated' ? (
          <Alert tone="success">We filled in the brief below from your website. Check every field before you save.</Alert>
        ) : null}
        {noneLeft ? <Alert tone="info">You&apos;ve used today&apos;s {view.generationsPerDay} website reads. You can still fill in the brief yourself.</Alert> : null}
        <GenerateForm
          action={generateBriefAction}
          initialUrl={view.suggestedUrl}
          disabled={running || noneLeft}
          submitLabel={editor.job === null ? 'Read my website' : 'Read my website again'}
        />
      </Card>

      <Card
        title="Your brief"
        description={
          running
            ? undefined
            : editor.form.origin === 'owner' && editor.form.version !== null
              ? `Your saved brief (version ${editor.form.version}). Saving again creates a new version.`
              : 'Nothing is used until you save.'
        }
      >
        {running ? (
          <p className="text-sm text-neutral-700 dark:text-neutral-300">
            {editor.saved !== null
              ? 'The editor opens again when we have read your website. Your saved brief stays in use until you save a new version.'
              : 'The editor opens here, filled in from your website, when the read is done. You can fill it in or change anything then.'}
          </p>
        ) : (
          <BriefEditor action={saveBriefAction} initial={view.initialValues} bookingLink={view.bookingLink} limits={view.limits} />
        )}
      </Card>

      {editor.saved !== null ? (
        <LinkButton href="/onboarding/forms" variant="secondary">
          Continue without changes
        </LinkButton>
      ) : null}
    </Page>
  );
}
