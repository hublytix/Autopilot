'use client';

import { useActionState, type ReactNode } from 'react';
import { Alert, buttonClasses, Card, Field, fieldDescription, Input, SubmitButton, Textarea } from '@/components/ui';
import type { EditFieldErrors, EditFormState, EditLimits, EditReadyView } from '@/server/http/action-links/edit';
import { CopyButton } from '../copy/CopyButton';

// The "Edit first" form and its result (PLAN §7.4, D-13). The form posts to the page's Server Action;
// the answer is the result page itself (a 200 with the compose link as a button, never a redirect),
// with JavaScript or without it (useActionState's progressive enhancement). The result offers
// "Send from my email" (the owner's compose link, built from the edited text), "Open in default
// mail app" and "Copy your reply"; the validator's notes are hints, never a block. Nothing typed
// here is saved: the edited text exists only in this page.

export interface EditReplyProps {
  action: (state: EditFormState, formData: FormData) => Promise<EditFormState>;
  token: string;
  /** The draft, to start from. */
  draft: { subject: string; body: string };
  recipient: string | null;
  recipientValid: boolean;
  bcc: string | null;
  limits: EditLimits;
}

const MUTED = 'text-sm text-neutral-700 dark:text-neutral-300';
const BREAK = 'break-words [overflow-wrap:anywhere]';

function RecipientLines({ recipient, recipientValid, bcc }: { recipient: string | null; recipientValid: boolean; bcc: string | null }) {
  return (
    <div className="flex flex-col gap-1 text-base">
      <p className={BREAK}>
        <span className="font-semibold">To:</span> {recipient ?? 'no address on file'}
      </p>
      {recipientValid ? null : (
        <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
          {recipient === null
            ? 'This lead has no email address on file, so you will need to add the recipient yourself.'
            : 'This address looks unusual, so it is not put into a compose link. Check it before you send.'}
        </p>
      )}
      {bcc === null ? null : (
        <>
          <p className={BREAK}>
            <span className="font-semibold">BCC:</span> {bcc}
          </p>
          <p className={MUTED}>This address lets HubSpot log your email. Some mail apps leave the BCC out: if it is missing, add it by hand.</p>
        </>
      )}
    </div>
  );
}

interface EditFieldsProps {
  formAction: (formData: FormData) => void;
  token: string;
  values: { subject: string; body: string };
  errors: EditFieldErrors;
  limits: EditLimits;
  idPrefix: string;
}

function EditFields({ formAction, token, values, errors, limits, idPrefix }: EditFieldsProps) {
  const subjectId = `${idPrefix}-subject`;
  const bodyId = `${idPrefix}-body`;
  return (
    <form action={formAction} className="flex flex-col gap-5">
      <input type="hidden" name="token" value={token} />
      <Field id={subjectId} label="Subject" error={errors.subject}>
        <Input
          id={subjectId}
          name="subject"
          type="text"
          defaultValue={values.subject}
          maxLength={limits.subjectMaxChars}
          required
          autoComplete="off"
          describedBy={fieldDescription(subjectId, { error: errors.subject !== undefined })}
          invalid={errors.subject !== undefined}
        />
      </Field>
      <Field id={bodyId} label="Your reply" error={errors.body}>
        <Textarea
          id={bodyId}
          name="body"
          defaultValue={values.body}
          rows={14}
          maxLength={limits.bodyMaxChars}
          required
          describedBy={fieldDescription(bodyId, { error: errors.body !== undefined })}
          invalid={errors.body !== undefined}
        />
      </Field>
      <SubmitButton pendingLabel="Preparing…">Done editing</SubmitButton>
    </form>
  );
}

interface CopyPartProps {
  id: string;
  title: string;
  /** Lower case, for "Copy {label}". */
  label: string;
  value: string;
  multiline?: boolean;
}

function CopyPart({ id, title, label, value, multiline = false }: CopyPartProps) {
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-2">
      <h3 id={`${id}-title`} className="text-base font-semibold">
        {title}
      </h3>
      <div
        className={
          'rounded-md border border-neutral-300 bg-neutral-50 px-3 py-2 text-base dark:border-neutral-700 dark:bg-neutral-950 ' +
          BREAK +
          (multiline ? ' whitespace-pre-wrap' : '')
        }
      >
        {value}
      </div>
      <CopyButton text={value} label={label} />
    </section>
  );
}

