import 'server-only';
import { load, type CheerioAPI } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';

// Page extraction for the brief (PLAN §9.7, §10.5, D-47). Only what a visitor sees reaches the model:
// 1. Never content: script, style, noscript, svg, iframe, template, embedded objects, form controls,
//    comments, and hidden DOM (the `hidden` attribute, aria-hidden="true", inline display:none /
//    visibility:hidden / opacity:0 / font-size:0, well-known hiding classes, closed dialogs).
// 2. Links for the crawl are read from what is left (navigation menus included).
// 3. nav, header and footer are then removed too, and the rest becomes the page text: block
//    elements on their own lines, an off-site or booking-looking link's URL written after its text.
// 4. `visibleUrls` (the hrefs of the links left in step 3 plus URLs written in the text) is the only
//    place a generated booking link may come from (D-47).
// The HTML is parsed with parse5 (cheerio's default), the parser browsers follow.

export interface PageLink {
  /** Absolute http(s) URL without its fragment. */
  url: string;
  /** The link text (or its aria-label/title), whitespace collapsed. */
  text: string;
}

export interface ExtractedPage {
  /** The page's final URL. */
  url: string;
  title: string;
  /** Visible main text (no nav, header, footer, scripts or hidden DOM), one block per line. */
  text: string;
  /** Links outside hidden DOM, navigation included: the crawl's candidates. */
  links: PageLink[];
  /** Absolute http(s) URLs in the visible text and its links: where a booking link must appear. */
  visibleUrls: string[];
}

const NEVER_CONTENT = [
  'script',
  'style',
  'noscript',
  'svg',
  'math',
  'iframe',
  'frame',
  'frameset',
  'template',
  'object',
  'embed',
  'applet',
  'canvas',
  'audio',
  'video',
  'source',
  'track',
  'map',
  'link',
  'meta',
  'base',
  'input',
  'select',
  'option',
  'optgroup',
  'datalist',
  'textarea',
  'button',
  'dialog:not([open])',
].join(', ');

const HIDDEN_ATTRIBUTES = '[hidden], [aria-hidden="true" i], [type="hidden" i]';

/** Classes common CSS frameworks use to hide content (Bootstrap, Tailwind, WordPress, …). */
const HIDING_CLASSES = new Set([
  'hidden',
  'hide',
  'd-none',
  'invisible',
  'is-hidden',
  'u-hidden',
  'sr-only',
  'visually-hidden',
  'screen-reader-text',
]);

/** Inline styles that hide an element from sighted visitors. */
const HIDING_STYLE =
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|content-visibility\s*:\s*hidden|(?:opacity|font-size)\s*:\s*(?:0+(?:\.0*)?|\.0+)(?:px|em|rem|pt|%)?\s*(?:!important\s*)?(?:;|$))/i;

const STRUCTURAL = 'nav, header, footer';

const BLOCK_ELEMENTS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'caption',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'html',
  'label',
  'legend',
  'li',
  'main',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'tfoot',
  'thead',
  'tr',
  'ul',
]);

/** A link whose URL is worth writing into the text even on the same site. */
const BOOKING_LIKE = /book|schedul|appointment|calendar|reserv|calendly|\/visit/i;

