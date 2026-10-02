import 'server-only';

// A minimal, self-contained HTML page for the responses route handlers render themselves
// (GET /auth/confirm and the 429 of POST /auth/confirm). It loads no framework or third-party
// script: the only script is the nonce'd one a caller passes. Mobile-first, readable without CSS,
// 44 px tap targets, visible focus, dark-mode aware. Inline styles are allowed by the CSP
// (style-src 'unsafe-inline'); every interpolated value is escaped.

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

const STYLE = `
:root{color-scheme:light dark;--fg:#18181b;--muted:#3f3f46;--bg:#fff;--card:#fafafa;--border:#d4d4d8;--btn:#18181b;--btn-fg:#fff;--focus:#2563eb}
@media (prefers-color-scheme:dark){:root{--fg:#f4f4f5;--muted:#d4d4d8;--bg:#09090b;--card:#18181b;--border:#3f3f46;--btn:#f4f4f5;--btn-fg:#18181b;--focus:#60a5fa}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:28rem;margin:0 auto;min-height:100dvh;display:flex;flex-direction:column;justify-content:center;gap:1rem;padding:3rem 1rem}
.brand{margin:0;font-size:.875rem;font-weight:600;color:var(--muted)}
h1{margin:0;font-size:1.5rem;line-height:2rem;font-weight:600;letter-spacing:-.01em}
p{margin:0;color:var(--muted)}
.card{border:1px solid var(--border);border-radius:.75rem;background:var(--card);padding:1.25rem;display:flex;flex-direction:column;gap:1rem}
button,.button{display:inline-flex;align-items:center;justify-content:center;min-height:2.75rem;width:100%;padding:.75rem 1.25rem;border:0;border-radius:.5rem;background:var(--btn);color:var(--btn-fg);font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
button:disabled{opacity:.6;cursor:not-allowed}
a{color:inherit;text-underline-offset:4px}
a:focus-visible,button:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.small{font-size:.875rem}
`;

export interface HtmlPageInput {
  /** PRODUCT_NAME. */
  readonly productName: string;
  /** The document title (plain text). */
  readonly title: string;
  /** Trusted markup built by the caller with escapeHtml for every value. */
  readonly body: string;
  /** An inline script, run with `nonce` (CSP). */
  readonly script?: { readonly nonce: string; readonly source: string } | undefined;
}

export function htmlPage(input: HtmlPageInput): string {
  const script =
    input.script === undefined ? '' : `<script nonce="${escapeHtml(input.script.nonce)}">${input.script.source}</script>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="same-origin">
<title>${escapeHtml(input.title)} · ${escapeHtml(input.productName)}</title><style>${STYLE}</style></head>
<body><main><p class="brand">${escapeHtml(input.productName)}</p>${input.body}</main>${script}</body></html>`;
}
