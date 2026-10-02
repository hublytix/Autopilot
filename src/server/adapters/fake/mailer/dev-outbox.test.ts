import { describe, expect, it } from 'vitest';
import { TransientError } from '@/server/domain/errors';
import type { OutgoingMail } from '@/server/ports/mailer';
import { useTestDb } from '../../../../../test/db/harness';
import { FakeClock } from '../clock';
import { devOutboxSink } from './dev-outbox';
import { FakeMailer } from './fake-mailer';

const START = new Date('2026-10-06T14:00:00.000Z');

const MAIL: OutgoingMail = {
  to: ['owner@brightside-plumbing.example'],
  replyTo: 'maya.okafor@example.com',
  subject: 'New lead: Maya',
  html: '<p>Draft</p>',
  text: 'Draft',
  tags: [
    { name: 'kind', value: 'new_lead' },
    { name: 'lead', value: 'lead_42' },
  ],
  idempotencyKey: 'test:reply:42:s0',
};

interface OutboxRow {
  created_at: Date;
  to: string[];
  subject: string;
  html: string;
  text: string;
  kind: string;
  meta: Record<string, unknown>;
}

describe('FakeMailer with the dev outbox sink', () => {
  const getDb = useTestDb();

  it('writes each accepted email to fake.dev_outbox at the Clock time', async () => {
    const db = getDb();
    const mailer = new FakeMailer({ clock: new FakeClock(START), sink: devOutboxSink(db) });
    const { providerMessageId } = await mailer.send(MAIL);

    const rows = await db.query<OutboxRow>('select created_at, "to", subject, html, text, kind, meta from fake.dev_outbox');
    expect(rows).toEqual([
      {
        created_at: START,
        to: ['owner@brightside-plumbing.example'],
        subject: 'New lead: Maya',
        html: '<p>Draft</p>',
        text: 'Draft',
        kind: 'new_lead',
        meta: {
          providerMessageId,
          idempotencyKey: 'test:reply:42:s0',
          replyTo: 'maya.okafor@example.com',
          lead: 'lead_42',
          tags: [
            { name: 'kind', value: 'new_lead' },
            { name: 'lead', value: 'lead_42' },
          ],
        },
      },
    ]);
  });

  it('keeps Resend idempotency: a repeated send adds no row', async () => {
    const db = getDb();
    const mailer = new FakeMailer({ clock: new FakeClock(START), sink: devOutboxSink(db) });
    const first = await mailer.send(MAIL);
    expect(await mailer.send(MAIL)).toEqual(first);
    expect(await db.query('select id from fake.dev_outbox')).toHaveLength(1);
  });

  it('turns a failed insert into a transient send error and stores no idempotency key', async () => {
    const db = getDb();
    const mailer = new FakeMailer({ clock: new FakeClock(START), sink: devOutboxSink(db) });
    await db.exec('alter table fake.dev_outbox rename to dev_outbox_gone');
    try {
      await expect(mailer.send(MAIL)).rejects.toBeInstanceOf(TransientError);
    } finally {
      await db.exec('alter table fake.dev_outbox_gone rename to dev_outbox');
    }
    await mailer.send(MAIL);
    expect(await db.query('select id from fake.dev_outbox')).toHaveLength(1);
  });
});
