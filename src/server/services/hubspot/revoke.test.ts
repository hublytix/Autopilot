import { describe, expect, it } from 'vitest';
import { createJobRegistry } from '@/server/jobs/registry';
import { createJobTestRig, seedAccount, seedConnection } from '@/server/jobs/testing';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import { recordStatements } from '../../../../test/db/intercept';
import { revokeConnectionInTx } from './revoke';

// Lock order (docs/ARCHITECTURE.md): accounts first, then hubspot_connections, like the OAuth
// callback, so a revoke and a reinstall can never deadlock. PGlite serialises transactions, so the
// order of statements is what the test can prove.

const getDb = setUpTestDb();

describe('revokeConnectionInTx', () => {
  it('locks the account row before it touches the connection', async () => {
    const rig = createJobTestRig(getDb(), createJobRegistry());
    const now = rig.clock.now();
    const accountId = await seedAccount(getDb(), { now });
    const connectionId = await seedConnection(getDb(), { accountId, now });
    const recorded = recordStatements(getDb());

    const result = await recorded.db.tx((tx) => revokeConnectionInTx(tx, now, { accountId, connectionId, tokenVersion: 0, reason: 'refresh_revoked' }));
    expect(result.outcome).toBe('revoked');
    const accountLock = recorded.statements.findIndex((sql) => /from accounts where id = \$1 for no key update/.test(sql));
    const connectionWrite = recorded.statements.findIndex((sql) => /update hubspot_connections/.test(sql));
    expect(accountLock).toBeGreaterThanOrEqual(0);
    expect(connectionWrite).toBeGreaterThan(accountLock);
  });
});
