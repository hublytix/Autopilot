import 'server-only';
import { FixedOffsetZone, IANAZone } from 'luxon';
import type { TimezoneSource } from '@/server/domain/types';
import type { AccountDetails } from '@/server/ports';

// The account timezone from HubSpot account details (D-12): the IANA zone when HubSpot's `timeZone`
// is one, otherwise a fixed offset from `utcOffsetMilliseconds` (Luxon's "UTC±H[:MM]" name, which
// Luxon parses back). When the details call failed, both stay null and onboarding asks the owner
// (timezone_source 'owner' is set there).

export interface ResolvedTimezone {
  readonly timezone: string | null;
  readonly source: TimezoneSource | null;
}

export function resolveTimezone(details: Pick<AccountDetails, 'timeZone' | 'utcOffsetMilliseconds'> | null): ResolvedTimezone {
  if (details === null) return { timezone: null, source: null };
  if (IANAZone.isValidZone(details.timeZone)) return { timezone: details.timeZone, source: 'hubspot' };
  const minutes = Math.round(details.utcOffsetMilliseconds / 60_000);
  if (!Number.isFinite(minutes) || Math.abs(minutes) > 14 * 60) return { timezone: null, source: null };
  return { timezone: FixedOffsetZone.instance(minutes).name, source: 'utc_offset' };
}
