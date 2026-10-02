// The owner's browser as the simulation drives it (pre-run and Day 0): the address it comes from,
// its user agent, and the action links an owner email carries. Only the HMAC of the address is
// stored (rate limits); the tokens are never written to summary.json.

/** The owner's address (TEST-NET-2). */
export const OWNER_IP = '198.51.100.7';

/** A desktop browser: "Send from my email" with Gmail opens the web compose window (302). */
export const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** The action links of one owner email (PLAN §7.4): the token of each button, null when absent. */
export interface EmailActionLinks {
  /** "Send from my email": `/a/{token}/send`. */
  readonly send: string | null;
  /** "Edit first": `/a/{token}/edit`. */
  readonly edit: string | null;
  /** "Not a real lead": `/a/{token}/dismiss`. */
  readonly dismiss: string | null;
  /** "Open in default mail app": the send token again, as `/a/{token}/send?via=mailto`. */
  readonly mailto: string | null;
}

const TOKEN = 'apt_[A-Za-z0-9_-]{43}';

function first(text: string, pattern: RegExp): string | null {
  return pattern.exec(text)?.[1] ?? null;
}

/** The action-link tokens in an email's plain-text part (one link per line, PLAN §7.4). */
export function emailActionLinks(text: string): EmailActionLinks {
  return {
    send: first(text, new RegExp(`/a/(${TOKEN})/send(?![?\\w])`)),
    edit: first(text, new RegExp(`/a/(${TOKEN})/edit(?![?\\w])`)),
    dismiss: first(text, new RegExp(`/a/(${TOKEN})/dismiss(?![?\\w])`)),
    mailto: first(text, new RegExp(`/a/(${TOKEN})/send\\?via=mailto(?![&\\w])`)),
  };
}
