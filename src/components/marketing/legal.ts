// The facts the public pages state (brief §5.13, PLAN §7.2, D-03, D-20, D-49). One place, so the
// landing page, the legal pages and their tests say the same thing in the same words.

/** Every legal page is a placeholder until a lawyer has read it (law 5). */
export const LEGAL_TODO = 'TODO: legal review';

/** The price line, as brief §5.13 words it. */
export const PRICE_LINE = '$49/month after a 14-day free trial';

/** Who can install the app in HubSpot. */
export const INSTALL_PERMISSION_NOTE = 'Installing needs a Super Admin or App Marketplace Access permission in HubSpot.';

/** The HubSpot disclosure, word for word as D-03 and PLAN §7.2 give it. */
export const HUBSPOT_DISCLOSURE =
  "Autopilot never changes your HubSpot data. HubSpot's 'forms' permission would also allow edits; Autopilot never makes any. Disconnecting uninstalls the app.";

/** The five properties Autopilot reads from a logged email (D-03, HS-EMAIL-DATA-MINIMISATION), in plain words. */
export const EMAIL_METADATA_NOTE =
  "HubSpot's permission screen says Autopilot may read the content of the emails logged in your HubSpot account. Autopilot asks HubSpot for only five details of each logged email: its time, its direction, its status, and its from and to addresses. It never asks for subjects or bodies, and it compares the addresses in memory without storing them.";

/** The /privacy bullet on the setup baseline (D-38): what is read, where it goes, that none of it is kept. */
export const BASELINE_HEADING = 'Your starting point';
export const BASELINE_NOTE =
  "Once, at setup, we read the last 30 days of submissions on the forms you chose, and the details of the emails logged to those contacts, to measure how you answered leads before. When there are 500 submissions or fewer, each one's message, first name, company and form name go to our AI provider (Anthropic) to be sorted into leads and non-leads, in memory. We keep only the resulting counts and times, never the submissions themselves.";

export interface SubProcessor {
  readonly name: string;
  /** What it does for Autopilot. */
  readonly role: string;
  /** What it receives or holds. */
  readonly data: string;
  /** The provider's own privacy policy. */
  readonly policyUrl: string;
}

/** The data source: not a sub-processor, but named with its policy all the same. */
export const DATA_SOURCE: SubProcessor = {
  name: 'HubSpot',
  role: 'Where your leads come from. Autopilot reads your forms, their submissions, your contacts and the details of logged emails listed above.',
  data: 'Your CRM data stays in HubSpot; Autopilot only reads it.',
  policyUrl: 'https://legal.hubspot.com/privacy-policy',
};

/** Brief §5.13's sub-processors, each with what it does and receives (D-49). */
export const SUB_PROCESSORS: readonly SubProcessor[] = [
  {
    name: 'Anthropic',
    role: 'The AI that sorts each new lead and writes the drafts, and the summary of your business from your website. Once, at setup, it also sorts your recent form submissions to measure your starting point.',
    data: `The lead's form message, first name and company, the form's name, your business brief, and the text of your website's pages when the brief is built. For a follow-up, also your earlier draft. At setup, the same fields of your recent form submissions (see "${BASELINE_HEADING}" above), sorted in memory; nothing from them is stored.`,
    policyUrl: 'https://www.anthropic.com/legal/privacy',
  },
  {
    name: 'Supabase',
    role: 'Our database and sign-in.',
    data: 'Everything listed under "What we store and why". Supabase also keeps backups, and its own records of sign-ins, for as long as its policy says.',
    policyUrl: 'https://supabase.com/privacy',
  },
  {
    name: 'Vercel',
    role: 'Hosts the app.',
    data: 'Every request to the app passes through it, and its request logs record the web address of each request.',
    policyUrl: 'https://vercel.com/legal/privacy-policy',
  },
  {
    name: 'Upstash',
    role: 'The job queue that runs our background work on time.',
    data: 'Job ids only: no names, addresses or messages.',
    policyUrl: 'https://upstash.com/trust/privacy.pdf',
  },
  {
    name: 'Resend',
    role: 'Delivers our emails to you.',
    data: "The emails themselves, which contain the lead's message, name and address and your draft.",
    policyUrl: 'https://resend.com/legal/privacy-policy',
  },
  {
    name: 'Razorpay',
    role: 'Takes payments for the subscription.',
    data: 'Your card and payment details, which never reach us.',
    policyUrl: 'https://razorpay.com/privacy/',
  },
  {
    name: 'Sentry',
    role: 'Error reports, so we can fix what breaks.',
    data: 'Technical details of errors, with messages, drafts, email addresses and access tokens removed before they are sent.',
    policyUrl: 'https://sentry.io/privacy/',
  },
];

export interface LegalLink {
  readonly href: string;
  readonly label: string;
}

/** The legal pages, in footer order. */
export const LEGAL_LINKS: readonly LegalLink[] = [
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
  { href: '/refunds', label: 'Refunds and cancellation' },
  { href: '/shipping', label: 'Shipping and delivery' },
];
