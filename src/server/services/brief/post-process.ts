import 'server-only';
import type { BriefDraft } from '@/server/ports/llm';
import { acceptGeneratedBookingLink } from './booking-link';
import { BRIEF_FIELD_LIMITS, cleanText, cutText } from './schema';

// What code decides about a generated brief, whatever the model said (brief §5.3, PLAN §9.7, D-24,
// D-47):
// - allow_pricing is always false (the owner opts in);
// - FAQs are capped at 8 (empty ones dropped first);
// - the booking link survives only if it is https and appears in the fetched visible pages;
// - never_promise items are trimmed, emptied ones dropped, duplicates removed;
// - every text is cleaned and cut to the owner form's limits, so the editor can save it as it is.

function list(values: readonly string[], maxItems: number, maxLength: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = cutText(cleanText(raw), maxLength);
    const key = value.toLowerCase();
    if (value.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length === maxItems) break;
  }
  return out;
}

export function postProcessBrief(draft: BriefDraft, context: { visibleUrls: readonly string[] }): BriefDraft {
  const L = BRIEF_FIELD_LIMITS;
  const faqs = draft.faqs
    .map((faq) => ({ q: cutText(cleanText(faq.q), L.faqQuestion), a: cutText(cleanText(faq.a, true), L.faqAnswer) }))
    .filter((faq) => faq.q.length > 0 && faq.a.length > 0)
    .slice(0, L.faqs);
  return {
    company_name: cutText(cleanText(draft.company_name), L.companyName),
    one_line: cutText(cleanText(draft.one_line), L.oneLine),
    services: list(draft.services, L.services, L.service),
    who_we_serve: cutText(cleanText(draft.who_we_serve), L.whoWeServe),
    booking_link: acceptGeneratedBookingLink(draft.booking_link, context.visibleUrls),
    tone: { style: draft.tone.style, note: cutText(cleanText(draft.tone.note), L.toneNote) },
    sign_off_name: cutText(cleanText(draft.sign_off_name), L.signOffName),
    allow_pricing: false,
    never_promise: list(draft.never_promise, L.neverPromise, L.neverPromiseItem),
    faqs,
  };
}
