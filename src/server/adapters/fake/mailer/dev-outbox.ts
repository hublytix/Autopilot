import 'server-only';
import type { Db } from '@/server/db';
import type { FakeMailSink, FakeSentMail } from './fake-mailer';

// The dev-mode sink (PLAN §4, D-29): every accepted email becomes a row in fake.dev_outbox, which
// the /dev outbox view reads. Fake mode only; the table exists only in PGlite (fake-shim.sql).

/** What fake.dev_outbox.meta holds besides the content columns. */
export interface DevOutboxMeta {
  providerMessageId: string;
  idempotencyKey: string;
  replyTo: string | null;
  lead: string | null;
  tags: { name: string; value: string }[];
}

export function devOutboxMeta(mail: FakeSentMail): DevOutboxMeta {
  return {
    providerMessageId: mail.providerMessageId,
    idempotencyKey: mail.idempotencyKey,
    replyTo: mail.replyTo ?? null,
    lead: mail.lead ?? null,
    tags: mail.tags.map((tag) => ({ name: tag.name, value: tag.value })),
  };
}

/** A FakeMailer sink that writes to fake.dev_outbox. A failed insert fails the send as transient. */
export function devOutboxSink(db: Db): FakeMailSink {
  return {
    kind: 'callback',
    deliver: async (mail) => {
      await db.query(
        `insert into fake.dev_outbox (created_at, "to", subject, html, text, kind, meta)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [mail.sentAt, mail.to, mail.subject, mail.html, mail.text, mail.kind, devOutboxMeta(mail)],
      );
    },
  };
}
