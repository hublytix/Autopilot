import Link from 'next/link';
import { LEGAL_LINKS } from './legal';

// The public pages' footer: the legal pages and sign-in, as plain links that wrap on a phone.

export interface SiteFooterProps {
  productName: string;
}

const LINK = 'font-medium text-neutral-900 underline underline-offset-4 dark:text-neutral-100';

export function SiteFooter({ productName }: SiteFooterProps) {
  return (
    <footer className="border-t border-neutral-300 pt-6 text-sm text-neutral-700 dark:border-neutral-700 dark:text-neutral-300">
      <nav aria-label="Legal and sign-in">
        <ul className="flex flex-wrap gap-x-5 gap-y-3">
          <li>
            <Link href="/" className={LINK}>
              {productName}
            </Link>
          </li>
          {LEGAL_LINKS.map((link) => (
            <li key={link.href}>
              <Link href={link.href} className={LINK}>
                {link.label}
              </Link>
            </li>
          ))}
          <li>
            <Link href="/login" className={LINK}>
              Sign in
            </Link>
          </li>
        </ul>
      </nav>
    </footer>
  );
}
