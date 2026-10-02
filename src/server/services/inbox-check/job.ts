import 'server-only';
import { isRevoked } from '@/server/domain/errors';
import type { Db } from '@/server/db';
import { EMAIL_METADATA_PROPERTIES, type EmailMetadataProperty } from '@/server/domain/types';
import { insertJob, JobOutcomes, publishJobs, type JobFailurePath, type JobHandler, type JobRow, type Registration } from '@/server/jobs';
import { log } from '@/server/obs/log';
import type { EmailEngagement } from '@/server/ports';
import { forAccount, isDailyLimit, type PortalHubSpotClient, type Sleep } from '@/server/services/hubspot';
import { CHECK_INTERVAL_MS, MAX_ASSOCIATION_PAGES, MAX_CHECK_RUNS } from './constants';
import { resumeInboxTest } from './email';
import { checkIdOfJob, inboxCheckDedupeKey, runNumberOfJob } from './keys';
import { advanceLegs, findLegEvidence, loggingModeFor, type LegsOutcome } from './legs';
import { failOpenLegsInTx, getInboxCheck, setLoggingModeInTx, skipOpenLegs, type InboxCheckRow } from './repository';

// The `inbox_check` job (PLAN §8.2, §9.7 steps 3-5, D-14). Each run:
// 1. reads the check; a closed check (skipped, superseded, finished) ends the run `done` without
//    calling HubSpot;
// 2. reads the test contact's logged emails, metadata only (GET contacts/{testEmail}?idProperty=
//    email&associations=emails, the association pages, emails/batch/read with the metadata
//    allow-list); a 404 means nothing is logged yet;
// 3. decides the legs (legs.ts) and writes ONLY `inbox_checks` and, when both legs are resolved,
//    `accounts.logging_mode`, while this attempt still owns the job; it never calls markReplied or
//    applySignals, never touches the test lead and sends nothing;
// 4. inserts the next run (+60 s) until both legs are resolved or their windows end.
// It runs whatever the account's processing state. A revoked connection or HubSpot's daily limit
// closes the check with its open legs `skipped` (it could not be checked; the logging mode stays as
// it was). Other errors retry through QStash; after the last delivery the failure path turns the
// open legs `failed` (PLAN §8.3 step 6) and sets the logging mode from the final legs.

const READ_PROPERTIES: readonly EmailMetadataProperty[] = EMAIL_METADATA_PROPERTIES.filter((p) => p !== 'hs_email_status');

/** The test contact's logged emails (metadata only); empty when HubSpot has no contact for the address yet. */
export async function readTestContactEmails(client: PortalHubSpotClient, testAddress: string): Promise<EmailEngagement[]> {
  const contact = await client.getContact(testAddress, { idProperty: 'email', properties: ['email'], associations: ['emails'] });
  if (contact === null) return [];
  const ids = [...(contact.associatedEmailIds ?? [])];
  let after = contact.associationsNextAfter;
  for (let pages = 1; after !== undefined && pages < MAX_ASSOCIATION_PAGES; pages++) {
    const page = await client.listContactEmailIds(contact.id, { after });
    ids.push(...page.ids);
    after = page.nextAfter;
  }
  if (ids.length === 0) return [];
  return client.batchReadEmails(ids, READ_PROPERTIES);
}

/** Writes one run's legs, guarded on the legs this run read; returns false when the check changed meanwhile. */
async function writeLegs(
  tx: Db,
  check: InboxCheckRow,
  outcome: LegsOutcome,
  now: Date,
): Promise<boolean> {
  const row = await tx.maybeOne(
    `update inbox_checks
        set send_leg = $4, reply_leg = $5, reply_deadline_at = $6,
            send_resolved_at = case when $7::boolean then $3 else send_resolved_at end,
            reply_resolved_at = case when $8::boolean then $3 else reply_resolved_at end,
            status = case when $9::boolean then 'closed' else status end,
            closed_at = case when $9::boolean then $3 else closed_at end
      where id = $1 and account_id = $2 and status = 'open' and send_leg = $10 and reply_leg = $11
      returning id`,
    [
      check.id,
      check.accountId,
      now,
      outcome.send,
      outcome.reply,
      outcome.replyDeadlineAt,
      outcome.sendResolved,
      outcome.replyResolved,
      outcome.finished,
      check.sendLeg,
      check.replyLeg,
    ],
  );
  return row !== null;
}

