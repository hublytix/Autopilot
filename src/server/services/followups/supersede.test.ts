import { beforeEach, describe, expect, it } from 'vitest';
import { seedActiveAccount, seedLead, TEST_START } from '@/server/jobs/testing';
import { bindPredicate, NotificationPredicates } from '@/server/services/notifications/predicates';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import { isSuperseded, supersededSql } from './supersede';

// D-44: a lead is superseded when a newer, non-test lead of the same contact in the same account has
// already been notified. The follow-up job's check and the follow_up reservation predicate agree.

const getDb = setUpTestDb();
const HOUR = 3_600_000;
const at = (hours: number): Date => new Date(TEST_START.getTime() + hours * HOUR);

let accountId: string;

beforeEach(async () => {
  ({ accountId } = await seedActiveAccount(getDb(), TEST_START));
});

/** A lead of `contactId` submitted `hours` after the start; notified when `notified`. */
function lead(input: { contactId: string; hours: number; notified: boolean; isTest?: boolean; account?: string }): Promise<string> {
  return seedLead(getDb(), {
    accountId: input.account ?? accountId,
    now: at(input.hours),
    contactId: input.contactId,
    submittedAt: at(input.hours),
    firstNotifiedAt: input.notified ? at(input.hours + 0.1) : undefined,
    isTest: input.isTest,
  });
}

async function followUpPredicateHolds(leadId: string): Promise<boolean> {
  const params: unknown[] = [];
  const sql = bindPredicate(NotificationPredicates.followUp({ accountId, leadId }, 1), params);
  return (await getDb().one<{ ok: boolean }>(`select (${sql}) as ok`, params)).ok;
}

describe('isSuperseded', () => {
  it('is true for an older lead once a newer lead of the same contact was notified, never for the newer one', async () => {
    const older = await lead({ contactId: '501', hours: 0, notified: true });
    const newer = await lead({ contactId: '501', hours: 24, notified: true });

    expect(await isSuperseded(getDb(), older)).toBe(true);
    expect(await isSuperseded(getDb(), newer)).toBe(false);
  });

  it('is false while the newer lead is not notified (filtered, deferred, still processing)', async () => {
    const older = await lead({ contactId: '502', hours: 0, notified: true });
    await lead({ contactId: '502', hours: 24, notified: false });

    expect(await isSuperseded(getDb(), older)).toBe(false);
  });

  it('ignores a newer test lead, another contact, and the same contact id in another account', async () => {
    const older = await lead({ contactId: '503', hours: 0, notified: true });
    await lead({ contactId: '503', hours: 24, notified: true, isTest: true });
    await lead({ contactId: '504', hours: 24, notified: true });
    const { accountId: otherAccount } = await seedActiveAccount(getDb(), TEST_START);
    await lead({ contactId: '503', hours: 24, notified: true, account: otherAccount });

    expect(await isSuperseded(getDb(), older)).toBe(false);
  });

  it('is false for an unknown lead and for a lead without a contact', async () => {
    const test = await lead({ contactId: '505', hours: 0, notified: true, isTest: true });
    await getDb().query(`update leads set hubspot_contact_id = null where id = $1`, [test]);

    expect(await isSuperseded(getDb(), test)).toBe(false);
    expect(await isSuperseded(getDb(), '00000000-0000-4000-8000-000000000000')).toBe(false);
  });

  it('agrees with the follow_up reservation predicate on every non-test lead', async () => {
    const leads = [
      await lead({ contactId: '601', hours: 0, notified: true }),
      await lead({ contactId: '601', hours: 24, notified: true }),
      await lead({ contactId: '601', hours: 48, notified: false }),
      await lead({ contactId: '602', hours: 0, notified: true }),
      await lead({ contactId: '602', hours: 24, notified: false }),
      await lead({ contactId: '603', hours: 0, notified: true }),
    ];
    await lead({ contactId: '603', hours: 24, notified: true, isTest: true });

    const superseded = await Promise.all(leads.map((id) => isSuperseded(getDb(), id)));
    expect(superseded).toEqual([true, false, false, false, false, false]);
    for (const [i, id] of leads.entries()) expect(await followUpPredicateHolds(id)).toBe(!superseded[i]);
  });

  it('refuses an alias that is not a plain identifier', () => {
    expect(supersededSql('l')).toContain('newer_lead.hubspot_contact_id = l.hubspot_contact_id');
    expect(() => supersededSql('l; drop table leads')).toThrow('supersede_bad_alias');
  });
});
