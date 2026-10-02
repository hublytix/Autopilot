import { buttonClasses, type ButtonVariant } from './Button';

// Sign out: a same-origin POST to /auth/signout (a GET cannot sign anyone out, so a link in another
// site or an email scanner cannot either).

export interface SignOutButtonProps {
  variant?: ButtonVariant;
  className?: string;
}

export function SignOutButton({ variant = 'ghost', className }: SignOutButtonProps) {
  return (
    <form method="post" action="/auth/signout">
      <button type="submit" className={buttonClasses(variant, false, className)}>
        Sign out
      </button>
    </form>
  );
}
