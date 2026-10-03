import { HUBSPOT_DISCLOSURE, INSTALL_PERMISSION_NOTE, PRICE_LINE, SiteFooter } from '@/components/marketing';

// The landing page (brief §1, §5.13, PLAN §7.2): the one-liner, how it works in three steps, the
// price, the Install button with who can install, and an honest list of what Autopilot does and
// doesn't do (laws 1, 2, 4, 5). Public: no personal data, so the proxy leaves it cacheable.

const productName = process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'Hublytix Autopilot';

// Brief §5.13 requires brief §1's one-liner word for word; read literally it overstates (laws 1 and 5:
// Autopilot drafts and the owner sends, and not every submission gets a draft). This line sits right
// under it, and the list below spells out the rest (D-83, D-86).
const ONE_LINER_QUALIFIER = 'It drafts your replies and follow-ups; you send each one yourself, from your own mail app.';

const STEPS = [
  { title: 'A lead fills in your HubSpot form.', detail: 'Autopilot reads the new submission from HubSpot.' },
  { title: 'You get an email with your reply already drafted.', detail: 'It is written for that lead, from the summary of your business you approved at setup.' },
  { title: 'One tap opens your own mail app with your reply filled in.', detail: 'Read it, change anything you like, and press send yourself.' },
] as const;

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-10 px-4 py-10 sm:px-6 sm:py-14">
      <header className="space-y-4">
        <p className="text-sm font-medium text-neutral-600 dark:text-neutral-400">For HubSpot Free and Starter</p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{productName}</h1>
        <p className="text-lg leading-relaxed text-neutral-700 dark:text-neutral-300">
          {productName} answers and follows up every new lead automatically for HubSpot Starter users — the follow-up HubSpot only
          offers on Professional — for $49 a month.
        </p>
        <p className="text-base text-neutral-700 dark:text-neutral-300">{ONE_LINER_QUALIFIER}</p>
      </header>

      <section aria-labelledby="install-heading" className="space-y-3">
        <h2 id="install-heading" className="sr-only">
          Price and install
        </h2>
        <p className="text-xl font-semibold">{PRICE_LINE}</p>
        <p className="text-base text-neutral-700 dark:text-neutral-300">No card needed to start the trial.</p>
        {/* A plain link: the install route redirects to HubSpot, so it must not be prefetched. */}
        <a
          href="/api/hubspot/install"
          className="inline-flex min-h-11 w-full items-center justify-center rounded-md bg-neutral-900 px-5 py-3 text-base font-semibold text-white hover:bg-neutral-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 sm:w-auto dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 dark:focus-visible:outline-blue-400"
        >
          Install with HubSpot
        </a>
        <p className="text-sm text-neutral-700 dark:text-neutral-300">{INSTALL_PERMISSION_NOTE}</p>
      </section>

      <section aria-labelledby="how-heading" className="space-y-4">
        <h2 id="how-heading" className="text-xl font-semibold">
          How it works
        </h2>
        <ol className="flex flex-col gap-4">
          {STEPS.map((step, index) => (
            <li key={step.title} className="flex gap-4">
              <span
                aria-hidden="true"
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-sm font-semibold text-white dark:bg-neutral-100 dark:text-neutral-900"
              >
                {index + 1}
              </span>
              <div className="space-y-1">
                <p className="text-base font-semibold">{step.title}</p>
                <p className="text-base text-neutral-700 dark:text-neutral-300">{step.detail}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="text-base text-neutral-700 dark:text-neutral-300">
          On day 2 and day 5, {productName} drafts a follow-up for you to send, unless HubSpot shows that the lead replied. Every
          Monday you get a short report.
        </p>
      </section>

      <section aria-labelledby="honest-heading" className="space-y-3">
        <h2 id="honest-heading" className="text-xl font-semibold">
          What it does, and what it doesn&apos;t
        </h2>
        <ul className="list-disc space-y-2 pl-5 text-base text-neutral-700 dark:text-neutral-300">
          <li>It only drafts. It never sends email for you: you send your replies yourself, from your own mail app.</li>
          <li>It never connects to your Gmail or Outlook account.</li>
          <li>{HUBSPOT_DISCLOSURE}</li>
          <li>Your sends and your leads&apos; replies count only when HubSpot shows them.</li>
          <li>If your emails aren&apos;t logged in HubSpot, the dashboard and the Monday report say so instead of guessing.</li>
          <li>
            Spam and other submissions that aren&apos;t leads get no draft, and neither do leads over the daily limit; the dashboard
            lists both. Leads that arrive while it is paused, or while your trial or subscription isn&apos;t active, aren&apos;t read
            at all, so check those in HubSpot.
          </li>
          <li>Drafts are written by AI, so read each one before you send it.</li>
          <li>Lead messages and drafts are deleted 30 days after the form was submitted.</li>
        </ul>
      </section>

      <SiteFooter productName={productName} />
    </main>
  );
}
