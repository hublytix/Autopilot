import 'server-only';
import { DEV_PANEL_PATH, type DevPanelContext } from './context';
import { formatInstant } from './panel';

// One email of fake mode's outbox (fake.dev_outbox; PLAN §4 "view the outbox", D-29): its headers,
// the HTML for a sandboxed iframe (no scripts: the page gives the iframe no `allow-scripts`), and
// the plain-text part. Links open in a new tab (`<base target="_blank">`), so the action links in
// an email can be tried from here. Fake mode only; an unknown id is a 404.

export interface DevOutboxMail {
  readonly id: string;
  readonly createdAt: string;
  readonly to: string;
  readonly replyTo: string | null;
  readonly subject: string;
  readonly kind: string;
  /** The email's HTML with `<base target="_blank">` added, for `srcdoc`. */
  readonly srcDoc: string;
  readonly text: string;
  readonly backPath: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE = '<base target="_blank">';

/** `html` with links opening in a new tab: the base element goes first in <head> (or first of all without one). */
export function withNewTabLinks(html: string): string {
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (head === null) return `${BASE}${html}`;
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}${BASE}${html.slice(at)}`;
}

interface MailRow {
  id: string;
  created_at: Date;
  to: string[];
  subject: string;
  html: string;
  text: string;
  kind: string;
  meta: { replyTo?: unknown } | null;
}

/** The email with `id`; null outside fake mode, for a malformed id, or when there is no such email. */
export async function buildDevOutboxMail(ctx: DevPanelContext | null, id: string): Promise<DevOutboxMail | null> {
  if (ctx === null || !UUID.test(id)) return null;
  const rows = await ctx.deps.db.query<MailRow>(
    'select id, created_at, "to", subject, html, text, kind, meta from fake.dev_outbox where id = $1',
    [id],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const replyTo = row.meta?.replyTo;
  return {
    id: row.id,
    createdAt: formatInstant(row.created_at),
    to: row.to.join(', '),
    replyTo: typeof replyTo === 'string' ? replyTo : null,
    subject: row.subject,
    kind: row.kind,
    srcDoc: withNewTabLinks(row.html),
    text: row.text,
    backPath: `${DEV_PANEL_PATH}#outbox`,
  };
}
