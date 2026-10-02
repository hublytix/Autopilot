import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_PROCESSING_STATES,
  ACTION_TOKEN_PURPOSES,
  AI_CALL_OUTCOMES,
  AI_CALL_PURPOSES,
  BASELINE_STATUSES,
  BOOKING_LINK_CHOICES,
  BRIEF_JOB_STATUSES,
  BRIEF_SOURCES,
  CLASSIFICATIONS,
  CONNECTION_STATUSES,
  DRAFT_FLAGS,
  DRAFT_KINDS,
  INBOX_CHECK_STATUSES,
  INBOX_LEG_STATUSES,
  INTAKE_TRIGGERS,
  JOB_KINDS,
  JOB_STATUSES,
  LEAD_PROCESSING_STATES,
  LOGGING_MODES,
  LOGIN_INTENT_PURPOSES,
  MAIL_CLIENTS,
  NOTIFICATION_KINDS,
  NOTIFICATION_STATUSES,
  STOP_REASONS,
  SUBSCRIPTION_STATUSES,
  TIMEZONE_SOURCES,
  VALIDATION_ERROR_CODES,
  WEBHOOK_PROVIDERS,
  WEEKLY_REPORT_STATUSES,
} from '@/server/domain/types';
import { useTestDb } from './harness';

// The status CHECK constraints in supabase/migrations mirror the value lists in
// src/server/domain/types.ts (PLAN §5). A value added on one side only would let code write a row
// the database rejects, or the database hold a value the code cannot read.

const EXPECTED: Readonly<Record<string, readonly string[]>> = {
  'accounts.logging_mode': LOGGING_MODES,
  'accounts.processing_state': ACCOUNT_PROCESSING_STATES,
  'accounts.timezone_source': TIMEZONE_SOURCES,
  'action_tokens.purpose': ACTION_TOKEN_PURPOSES,
  'ai_calls.outcome': AI_CALL_OUTCOMES,
  'ai_calls.purpose': AI_CALL_PURPOSES,
  'baselines.status': BASELINE_STATUSES,
  'brief_jobs.status': BRIEF_JOB_STATUSES,
  'brief_versions.booking_link_choice': BOOKING_LINK_CHOICES,
  'brief_versions.source': BRIEF_SOURCES,
  'briefs.booking_link_choice': BOOKING_LINK_CHOICES,
  'drafts.flags': DRAFT_FLAGS,
  'drafts.kind': DRAFT_KINDS,
  'drafts.validation_errors': VALIDATION_ERROR_CODES,
  'hubspot_connections.status': CONNECTION_STATUSES,
  'inbox_checks.reply_leg': INBOX_LEG_STATUSES,
  'inbox_checks.send_leg': INBOX_LEG_STATUSES,
  'inbox_checks.status': INBOX_CHECK_STATUSES,
  'leads.classification': CLASSIFICATIONS,
  'leads.classification_override': CLASSIFICATIONS,
  'leads.intake_trigger': INTAKE_TRIGGERS,
  'leads.processing_state': LEAD_PROCESSING_STATES,
  'leads.stop_reason': STOP_REASONS,
  'login_intents.purpose': LOGIN_INTENT_PURPOSES,
  'notifications_sent.kind': NOTIFICATION_KINDS,
  'notifications_sent.status': NOTIFICATION_STATUSES,
  'scheduled_jobs.kind': JOB_KINDS,
  'scheduled_jobs.status': JOB_STATUSES,
  'settings.mail_client': MAIL_CLIENTS,
  'subscriptions.status': SUBSCRIPTION_STATUSES,
  'webhook_events.provider': WEBHOOK_PROVIDERS,
  'weekly_reports.status': WEEKLY_REPORT_STATUSES,
};

/** Value-list checks with no domain list (the code never branches on them). */
const DB_ONLY = new Set(['audit_log.level']);

const sorted = (values: readonly string[]): string[] => [...new Set(values)].sort();

describe('status checks match src/server/domain/types.ts', () => {
  const getDb = useTestDb();

  async function valueListChecks(): Promise<Map<string, string[]>> {
    const rows = await getDb().query<{ name: string; def: string }>(
      `select cl.relname || '.' || a.attname as name, pg_get_constraintdef(con.oid) as def
         from pg_constraint con
         join pg_class cl on cl.oid = con.conrelid
         join pg_namespace n on n.oid = cl.relnamespace
         join pg_attribute a on a.attrelid = cl.oid and a.attnum = con.conkey[1]
        where n.nspname = 'public' and con.contype = 'c' and cardinality(con.conkey) = 1
          and pg_get_constraintdef(con.oid) like '%ARRAY[%'
        order by 1`,
    );
    const checks = new Map<string, string[]>();
    for (const row of rows) {
      const values = [...row.def.matchAll(/'([^']*)'::text/g)].map((match) => match[1] ?? '');
      checks.set(row.name, [...(checks.get(row.name) ?? []), ...values]);
    }
    return checks;
  }

  it('every value-list check has a domain list (or is knowingly database-only)', async () => {
    const unmapped = [...(await valueListChecks()).keys()].filter((name) => !(name in EXPECTED) && !DB_ONLY.has(name));
    expect(unmapped).toEqual([]);
  });

  it.each(Object.entries(EXPECTED))('%s allows exactly the domain values', async (name, values) => {
    const checks = await valueListChecks();
    expect(checks.has(name)).toBe(true);
    expect(sorted(checks.get(name) ?? [])).toEqual(sorted(values));
  });
});
