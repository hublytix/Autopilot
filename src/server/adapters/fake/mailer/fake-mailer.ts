import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { IdempotencyConflictError, PermanentError, TransientError } from '@/server/domain/errors';
import type { Clock } from '@/server/ports/clock';
import type { MailTag, Mailer, OutgoingMail, SentMail } from '@/server/ports/mailer';

/** Resend keeps idempotency keys for 24 hours (RS-IDEMPOTENCY-LIMITS). */
export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Resend's `Idempotency-Key` maximum length. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

/** One accepted email, as the fake stores it. Holds content: tests and the dev outbox only, never logs. */
export interface FakeSentMail {
  /** 1-based delivery order (also the NNN of directory sink file names). */
  seq: number;
  providerMessageId: string;
  sentAt: Date;
  to: string[];
  replyTo?: string | undefined;
  subject: string;
  html: string;
  text: string;
  tags: MailTag[];
  idempotencyKey: string;
  /** The `kind` tag, or `email` when absent. */
  kind: string;
  /** The `lead` tag, when present. */
  lead?: string | undefined;
}

/** Where accepted mail goes, in addition to the in-memory list every sink keeps. */
export type FakeMailSink =
  | { kind: 'memory' }
  /** Writes `NNN-<kind>-<lead>.html` and `.txt` (`NNN-<kind>.*` without a lead) into `dir`. */
  | { kind: 'directory'; dir: string }
  /** e.g. the integrator's `fake.dev_outbox` writer. A throw fails the send as a transient error. */
  | { kind: 'callback'; deliver: (mail: FakeSentMail) => Promise<void> | void };

export type FakeMailerTransientCode = 'rate_limit_exceeded' | 'internal_server_error';
export type FakeMailerPermanentCode = 'validation_error';

export type FakeMailerFailure =
  | {
      kind: 'transient';
      code: FakeMailerTransientCode;
      retryAfterMs?: number | undefined;
      /**
       * The email is delivered and its key stored, but the caller still sees the error (a lost
       * response, or a crash after the send): a retry then gets the original result or a 409.
       */
      afterSend?: boolean | undefined;
      times?: number | undefined;
    }
  | { kind: 'permanent'; code: FakeMailerPermanentCode; times?: number | undefined };

export interface FakeMailerOptions {
  clock: Clock;
  /** Default `{ kind: 'memory' }`. */
  sink?: FakeMailSink | undefined;
}

interface IdempotencyRecord {
  payloadHash: string;
  result: SentMail;
  expiresAtMs: number;
}

type QueuedFailure = FakeMailerFailure & { remaining: number };

const TAG_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const ADDRESS_PATTERN = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

function statusOf(code: FakeMailerTransientCode): number {
  return code === 'rate_limit_exceeded' ? 429 : 500;
}