function readyMessage(reply: EditReadyView): string {
  if (reply.sendUrl !== null) return `Tap "Send from my email" to open it in ${reply.sendTarget ?? 'your mail app'}, then send it from there.`;
  if (reply.copyReason === 'too_long') return 'It is too long to fill in a new email automatically, so copy each part into a new email in your mail app.';
  return 'Copy each part into a new email in your mail app, then send it from there.';
}

export interface ReplyReadyProps {
  reply: EditReadyView;
  /** The form for more changes (pre-filled with the edited text). */
  children?: ReactNode;
}

/** The result page: links built from the edited text, the copy view and the hints. */
export function ReplyReady({ reply, children }: ReplyReadyProps) {
  const copyOnly = reply.sendUrl === null;
  return (
    <div className="flex flex-col gap-6">
      <Alert tone="success" title="Your edited reply is ready">
        <p>{readyMessage(reply)}</p>
      </Alert>
      {reply.hints.length === 0 ? null : (
        <Alert tone="warning" title="Before you send, check these">
          <p>Our checks noticed something in your reply. You can still send it as it is.</p>
          <ul className="list-disc space-y-1 pl-5">
            {reply.hints.map((hint) => (
              <li key={hint.code}>{hint.text}</li>
            ))}
          </ul>
        </Alert>
      )}
      <Card>
        <RecipientLines recipient={reply.recipient} recipientValid={reply.recipientValid} bcc={reply.bcc} />
        <p className={BREAK}>
          <span className="font-semibold">Subject:</span> {reply.subject}
        </p>
        {reply.sendUrl === null && reply.mailtoUrl === null ? null : (
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            {reply.sendUrl === null ? null : (
              <a href={reply.sendUrl} rel="noreferrer" className={buttonClasses('primary')}>
                Send from my email
              </a>
            )}
            {reply.mailtoUrl === null ? null : (
              <a href={reply.mailtoUrl} rel="noreferrer" className={buttonClasses(copyOnly ? 'primary' : 'secondary')}>
                Open in default mail app
              </a>
            )}
          </div>
        )}
      </Card>
      <details open={copyOnly} className="rounded-xl border border-neutral-300 dark:border-neutral-700">
        <summary className="flex min-h-11 cursor-pointer items-center px-5 py-2">
          <h2 className="text-base font-semibold">Copy your reply</h2>
        </summary>
        <div className="flex flex-col gap-5 px-5 pt-2 pb-5">
          {reply.recipient === null ? null : <CopyPart id="copy-to" title="To" label="recipient" value={reply.recipient} />}
          <CopyPart id="copy-subject" title="Subject" label="subject" value={reply.subject} />
          <CopyPart id="copy-message" title="Message" label="message" value={reply.body} multiline />
          {reply.bcc === null ? null : <CopyPart id="copy-bcc" title="BCC" label="BCC address" value={reply.bcc} />}
        </div>
      </details>
      {children === undefined ? null : (
        <details className="rounded-xl border border-neutral-300 dark:border-neutral-700">
          <summary className="flex min-h-11 cursor-pointer items-center px-5 py-2">
            <h2 className="text-base font-semibold">Make more changes</h2>
          </summary>
          <div className="px-5 pt-2 pb-5">{children}</div>
        </details>
      )}
    </div>
  );
}

function StateMessage({ title, paragraphs }: { title: string; paragraphs: readonly string[] }) {
  return (
    <Alert tone="error" title={title}>
      {paragraphs.map((text) => (
        <p key={text}>{text}</p>
      ))}
    </Alert>
  );
}

export function EditReply({ action, token, draft, recipient, recipientValid, bcc, limits }: EditReplyProps) {
  const [state, formAction] = useActionState(action, { type: 'idle' });

  if (state.type === 'message') return <StateMessage title={state.message.title} paragraphs={state.message.paragraphs} />;
  if (state.type === 'ready') {
    return (
      <ReplyReady reply={state.reply}>
        <EditFields formAction={formAction} token={token} values={state.reply} errors={{}} limits={limits} idPrefix="again" />
      </ReplyReady>
    );
  }
  const values = state.type === 'input_error' ? { subject: state.subject, body: state.body } : draft;
  const errors = state.type === 'input_error' ? state.errors : {};
  return (
    <Card>
      <RecipientLines recipient={recipient} recipientValid={recipientValid} bcc={bcc} />
      <EditFields formAction={formAction} token={token} values={values} errors={errors} limits={limits} idPrefix="edit" />
    </Card>
  );
}
