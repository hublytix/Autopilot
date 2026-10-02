import 'server-only';
import type { Deps } from '@/server/ports';
import type { OwnerScope } from '@/server/services/auth';
import { getPreferences, MAX_NOTIFY_EMAILS, type PreferencesView } from '@/server/services/onboarding';

// /onboarding/preferences's read side (PLAN §7.5): the stored preferences (defaults before the
// first save) and, when the owner may pick the timezone, the zones to choose from.

export interface PreferencesPageView {
  preferences: PreferencesView;
  maxNotifyEmails: number;
  /** IANA zones for the picker; empty when the zone came from HubSpot and is not editable. */
  timezones: string[];
}

function supportedTimezones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC'];
  }
}

export async function preferencesPageView(scope: OwnerScope, deps: Pick<Deps, 'db'>): Promise<PreferencesPageView> {
  const preferences = await getPreferences(scope, deps);
  let timezones: string[] = [];
  if (preferences.timezoneEditable) {
    timezones = supportedTimezones();
    if (preferences.timezone !== null && !timezones.includes(preferences.timezone)) timezones = [preferences.timezone, ...timezones];
  }
  return { preferences, maxNotifyEmails: MAX_NOTIFY_EMAILS, timezones };
}