/** http(s) URLs written in text; trailing punctuation is trimmed after matching. */
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`()[\]{}|\\^]+/gi;

const MAX_TITLE = 200;
const MAX_LINK_TEXT = 200;

function collapse(text: string): string {
  return text.replace(/[\s ​﻿]+/g, ' ').trim();
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

function absoluteHttpUrl(href: string | undefined, base: string): string | null {
  if (href === undefined) return null;
  const trimmed = href.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;
  let url: URL;
  try {
    url = new URL(trimmed, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  return url.href;
}

function siteHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function isElement(node: AnyNode): node is Element {
  return node.type === 'tag' || node.type === 'script' || node.type === 'style';
}

function isHiddenByClassOrStyle(element: Element): boolean {
  const style = element.attribs.style;
  if (style !== undefined && HIDING_STYLE.test(style)) return true;
  const classes = element.attribs.class;
  if (classes === undefined) return false;
  return classes.split(/\s+/).some((name) => HIDING_CLASSES.has(name.toLowerCase()));
}

/** Removes comments, processing instructions and CDATA everywhere, and hidden elements. */
function removeInvisible($: CheerioAPI): void {
  $(NEVER_CONTENT).remove();
  $(HIDDEN_ATTRIBUTES).remove();
  const stack: AnyNode[] = [...$.root().contents().toArray()];
  const doomed: AnyNode[] = [];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (node.type === 'comment' || node.type === 'directive' || node.type === 'cdata') {
      doomed.push(node);
      continue;
    }
    if (isElement(node)) {
      if (isHiddenByClassOrStyle(node)) {
        doomed.push(node);
        continue;
      }
      stack.push(...node.children);
    } else if (node.type === 'root') {
      stack.push(...node.children);
    }
  }
  for (const node of doomed) $(node).remove();
}

/** The base for relative links: `<base href>` when it is a usable http(s) URL. */
function baseUrlOf($: CheerioAPI, pageUrl: string): string {
  return absoluteHttpUrl($('base[href]').first().attr('href'), pageUrl) ?? pageUrl;
}

function collectLinks($: CheerioAPI, base: string): PageLink[] {
  const links: PageLink[] = [];
  $('a[href], area[href]').each((_, element) => {
    const url = absoluteHttpUrl($(element).attr('href'), base);
    if (url === null) return;
    const label = collapse($(element).text()) || collapse($(element).attr('aria-label') ?? '') || collapse($(element).attr('title') ?? '');
    links.push({ url, text: cut(label, MAX_LINK_TEXT) });
  });
  return links;
}

/** Writes the visible text: block elements on their own lines, cells separated, link URLs inline where useful. */
function renderText(root: AnyNode[], base: string, pageHost: string | null): string {
  const out: string[] = [];
  const newline = (): void => {
    out.push('\n');
  };
  const walk = (node: AnyNode): void => {
    if (node.type === 'text') {
      out.push(node.data);
      return;
    }
    if (!isElement(node)) return;
    const name = node.name.toLowerCase();
    if (name === 'br') {
      newline();
      return;
    }
    const block = BLOCK_ELEMENTS.has(name);
    if (block) newline();
    const cell = name === 'td' || name === 'th';
    if (cell) out.push(' ');
    const start = out.length;
    for (const child of node.children) walk(child);
    if (cell) out.push(' ');
    if (name === 'a') {
      const url = absoluteHttpUrl(node.attribs.href, base);
      const shown = collapse(out.slice(start).join(''));
      if (url !== null && !shown.includes(url) && (siteHost(url) !== pageHost || BOOKING_LIKE.test(url))) out.push(` (${url})`);
    }
    if (block) newline();
  };
  for (const node of root) walk(node);
  const lines: string[] = [];
  for (const raw of out.join('').split('\n')) {
    const line = collapse(raw);
    if (line.length > 0 && line !== lines.at(-1)) lines.push(line);
  }
  return lines.join('\n');
}

function urlsInText(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const url = absoluteHttpUrl(match[0].replace(/[.,;:!?]+$/, ''), 'https://invalid.invalid/');
    if (url !== null) found.push(url);
  }
  return found;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export interface ExtractInput {
  /** The page's final URL (after redirects). */
  url: string;
  contentType: string;
  body: string;
}

/** Extracts one fetched page (HTML or plain text). */
export function extractPage(page: ExtractInput): ExtractedPage {
  const mediaType = (page.contentType.split(';')[0] ?? '').trim().toLowerCase();
  if (mediaType === 'text/plain') {
    const text = page.body
      .split(/\r\n|\r|\n/)
      .map(collapse)
      .filter((line) => line.length > 0)
      .join('\n');
    return { url: page.url, title: '', text, links: [], visibleUrls: unique(urlsInText(text)) };
  }

  const $ = load(page.body);
  const title = cut(collapse($('head > title, title').first().text()), MAX_TITLE);
  const base = baseUrlOf($, page.url);
  $('head').remove();
  removeInvisible($);
  const links = collectLinks($, base);

  $(STRUCTURAL).remove();
  const visibleLinks = collectLinks($, base).map((link) => link.url);
  const body = $('body');
  const roots = body.length > 0 ? body.toArray() : $.root().contents().toArray();
  const text = renderText(roots, base, siteHost(page.url));
  return { url: page.url, title, text, links, visibleUrls: unique([...visibleLinks, ...urlsInText(text)]) };
}
