import 'server-only';
import type { BriefDraft, BriefFaq, GenerateBriefInput } from '@/server/ports/llm';

// The fake's "model" for the business brief: plain heuristics over the extracted page text. It never
// follows instructions found in the text, and it does not cap `faqs` (callers enforce ≤ 8, D-24).

/** Phrases every generated fake brief starts with; drafts from the fake never contain them. */
export const FAKE_NEVER_PROMISE = ['Exact prices before seeing the job', 'Discounts or special offers', 'Arrival times we have not confirmed'];

const QUESTION_START = /(?:^|\s)((?:Do|Does|Can|Could|What|How|Which|Are|Is|Will|Why|When|Where|Who|Should)\b[^?]*\?)$/;

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function capitalise(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`;
}

function sentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map(clean)
    .filter((s) => s.length > 0);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The host's words as the pages spell them ("brightside-plumbing" → "Brightside Plumbing"), else a heading. */
function companyName(all: string, sourceUrl: string): string {
  const words = (hostOf(sourceUrl)?.split('.')[0] ?? '').split('-').filter(Boolean);
  if (words.length > 0) {
    const asWritten = new RegExp(`\\b${words.map(escapeRegex).join('\\s+')}\\b`, 'i').exec(all);
    if (asWritten !== null) return clean(asWritten[0]);
  }
  const welcome = /\bWelcome to ((?:[A-Z][\w'&-]*)(?: [A-Z][\w'&-]*){0,3})/.exec(all);
  if (welcome?.[1] !== undefined) return clean(welcome[1]);
  const fromHost = words.map(capitalise).join(' ');
  return fromHost.length > 0 ? fromHost : 'Our company';
}

function services(all: string): string[] {
  const match = /(?:Services we offer|Our services(?: include)?|We offer)\s*:?\s*([^.\n]+)\./i.exec(all);
  if (match?.[1] === undefined) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of match[1].split(',')) {
    const item = capitalise(clean(raw).replace(/^and\s+/i, ''));
    if (item.length < 2 || item.length > 80 || seen.has(item.toLowerCase())) continue;
    seen.add(item.toLowerCase());
    result.push(item);
  }
  return result.slice(0, 12);
}

function whoWeServe(all: string): string {
  const serve = /\bWe serve ([^.\n]+)\./i.exec(all);
  if (serve?.[1] !== undefined) return capitalise(clean(serve[1]));
  const serving = /\bserving ([^.\n]+?)(?: since [^.\n]+)?\./i.exec(all);
  if (serving?.[1] !== undefined) return `Customers in ${clean(serving[1])}`;
  return 'Local customers';
}

function bookingLink(all: string): string | null {
  const urls = [...all.matchAll(/https:\/\/[^\s<>"'()[\]]+/g)].map((m) => m[0].replace(/[.,;:!?]+$/, ''));
  return urls.find((u) => /book|calendly|cal\.|schedul|appointment|\/visit/i.test(u)) ?? null;
}

function signOffName(all: string, company: string): string {
  const person = /\b(?:[Ff]ounded by|[Oo]wner,?|[Mm]y name is|I'm|I am) ([A-Z][a-z]+(?: [A-Z][a-z]+)?)/.exec(all);
  return person?.[1] ?? `The ${company} team`;
}

function oneLine(all: string, company: string, serviceList: readonly string[]): string {
  for (const sentence of sentences(all)) {
    // Start at "<Company> is …", dropping any heading the text extraction ran into the sentence.
    const at = sentence.search(new RegExp(`${escapeRegex(company)} (?:is|are) `));
    if (at >= 0 && sentence.length - at <= 200) return sentence.slice(at);
  }
  return serviceList.length > 0 ? `${company}: ${serviceList.slice(0, 3).join(', ')}.` : `${company} serves local customers.`;
}

function faqs(faqTexts: readonly string[]): BriefFaq[] {
  const result: BriefFaq[] = [];
  for (const text of faqTexts) {
    let question: string | null = null;
    let answer: string[] = [];
    const flush = (): void => {
      if (question !== null && answer.length > 0) result.push({ q: question, a: answer.join(' ') });
      question = null;
      answer = [];
    };
    for (const sentence of sentences(text)) {
      if (sentence.endsWith('?')) {
        flush();
        question = QUESTION_START.exec(sentence)?.[1] ?? sentence;
      } else if (question !== null && answer.length < 3) {
        answer.push(sentence);
      }
    }
    flush();
  }
  return result;
}

export function briefFromPages(input: GenerateBriefInput): BriefDraft {
  const all = input.pages.map((p) => p.text).join('\n');
  const company = companyName(all, input.sourceUrl);
  const serviceList = services(all);
  return {
    company_name: company,
    one_line: oneLine(all, company, serviceList),
    services: serviceList,
    who_we_serve: whoWeServe(all),
    booking_link: bookingLink(all),
    tone: { style: 'friendly', note: 'Warm and plain-spoken; explain the next step clearly.' },
    sign_off_name: signOffName(all, company),
    allow_pricing: false,
    never_promise: [...FAKE_NEVER_PROMISE],
    faqs: faqs(input.pages.filter((p) => /faq/i.test(p.url)).map((p) => p.text)),
  };
}