function payloadHash(mail: OutgoingMail): string {
  const canonical = JSON.stringify({
    to: [...mail.to],
    replyTo: mail.replyTo ?? null,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    tags: (mail.tags ?? []).map((t) => [t.name, t.value]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function fileSafe(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

/** `NNN-<kind>-<lead>` (`NNN-<kind>` without a lead): the directory sink's file names, minus `.html`/`.txt`. */
export function outboxFileBase(mail: Pick<FakeSentMail, 'seq' | 'kind' | 'lead'>): string {
  return [String(mail.seq).padStart(3, '0'), fileSafe(mail.kind), ...(mail.lead !== undefined ? [fileSafe(mail.lead)] : [])].join('-');
}

/**
 * The fake `Mailer` (PLAN §4) with Resend's idempotency semantics: the same key with the same payload
 * returns the original result and sends nothing; the same key with a different payload throws
 * `IdempotencyConflictError` (409 `invalid_idempotent_request`); keys expire after 24 h of Clock time.
 * A send whose key is still in flight gets Resend's transient 409 `concurrent_idempotent_requests`
 * (RS-IDEMPOTENCY-LIMITS) and sends nothing. Validation and injected failures happen before a key is
 * stored, so a retry can still send.
 */
export class FakeMailer implements Mailer {
  readonly #clock: Clock;
  readonly #sink: FakeMailSink;
  readonly #keys = new Map<string, IdempotencyRecord>();
  /** Keys whose first send has not finished yet. */
  readonly #inFlight = new Set<string>();
  readonly #sent: FakeSentMail[] = [];
  readonly #failures: QueuedFailure[] = [];
  #attempts = 0;

  constructor(options: FakeMailerOptions) {
    this.#clock = options.clock;
    this.#sink = options.sink ?? { kind: 'memory' };
  }

  /** Every accepted email, oldest first. */
  get sent(): readonly FakeSentMail[] {
    return [...this.#sent];
  }

  /** Every `send` call, including deduplicated, conflicting and failed ones. */
  get attempts(): number {
    return this.#attempts;
  }

  /** Queues a failure for the next `times` (default 1) sends. */
  injectFailure(failure: FakeMailerFailure): void {
    const times = failure.times ?? 1;
    if (!Number.isInteger(times) || times < 1) throw new RangeError('fake_mailer_invalid_times');
    this.#failures.push({ ...failure, remaining: times });
  }

  clearFailures(): void {
    this.#failures.length = 0;
  }

  async send(mail: OutgoingMail): Promise<SentMail> {
    this.#attempts += 1;
    const nowMs = this.#clock.now().getTime();
    this.#expireKeys(nowMs);
    this.#validate(mail);

    const hash = payloadHash(mail);
    const existing = this.#keys.get(mail.idempotencyKey);
    if (existing !== undefined) {
      if (existing.payloadHash !== hash) throw new IdempotencyConflictError();
      return { ...existing.result };
    }
    if (this.#inFlight.has(mail.idempotencyKey)) {
      throw new TransientError('concurrent_idempotent_requests', { httpStatus: 409 });
    }

    const failure = this.#takeFailure();
    if (failure?.kind === 'permanent') throw new PermanentError(failure.code, { httpStatus: 422 });
    if (failure?.kind === 'transient' && failure.afterSend !== true) {
      throw new TransientError(failure.code, { httpStatus: statusOf(failure.code), retryAfterMs: failure.retryAfterMs });
    }

    // Marked before the first await, so an overlapping send with the same key sees it.
    this.#inFlight.add(mail.idempotencyKey);
    let record: SentMail;
    try {
      record = await this.#deliver(mail, nowMs);
      this.#keys.set(mail.idempotencyKey, { payloadHash: hash, result: record, expiresAtMs: nowMs + IDEMPOTENCY_WINDOW_MS });
    } finally {
      this.#inFlight.delete(mail.idempotencyKey);
    }
    if (failure?.kind === 'transient') {
      throw new TransientError(failure.code, { httpStatus: statusOf(failure.code), retryAfterMs: failure.retryAfterMs });
    }
    return { ...record };
  }

  #validate(mail: OutgoingMail): void {
    const key = mail.idempotencyKey;
    if (key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new PermanentError('invalid_idempotency_key', { httpStatus: 400 });
    }
    const valid =
      mail.to.length > 0 &&
      mail.to.length <= 50 &&
      mail.to.every((a) => ADDRESS_PATTERN.test(a)) &&
      (mail.replyTo === undefined || ADDRESS_PATTERN.test(mail.replyTo)) &&
      mail.subject.trim().length > 0 &&
      !/[\r\n]/.test(mail.subject) &&
      (mail.html.length > 0 || mail.text.length > 0) &&
      (mail.tags ?? []).every((t) => TAG_PATTERN.test(t.name) && TAG_PATTERN.test(t.value));
    if (!valid) throw new PermanentError('validation_error', { httpStatus: 422 });
  }

  #takeFailure(): FakeMailerFailure | null {
    const next = this.#failures[0];
    if (next === undefined) return null;
    next.remaining -= 1;
    if (next.remaining <= 0) this.#failures.shift();
    return next;
  }

  #expireKeys(nowMs: number): void {
    for (const [key, record] of this.#keys) if (record.expiresAtMs <= nowMs) this.#keys.delete(key);
  }

  async #deliver(mail: OutgoingMail, nowMs: number): Promise<SentMail> {
    const tags = (mail.tags ?? []).map((t) => ({ name: t.name, value: t.value }));
    const kind = tags.find((t) => t.name === 'kind')?.value ?? 'email';
    const lead = tags.find((t) => t.name === 'lead')?.value;
    const record: FakeSentMail = {
      seq: this.#sent.length + 1,
      providerMessageId: randomUUID(),
      sentAt: new Date(nowMs),
      to: [...mail.to],
      replyTo: mail.replyTo,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      tags,
      idempotencyKey: mail.idempotencyKey,
      kind,
      lead,
    };
    try {
      if (this.#sink.kind === 'directory') await this.#writeFiles(this.#sink.dir, record);
      if (this.#sink.kind === 'callback') await this.#sink.deliver(record);
    } catch {
      // The sink is the fake's "provider": its failure is a provider-side error the caller may retry.
      throw new TransientError('application_error', { httpStatus: 500 });
    }
    this.#sent.push(record);
    return { providerMessageId: record.providerMessageId };
  }

  async #writeFiles(dir: string, mail: FakeSentMail): Promise<void> {
    const base = outboxFileBase(mail);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${base}.html`), mail.html, 'utf8');
    await writeFile(path.join(dir, `${base}.txt`), mail.text, 'utf8');
  }
}
