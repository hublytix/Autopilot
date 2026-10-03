import 'server-only';

// The plain-text states every action-link page shares (route-handler HTML and the React copy page),
// so the wording stays the same everywhere. Honest copy (law 5): nothing here claims a send.

export interface PageMessage {
  readonly title: string;
  readonly paragraphs: readonly string[];
}

export const ACTION_LINK_MESSAGES = {
  /** A token that is unknown, of another purpose, expired, revoked, or whose account is disconnected: one neutral answer. */
  invalid: {
    title: "This link isn't available",
    paragraphs: [
      'It may have expired (links in lead emails work for 7 days), or the account may have been disconnected.',
      'Check that you opened the whole link from the email.',
    ],
  },
  /** The draft's content was deleted (D-49). */
  expired: {
    title: 'This draft has expired',
    paragraphs: [
      'Drafts and lead details are deleted 30 days after the form was submitted (24 hours for test leads), so your reply can no longer be opened.',
      'The contact is still in HubSpot.',
    ],
  },
  rateLimited: {
    title: 'Too many attempts',
    paragraphs: ['Please wait a minute, then open the link again.'],
  },
  unavailable: {
    title: 'Something went wrong',
    paragraphs: ['We could not open your reply just now. Please try the link again in a minute.'],
  },
} as const satisfies Record<string, PageMessage>;

/** Law 1, said where the owner acts. */
export function neverSendsLine(productName: string): string {
  return `${productName} never sends email for you: your reply goes out only when you send it from your own mail app.`;
}
