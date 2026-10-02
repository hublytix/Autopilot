import Link from 'next/link';
import type { RecentLeadView } from '@/server/views/dashboard';
import { leadNameText, NOT_PROCESSED_SHORT } from './copy';
import { StatusBadge } from './status-badge';

// The most recent leads (PLAN §7.5): one row per lead with ONE status (D-32), when it arrived in the
// portal's zone, who it is (the first name, or the HubSpot contact id once the details are removed,
// D-31), a link to the lead's page and to its record in HubSpot. A list of cards, so it reads on a
// phone without sideways scrolling.

export function LeadList({ leads }: { leads: readonly RecentLeadView[] }) {
  return (
    <ul className="flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800" aria-label="Recent leads">
      {leads.map((lead) => (
        <li key={lead.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <Link href={`/dashboard/leads/${lead.id}`} prefetch={false} className="truncate font-semibold underline-offset-4 hover:underline">
              {leadNameText(lead.name)}
            </Link>
            <p className="text-sm text-neutral-700 dark:text-neutral-300">
              Received <time>{lead.receivedAt}</time>
              {lead.notProcessed === null ? null : <> · {NOT_PROCESSED_SHORT[lead.notProcessed]}</>}
              {lead.needsTouch ? <> · Draft needs your touch</> : null}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge status={lead.status} label={lead.statusLabel} />
            {lead.recordUrl === null ? null : (
              <a href={lead.recordUrl} className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4" rel="noopener noreferrer" target="_blank">
                Open in HubSpot
              </a>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
