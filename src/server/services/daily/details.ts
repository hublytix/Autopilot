import 'server-only';
import type { Deps } from '@/server/ports';
import { forAccount, type Sleep } from '@/server/services/hubspot';
import { resolveTimezone } from '@/server/services/install/timezone';

// The daily account-details refresh (PLAN §9.1 step 4, D-12): `GET /account-info/…/details` through
// the account's portal client (token manager, limiter, 401 rule). The timezone follows HubSpot's
// unless the owner chose one: an IANA zone as is, otherwise the fixed UTC offset (resolveTimezone,
// as the install does); an unusable answer, or a failed call, keeps the stored value. The UI domain,
// hosting location and account type are stored on the connection (record links use the UI domain).

export type DetailsOutcome = 'no_connection' | 'refreshed';

export async function refreshAccountDetails(deps: Deps, accountId: string, options: { sleep?: Sleep | undefined } = {}): Promise<DetailsOutcome> {
  const connection = await deps.db.maybeOne(`select id from hubspot_connections where account_id = $1 and status = 'active'`, [accountId]);
  if (connection === null) return 'no_connection';
  const details = await forAccount(deps, accountId, { sleep: options.sleep }).accountDetails();

  const timezone = resolveTimezone(details);
  if (timezone.timezone !== null) {
    await deps.db.query(
      `update accounts set timezone = $2, timezone_source = $3
        where id = $1 and timezone_source is distinct from 'owner'
          and (timezone is distinct from $2 or timezone_source is distinct from $3)`,
      [accountId, timezone.timezone, timezone.source],
    );
  }
  await deps.db.query(
    `update hubspot_connections
        set ui_domain = $2, data_hosting_location = $3, account_type = $4
      where account_id = $1 and status = 'active'
        and (ui_domain is distinct from $2 or data_hosting_location is distinct from $3 or account_type is distinct from $4)`,
    [accountId, details.uiDomain, details.dataHostingLocation, details.accountType],
  );
  return 'refreshed';
}
