import 'server-only';

export { FakeMailer, IDEMPOTENCY_WINDOW_MS, MAX_IDEMPOTENCY_KEY_LENGTH, outboxFileBase } from './fake-mailer';
export type {
  FakeMailSink,
  FakeMailerFailure,
  FakeMailerOptions,
  FakeMailerPermanentCode,
  FakeMailerTransientCode,
  FakeSentMail,
} from './fake-mailer';
export { devOutboxMeta, devOutboxSink } from './dev-outbox';
export type { DevOutboxMeta } from './dev-outbox';