export interface InboxCheckJobOptions {
  /** For the portal limiter; default real timers (tests advance their FakeClock). */
  sleep?: Sleep | undefined;
}

export function createInboxCheckJobHandler(options: InboxCheckJobOptions = {}): JobHandler {
  return async (deps, job, ctx) => {
    const checkId = checkIdOfJob(job);
    if (checkId === null || job.accountId === null) return JobOutcomes.skipped();
    const check = await getInboxCheck(deps.db, job.accountId, checkId);
    if (check === null) return JobOutcomes.skipped();
    if (check.status === 'closed') return JobOutcomes.done();
    if (check.sendDeadlineAt === null || check.replyDeadlineAt === null) return JobOutcomes.skipped();
    if (check.testAddress === null) {
      await skipOpenLegs(deps.db, check.id, deps.clock.now());
      return JobOutcomes.done();
    }

    let emails: EmailEngagement[];
    try {
      emails = await readTestContactEmails(forAccount(deps, check.accountId, { sleep: options.sleep }), check.testAddress);
    } catch (error) {
      if (!isRevoked(error) && !isDailyLimit(error)) throw error;
      await skipOpenLegs(deps.db, check.id, deps.clock.now());
      log.info('inbox check could not read HubSpot', { event: 'inbox_check.unreadable', accountId: check.accountId, jobId: job.id });
      return JobOutcomes.skipped();
    }

    const now = deps.clock.now();
    const run = runNumberOfJob(job);
    const outcome = advanceLegs(
      { send: check.sendLeg, reply: check.replyLeg, sendDeadlineAt: check.sendDeadlineAt, replyDeadlineAt: check.replyDeadlineAt },
      findLegEvidence(emails, check.testAddress, check.createdAt),
      now,
      { forceResolve: run >= MAX_CHECK_RUNS },
    );

    const next = await deps.db.tx(async (tx): Promise<(JobRow | null)[]> => {
      await ctx.assertOwned(tx);
      if (!(await writeLegs(tx, check, outcome, now))) return [];
      if (outcome.loggingMode !== null) {
        await setLoggingModeInTx(tx, check.accountId, outcome.loggingMode);
        return [];
      }
      return [
        await insertJob(tx, {
          kind: 'inbox_check',
          accountId: check.accountId,
          dedupeKey: inboxCheckDedupeKey(check.accountId, check.id, run + 1),
          payload: { checkId: check.id },
          runAt: new Date(now.getTime() + CHECK_INTERVAL_MS),
          now,
          seq: run + 1,
        }),
      ];
    });
    await publishJobs(deps, next);
    if (outcome.loggingMode !== null) {
      log.info('inbox check finished', {
        event: 'inbox_check.finished',
        accountId: check.accountId,
        jobId: job.id,
        outcome: outcome.loggingMode,
        attempt: run,
      });
    }
    return JobOutcomes.done();
  };
}

export const inboxCheckJobHandler: JobHandler = createInboxCheckJobHandler();

/** PLAN §8.3 step 6: the open legs become `failed`; the logging mode follows from the final legs. Idempotent. */
export const inboxCheckFailurePath: JobFailurePath = async (deps, job) => {
  const checkId = checkIdOfJob(job);
  if (checkId === null || job.accountId === null) return;
  const accountId = job.accountId;
  await deps.db.tx(async (tx) => {
    const closed = await failOpenLegsInTx(tx, accountId, checkId, deps.clock.now());
    if (closed === null) return;
    const mode = loggingModeFor(closed.sendLeg, closed.replyLeg);
    if (mode !== null) await setLoggingModeInTx(tx, accountId, mode);
  });
};

/**
 * The inbox check's wiring (a Registration for src/server/jobs/handlers.ts): the `inbox_check`
 * handler and failure path, and the `inbox_test` resumer.
 */
export const registerInboxCheck: Registration = ({ jobs, notifications, limiterSleep }) => {
  jobs.register('inbox_check', limiterSleep === undefined ? inboxCheckJobHandler : createInboxCheckJobHandler({ sleep: limiterSleep }));
  jobs.registerFailurePath('inbox_check', inboxCheckFailurePath);
  notifications.register('inbox_test', resumeInboxTest);
};
