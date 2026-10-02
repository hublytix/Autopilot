import Link from 'next/link';
import type { ReactNode } from 'react';
import { buttonClasses, type ButtonVariant } from './Button';

// A link that looks like a button. In-app pages use Next's Link; `plain` renders a bare <a> for
// URLs that must not be prefetched or client-routed (route handlers that redirect, like the
// HubSpot install, and other origins).

export interface LinkButtonProps {
  href: string;
  children: ReactNode;
  variant?: ButtonVariant;
  fullWidth?: boolean;
  className?: string;
  /** A plain <a> without prefetch (route handlers, other origins). */
  plain?: boolean;
}

export function LinkButton({ href, children, variant = 'primary', fullWidth = true, className, plain = false }: LinkButtonProps) {
  const classes = buttonClasses(variant, fullWidth, className);
  if (plain) {
    return (
      <a href={href} className={classes}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} prefetch={false} className={classes}>
      {children}
    </Link>
  );
}
