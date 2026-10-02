// The status the owner sees for a scenario lead (D-32), as the dashboard will derive it: the lead's
// row and the account's current follow-up setting through deriveLeadStatus at the simulated time.
// Shared by the stages that check statuses after each step (PLAN §13, §15 M4/M5).
import { DateTime } from 'luxon';
import { deriveLeadStatus } from '@/server/domain/lead-status';
import { isClassification, isStopReason, type LeadDisplayStatus, type LeadProcessingState } from '@/server/domain/types';
import type { Simulation } from './types';

interface StatusRow {
  id: string;
  processing_state: LeadProcessingState;
  classification: string | null;
  classification_override: string | null;
  process_rev: number;
  stop_reason: string | null;
  dismissed_at: Date | null;
  replied_at: Date | null;
  first_notified_at: Date | null;
  fu1_notified_at: Date | null;
  fu2_notified_at: Date | null;
  first_send_clicked_at: Date | null;
  send_confirmed_at: Date | null;
  signals_checked_at: Date | null;
  followups_enabled: boolean;
}

export async function statusOf(sim: Simulation, leadId: string | null): Promise<{ row: StatusRow; status: LeadDisplayStatus } | null> {
  if (leadId === null) return null;
  const row = await sim.db.maybeOne<StatusRow>(
    `select l.id, l.processing_state, l.classification, l.classification_override, l.process_rev, l.stop_reason, l.dismissed_at,
            l.replied_at, l.first_notified_at, l.fu1_notified_at, l.fu2_notified_at, l.first_send_clicked_at, l.send_confirmed_at, l.signals_checked_at,
            s.followups_enabled
       from public.leads l join public.settings s on s.account_id = l.account_id
      where l.id = $1`,
    [leadId],
  );
  if (row === null) return null;
  const status = deriveLeadStatus(
    {
      processingState: row.processing_state,
      classification: isClassification(row.classification) ? row.classification : null,
      classificationOverride: isClassification(row.classification_override) ? row.classification_override : null,
      processRev: row.process_rev,
      stopReason: isStopReason(row.stop_reason) ? row.stop_reason : null,
      dismissedAt: row.dismissed_at,
      repliedAt: row.replied_at,
      firstNotifiedAt: row.first_notified_at,
      fu1NotifiedAt: row.fu1_notified_at,
      fu2NotifiedAt: row.fu2_notified_at,
      firstSendClickedAt: row.first_send_clicked_at,
      sendConfirmedAt: row.send_confirmed_at,
      signalsCheckedAt: row.signals_checked_at,
      followupsEnabled: row.followups_enabled,
    },
    sim.clock.now(),
  );
  return { row, status };
}

export function shownLocal(sim: Simulation, at: Date | null): string {
  return at === null ? 'null' : DateTime.fromJSDate(at, { zone: sim.timeZone }).toFormat('ccc HH:mm:ss');
}

