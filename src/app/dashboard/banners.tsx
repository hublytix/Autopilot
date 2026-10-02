import Link from 'next/link';
import { Alert } from '@/components/ui';
import type { DashboardBanner } from '@/server/views/dashboard';
import { bannerCopy } from './copy';

// The dashboard's banners (PLAN §7.5): each one says what is wrong or limited, in plain words, and
// links to where it is fixed. Route handlers (the HubSpot install) get a plain link, never a prefetch.

const LINK_CLASSES = 'inline-flex min-h-11 items-center font-medium underline underline-offset-4';

export function Banners({ banners }: { banners: readonly DashboardBanner[] }) {
  if (banners.length === 0) return null;
  return (
    <div className="flex flex-col gap-3" data-testid="banners">
      {banners.map((banner) => {
        const copy = bannerCopy(banner);
        return (
          <Alert key={banner.type} tone={copy.tone} title={copy.title}>
            {copy.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
            {copy.link === undefined ? null : copy.link.plain === true ? (
              <p>
                <a href={copy.link.href} className={LINK_CLASSES}>
                  {copy.link.label}
                </a>
              </p>
            ) : (
              <p>
                <Link href={copy.link.href} prefetch={false} className={LINK_CLASSES}>
                  {copy.link.label}
                </Link>
              </p>
            )}
          </Alert>
        );
      })}
    </div>
  );
}
