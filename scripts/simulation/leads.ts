// The leads summary.json lists (PLAN §13): every lead except the onboarding test lead, which is
// "absent from every list and metric". run.ts reads them here; the final stage checks the rule.
import type { PgliteDb } from '@/server/db/pglite';

export interface SummaryLeadRow {
  id: string;
  hubspot_contact_id: string | null;
  form_id: string | null;
  submitted_at: Date;
  intake_trigger: string;
  is_test: boolean;
  classification: string | null;
  processing_state: string;
  stop_reason: string | null;
}

/** In the stable summary order (submitted_at, contact, form). */
export async function summaryLeadRows(db: PgliteDb): Promise<SummaryLeadRow[]> {
  return db.query<SummaryLeadRow>(
    `select id, hubspot_contact_id, form_id, submitted_at, intake_trigger, is_test, classification, processing_state, stop_reason
       from public.leads where not is_test
      order by submitted_at, hubspot_contact_id nulls last, form_id nulls last`,
  );
}
