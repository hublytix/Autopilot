import 'server-only';
import type { PageLink } from './extract';
import { isSameSite } from './site-url';

// Page selection (brief §5.3, PLAN §9.7, D-47): the homepage's same-site links, ranked by the
// keywords services|pricing|about|contact|faq in the path (weighs more) or the link text (whole
// words, in labels of at most 5 words, so a blog title "…is about to fail" does not count), then in
// the order the homepage lists them. Links to files that are not pages, and the homepage itself,
// are dropped; a link listed twice keeps its first position and every text it was given.

export const PAGE_KEYWORDS = ['services', 'pricing', 'about', 'contact', 'faq'] as const;

/** File types that are never a readable page (the fetcher would refuse them as bad_content_type). */
const NOT_A_PAGE = /\.(?:pdf|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|zip|gz|tgz|rar|7z|mp3|mp4|m4a|mov|avi|webm|wav|docx?|xlsx?|pptx?|odt|ics|xml|json|css|js|woff2?|ttf|eot|exe|dmg|apk)$/i;

export interface RankedLink {
  url: string;
  score: number;
}

/** Keywords in a path: any substring (`/our-services`, `/faqs`, `/about-us`). */
function keywordsInPath(path: string): number {
  const lower = path.toLowerCase();
  return PAGE_KEYWORDS.filter((keyword) => lower.includes(keyword)).length;
}

/** A link text this long reads as a sentence (a blog title), not a menu label. */
const MAX_LABEL_WORDS = 5;
const KEYWORD_WORDS = PAGE_KEYWORDS.map((keyword) => new RegExp(`\\b${keyword}\\b`, 'i'));

/** Keywords in the link's labels: whole words, and only in short, menu-like labels. */
function keywordsInLabels(texts: readonly string[]): number {
  const labels = texts.filter((text) => text.split(/\s+/).filter(Boolean).length <= MAX_LABEL_WORDS).join(' ');
  return KEYWORD_WORDS.filter((pattern) => pattern.test(labels)).length;
}

function withoutTrailingSlash(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = '';
  if (copy.pathname.length > 1) copy.pathname = copy.pathname.replace(/\/+$/, '');
  return copy.href;
}

function decodedPath(url: URL): string {
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return url.pathname;
  }
}

/** Ranks the homepage's links; the caller takes them in order. */
export function rankLinks(links: readonly PageLink[], homepage: string): RankedLink[] {
  const home = new URL(homepage);
  const homeKey = withoutTrailingSlash(home);
  const seen = new Map<string, { url: string; order: number; texts: string[] }>();
  links.forEach((link, order) => {
    let url: URL;
    try {
      url = new URL(link.url);
    } catch {
      return;
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !isSameSite(url, home) || NOT_A_PAGE.test(url.pathname)) return;
    const key = withoutTrailingSlash(url);
    if (key === homeKey) return;
    const entry = seen.get(key);
    if (entry === undefined) seen.set(key, { url: url.href, order, texts: [link.text] });
    else entry.texts.push(link.text);
  });
  return [...seen.values()]
    .map((entry) => {
      const url = new URL(entry.url);
      const score = 2 * keywordsInPath(`${decodedPath(url)}${url.search}`) + keywordsInLabels(entry.texts);
      return { url: entry.url, score, order: entry.order };
    })
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ url, score }) => ({ url, score }));
}
