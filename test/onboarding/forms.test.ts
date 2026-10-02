import { beforeEach, describe, expect, it } from 'vitest';
import { listFormsForSelection, saveFormSelection, selectedFormCount } from '@/server/services/onboarding';
import { useTestDb as setUpTestDb } from '../db/harness';
import { createOnboardingRig, MINUTE, type OnboardingRig } from './support';

// /onboarding/forms (PLAN §7.5, D-07): the portal's forms with newsletter-like ones unticked;
// ticking sets intake_floor_at = cursor_submitted_at = $now; unticking keeps the row.

const getDb = setUpTestDb();

let rig: OnboardingRig;

beforeEach(async () => {
  rig = await createOnboardingRig(getDb());
});

async function rows(): Promise<{ form_id: string; selected: boolean; newsletter_detected: boolean; intake_floor_at: Date; cursor_submitted_at: Date }[]> {
  return getDb().query(
    `select form_id, selected, newsletter_detected, intake_floor_at, cursor_submitted_at from selected_forms where account_id = $1 order by form_id`,
    [rig.accountId],
  );
}

async function save(formIds: string[]): Promise<Awaited<ReturnType<typeof saveFormSelection>>> {
  return saveFormSelection(rig.scope, rig.deps, { formIds }, { sleep: rig.sleep });
}

describe('listFormsForSelection', () => {
  it('lists the portal forms with the newsletter form unticked and the enquiry forms ticked', async () => {
    const result = await listFormsForSelection(rig.scope, rig.deps, { sleep: rig.sleep });
    if (!result.ok) throw new Error(result.reason);
    expect(result.forms.map((form) => [form.name, form.checked, form.newsletterDetected])).toEqual([
      ['Contact us', true, false],
      ['Newsletter signup', false, true],
      ['Request a quote', true, false],
    ]);
  });

  it('shows the stored choice once the owner has saved one', async () => {
    await save([rig.contactUs, rig.newsletter]);
    const result = await listFormsForSelection(rig.scope, rig.deps, { sleep: rig.sleep });
    if (!result.ok) throw new Error(result.reason);
    expect(Object.fromEntries(result.forms.map((form) => [form.name, form.checked]))).toEqual({
      'Contact us': true,
      'Newsletter signup': true,
      'Request a quote': true,
    });
  });

  it('reports an inactive connection instead of throwing', async () => {
    await getDb().query(`update hubspot_connections set status = 'revoked', access_token_enc = null, refresh_token_enc = null where id = $1`, [rig.connectionId]);
    expect(await listFormsForSelection(rig.scope, rig.deps, { sleep: rig.sleep })).toEqual({ ok: false, reason: 'connection_inactive' });
  });
});

describe('saveFormSelection', () => {
  it('sets the floor and the cursor of a newly ticked form to now', async () => {
    const now = rig.clock.now();
    expect(await save([rig.contactUs, rig.quote])).toEqual({ ok: true, selected: 2 });
    const stored = await rows();
    expect(stored.map((row) => row.form_id).sort()).toEqual([rig.contactUs, rig.quote].sort());
    for (const row of stored) {
      expect(row.selected).toBe(true);
      expect(row.intake_floor_at).toEqual(now);
      expect(row.cursor_submitted_at).toEqual(now);
    }
  });

  it('keeps the floor of a form that stays ticked', async () => {
    const first = rig.clock.now();
    await save([rig.contactUs]);
    rig.clock.advance(10 * MINUTE);
    await save([rig.contactUs]);
    expect((await rows())[0]?.intake_floor_at).toEqual(first);
  });

  it('keeps an unticked form as selected = false, and gives it a fresh floor when ticked again', async () => {
    await save([rig.contactUs, rig.quote]);
    rig.clock.advance(10 * MINUTE);
    await save([rig.contactUs]);
    const unticked = (await rows()).find((row) => row.form_id === rig.quote);
    expect(unticked?.selected).toBe(false);

    rig.clock.advance(10 * MINUTE);
    const retick = rig.clock.now();
    await save([rig.contactUs, rig.quote]);
    const ticked = (await rows()).find((row) => row.form_id === rig.quote);
    expect(ticked).toMatchObject({ selected: true, intake_floor_at: retick, cursor_submitted_at: retick });
  });

  it('records the newsletter detection on a newsletter form the owner ticks anyway', async () => {
    await save([rig.newsletter]);
    expect((await rows())[0]).toMatchObject({ form_id: rig.newsletter, selected: true, newsletter_detected: true });
  });

  it('refuses a save with no form ticked', async () => {
    expect(await save([])).toEqual({ ok: false, reason: 'none_selected' });
    expect(await rows()).toEqual([]);
  });

  it('refuses a form id the portal does not have', async () => {
    expect(await save([rig.contactUs, 'not-a-form-of-this-portal'])).toEqual({ ok: false, reason: 'unknown_form' });
    expect(await rows()).toEqual([]);
  });

  it('unticks a stored form HubSpot no longer lists, so it cannot satisfy the gate', async () => {
    expect(await save([rig.contactUs, rig.quote])).toEqual({ ok: true, selected: 2 });
    // The quote form is archived in HubSpot; the owner saves again with what the page now lists.
    const state = rig.hubspot.snapshot();
    rig.hubspot.restore({ ...state, forms: state.forms.map((form) => (form.id === rig.quote ? { ...form, archived: true } : form)) });
    expect(await save([rig.contactUs])).toEqual({ ok: true, selected: 1 });
    const stored = Object.fromEntries((await rows()).map((row) => [row.form_id, row.selected]));
    expect(stored).toEqual({ [rig.contactUs]: true, [rig.quote]: false });
    expect(await selectedFormCount(getDb(), rig.accountId)).toBe(1);
  });
});
