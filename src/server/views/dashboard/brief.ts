import 'server-only';
import type { BriefSource } from '@/server/domain/types';
import type { Deps } from '@/server/ports';
import type { OwnerScope } from '@/server/services/auth/owner-scope';
import { listBriefVersions } from '@/server/services/brief';
import { briefPageView, type BriefPageView } from '@/server/views/onboarding/brief';
import { loadAccountContext } from './account';
import { formatInZone } from './format';

// /dashboard/brief's read model (PLAN §7.5): the same editor state as the onboarding brief step
// (services/brief: the brief in force, a newer generated version, the booking link to confirm, the
// field limits) plus the version history, newest first, with the version drafts use now marked.
// Saving creates an `owner` brief_versions row (saveOwnerBrief). By the OwnerScope only.

/** Versions listed in the history. */
export const BRIEF_HISTORY_LIMIT = 20;

export interface BriefVersionRow {
  readonly version: number;
  readonly source: BriefSource;
  /** "Tue 6 Oct, 10:15" in the portal's zone. */
  readonly createdAt: string;
  /** The owner-saved version drafts use now. */
  readonly inForce: boolean;
}

export interface DashboardBriefView {
  readonly editor: BriefPageView;
  readonly versions: readonly BriefVersionRow[];
}

export async function dashboardBriefView(scope: OwnerScope, deps: Deps): Promise<DashboardBriefView> {
  const editor = await briefPageView(scope, deps);
  const context = await loadAccountContext(deps.db, scope.accountId);
  const now = deps.clock.now();
  const inForce = editor.editor.saved?.version ?? null;
  const versions = await listBriefVersions(scope, deps, { limit: BRIEF_HISTORY_LIMIT });
  return {
    editor,
    versions: versions.map((row) => ({
      version: row.version,
      source: row.source,
      createdAt: formatInZone(row.createdAt, context.zone, now),
      inForce: row.version === inForce,
    })),
  };
}
