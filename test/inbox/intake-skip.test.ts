import { beforeEach, describe, expect, it } from 'vitest';
import { seedSelectedForm } from '@/server/services/accounts/testing';
import { pollPortal } from '@/server/services/intake';
import { useTestDb as setUpTestDb } from '../db/harness';
import { at, checkIdOf, checkOf, createInboxRig, HOUR, MINUTE, start, TEST_ADDRESS, type InboxRig } from './support';

// D-14 / PLAN §9.2: the inbox check's row exists before the contact lookup, so the fix step "submit
// one of your own forms with the test address" never creates a lead, on an active account too
// (a re-run after onboarding), and the skip does not lapse when the address is cleared.

const getDb = setUpTestDb();

let rig: InboxRig;
let contactUs: string;

beforeEach(async () => {
  rig = await createInboxRig(getDb(), { processingState: 'active', bcc: false });
  contactUs = rig.hubspot.formIdByName('Contact us');
  await seedSelectedForm(getDb(), { accountId: rig.accountId, formId: contactUs, floor: rig.clock.now() });
  rig.clock.advance(MINUTE);
});

async function leadCount(): Promise<number> {
  const rows = await getDb().query(`select id from leads where account_id = $1 and not is_test`, [rig.accountId]);
  return rows.length;
}

describe('the test address at intake', () => {
  it('skips the owner’s own form submission made as the fix step, then the test starts', async () => {
    const t0 = rig.clock.now();
    const missing = await start(rig);
    expect(missing.type).toBe('test_contact_missing');

    // The owner follows the fix step: one of their own forms, with the test address.
    rig.clock.set(at(t0, 2 * MINUTE));
    rig.hubspot.submitForm({ formId: contactUs, email: TEST_ADDRESS, firstName: 'Dana', message: 'Testing my inbox.', newContact: true });
    rig.clock.set(at(t0, 3 * MINUTE));
    const polled = await pollPortal(rig.deps, rig.accountId, 'cron', { sleep: rig.sleep });
    expect(polled).toMatchObject({ status: 'polled', counts: { leadsCreated: 0, testAddressSkipped: 1 } });
    expect(await leadCount()).toBe(0);

    const started = await start(rig);
    expect(started.type).toBe('started');
    expect(await leadCount()).toBe(0);
    expect(await checkOf(getDb(), checkIdOf(missing))).toMatchObject({ status: 'closed', send_leg: 'skipped' });
  });

  it('still skips a submission from the address after the address itself was cleared', async () => {
    const t0 = rig.clock.now();
    const checkId = checkIdOf(await start(rig));
    rig.clock.set(at(t0, 30 * MINUTE));
    rig.hubspot.submitForm({ formId: contactUs, email: TEST_ADDRESS, message: 'Testing again.', newContact: true });
    // 25 h later the address is gone (D-49), the HMAC stays; a poll still skips the submission.
    rig.clock.set(at(t0, 25 * HOUR));
    await getDb().query(`update inbox_checks set test_address = null where id = $1`, [checkId]);
    await getDb().query(`update selected_forms set cursor_submitted_at = $2 where account_id = $1`, [rig.accountId, at(t0, -MINUTE)]);
    const polled = await pollPortal(rig.deps, rig.accountId, 'cron', { sleep: rig.sleep });
    expect(polled).toMatchObject({ status: 'polled', counts: { leadsCreated: 0, testAddressSkipped: 1 } });
    expect(await leadCount()).toBe(0);
  });

  it('does not skip someone else’s submission', async () => {
    await start(rig);
    rig.clock.advance(MINUTE);
    rig.hubspot.submitForm({ formId: contactUs, email: 'nina.patel@example.com', message: 'Two dental chairs need new water lines.', newContact: true });
    rig.clock.advance(MINUTE);
    await pollPortal(rig.deps, rig.accountId, 'cron', { sleep: rig.sleep });
    expect(await leadCount()).toBe(1);
  });
});
