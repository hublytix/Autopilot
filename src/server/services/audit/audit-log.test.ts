import { describe, expect, it } from 'vitest';
import { seedAccount } from '@/server/jobs/testing';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import { AuditMetaRefusedError, assertAuditMeta, insertAudit, insertAuditOnce } from './audit-log';

// audit_log meta is allow-listed (PLAN §5, law 4): ids, codes and instants only.

const getDb = setUpTestDb();

describe('audit_log meta allow-list', () => {
  it('accepts allow-listed keys with id-like values', () => {
    expect(assertAuditMeta({ formId: '1b8a9f2c-0d3e-4c5f-8a6b-7c8d9e0f1a2b', submittedAt: '2026-10-06T14:00:00.000Z' })).toBeTruthy();
  });

  it.each([
    ['a key outside the list', { submissionKey: 'ab12' }],
    ['an email value', { formId: 'lead@example.com' }],
    ['free text', { formId: 'Hello there' }],
    ['a nested value', { formId: { nested: true } }],
  ])('refuses %s', (_what, meta) => {
    expect(() => assertAuditMeta(meta)).toThrow(AuditMetaRefusedError);
  });

  it('writes once per account, action and the chosen meta values', async () => {
    const db = getDb();
    const accountId = await seedAccount(db, { now: new Date('2026-10-06T14:00:00.000Z') });
    const entry = { accountId, actor: 'system' as const, action: 'intake.contact_not_found', level: 'warn' as const };
    const first = { formId: 'form-1', submittedAt: '2026-10-06T13:00:00.000Z' };
    expect(await insertAuditOnce(db, { ...entry, meta: first }, ['formId', 'submittedAt'])).toBe(true);
    expect(await insertAuditOnce(db, { ...entry, meta: first }, ['formId', 'submittedAt'])).toBe(false);
    expect(await insertAuditOnce(db, { ...entry, meta: { ...first, submittedAt: '2026-10-06T13:00:00.001Z' } }, ['formId', 'submittedAt'])).toBe(true);
    await expect(insertAuditOnce(db, { ...entry, meta: { formId: 'x y' } }, ['formId'])).rejects.toBeInstanceOf(AuditMetaRefusedError);
    expect(await db.query(`select meta from audit_log order by id`)).toHaveLength(2);
  });

  it('insertAudit writes one row per call (an /admin view each time), meta still allow-listed', async () => {
    const db = getDb();
    const entry = { accountId: null, actor: 'admin' as const, action: 'admin.view', level: 'info' as const, meta: {} };
    await insertAudit(db, entry);
    await insertAudit(db, entry);
    expect(await db.query(`select account_id, actor, action, meta from audit_log where action = 'admin.view'`)).toEqual([
      { account_id: null, actor: 'admin', action: 'admin.view', meta: {} },
      { account_id: null, actor: 'admin', action: 'admin.view', meta: {} },
    ]);
    await expect(insertAudit(db, { ...entry, meta: { formId: 'owner@example.com' } })).rejects.toBeInstanceOf(AuditMetaRefusedError);
  });
});
