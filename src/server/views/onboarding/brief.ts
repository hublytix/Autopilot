import 'server-only';
import type { BriefFormValues } from '@/server/actions/onboarding/types';
import type { Deps } from '@/server/ports';
import type { OwnerScope } from '@/server/services/auth';
import { BRIEF_FIELD_LIMITS, BRIEF_JOBS_PER_DAY, getLatestBrief, MAX_FAQS, type BriefEditorState } from '@/server/services/brief';

// /onboarding/brief's read side (PLAN §7.5): the editor's state (generated, saved or empty), the
// form's starting values, the booking link to confirm (with its host), the website address to
// suggest, and the field limits for the inputs.

export interface BriefPageView {
  editor: BriefEditorState;
  /** What the website field starts with: the last address asked for, else the portal's own domain. */
  suggestedUrl: string;
  initialValues: BriefFormValues;
  /** The link the editor offers to confirm: found on the site (generated) or saved before. */
  bookingLink: { url: string; host: string; source: 'generated' | 'owner' } | null;
  limits: typeof BRIEF_FIELD_LIMITS;
  generationsPerDay: number;
}

function initialValues(editor: BriefEditorState, bookingLink: BriefPageView['bookingLink']): BriefFormValues {
  const { brief, origin } = editor.form;
  const savedChoice = origin === 'owner' ? (editor.saved?.bookingLinkChoice ?? 'unset') : 'unset';
  const faqs = brief.faqs.slice(0, MAX_FAQS).map((faq) => ({ q: faq.q, a: faq.a }));
  while (faqs.length < MAX_FAQS) faqs.push({ q: '', a: '' });
  return {
    company_name: brief.company_name,
    one_line: brief.one_line,
    services: brief.services.join('\n'),
    who_we_serve: brief.who_we_serve,
    tone_style: brief.tone.style,
    tone_note: brief.tone.note,
    sign_off_name: brief.sign_off_name,
    // Off unless the owner turned it on themselves (generated briefs always say false, D-24).
    allow_pricing: origin === 'owner' && brief.allow_pricing,
    never_promise: brief.never_promise.join('\n'),
    faqs,
    // The owner picks explicitly; only a saved choice is pre-selected.
    booking_choice: savedChoice === 'none' ? 'none' : savedChoice === 'link' && bookingLink !== null ? 'found' : '',
    booking_link_found: bookingLink?.url ?? '',
    booking_link_other: '',
  };
}

export async function briefPageView(scope: OwnerScope, deps: Deps): Promise<BriefPageView> {
  const editor = await getLatestBrief(scope, deps);
  let suggestedUrl = editor.sourceUrl ?? '';
  if (suggestedUrl === '') {
    const row = await deps.db.maybeOne<{ hub_domain: string | null }>(`select hub_domain from hubspot_connections where account_id = $1`, [scope.accountId]);
    const domain = row?.hub_domain?.trim() ?? '';
    // hub_domain is the portal's own website domain (D-12); only a plain host name is suggested.
    if (/^[a-z0-9.-]{1,253}$/i.test(domain) && domain.includes('.')) suggestedUrl = `https://${domain.toLowerCase()}`;
  }
  const start = editor.form.origin === 'empty' ? null : editor.form.origin === 'owner' ? editor.saved : editor.latest;
  const url = editor.form.brief.booking_link;
  const host = start?.bookingLinkHost ?? null;
  const bookingLink = url !== null && host !== null && editor.form.origin !== 'empty' ? { url, host, source: editor.form.origin } : null;
  return {
    editor,
    suggestedUrl,
    initialValues: initialValues(editor, bookingLink),
    bookingLink,
    limits: BRIEF_FIELD_LIMITS,
    generationsPerDay: BRIEF_JOBS_PER_DAY,
  };
}
