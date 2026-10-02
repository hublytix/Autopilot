import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Clock } from '@/server/ports/clock';
import { PermanentError, TransientError } from '@/server/domain/errors';
import { DbError } from '@/server/db/errors';
import { createLogger, errorFields, type LogLevel } from './log';

function collect(minLevel?: LogLevel, clock?: Clock) {
  const lines: { level: LogLevel; record: Record<string, unknown> }[] = [];
  const logger = createLogger({ sink: (line, level) => lines.push({ level, record: JSON.parse(line) as Record<string, unknown> }), minLevel, clock });
  return { logger, lines };
}

describe('JSON-line logger', () => {
  it('writes one JSON object per call with the level, the static message and the fields', () => {
    const { logger, lines } = collect();
    logger.info('lead created', { event: 'lead.created', accountId: 'acc-1', leadId: 'lead-1', count: 2, durationMs: 15 });
    expect(lines).toEqual([
      {
        level: 'info',
        record: { level: 'info', msg: 'lead created', event: 'lead.created', accountId: 'acc-1', leadId: 'lead-1', count: 2, durationMs: 15 },
      },
    ]);
  });

  it('adds a timestamp only from an injected Clock', () => {
    const clock: Clock = { now: () => new Date('2030-01-02T03:04:05.000Z') };
    const { logger, lines } = collect('info', clock);
    logger.info('tick');
    expect(lines[0]?.record).toEqual({ level: 'info', time: '2030-01-02T03:04:05.000Z', msg: 'tick' });
    const plain = collect();
    plain.logger.info('tick');
    expect(plain.lines[0]?.record).not.toHaveProperty('time');
  });

  it('skips levels below the minimum (info by default)', () => {
    const { logger, lines } = collect();
    logger.debug('noisy');
    logger.warn('careful');
    logger.error('broken');
    expect(lines.map((line) => line.level)).toEqual(['warn', 'error']);
    const verbose = collect('debug');
    verbose.logger.debug('noisy');
    expect(verbose.lines).toHaveLength(1);
  });

  it('drops fields outside the allow-list and counts them', () => {
    const { logger, lines } = collect();
    const fields = { event: 'x', body: 'content', payload: { a: 1 } } as unknown as Parameters<typeof logger.info>[1];
    logger.info('dropping', fields);
    expect(lines[0]?.record).toEqual({ level: 'info', msg: 'dropping', event: 'x', droppedFields: 2 });
  });

  it('never logs objects wholesale, but keeps short arrays of scalars', () => {
    const { logger, lines } = collect();
    const fields = { event: 'x', code: { nested: 'object' }, codes: ['a', 'b'], count: Number.NaN } as unknown as Parameters<typeof logger.info>[1];
    logger.info('values', fields);
    expect(lines[0]?.record).toEqual({ level: 'info', msg: 'values', event: 'x', codes: ['a', 'b'], count: null, droppedFields: 1 });
  });

  it('truncates long strings', () => {
    const { logger, lines } = collect();
    logger.info('long', { route: `/${'x'.repeat(1000)}` });
    expect(String(lines[0]?.record.route)).toHaveLength(257);
  });

  it('keeps only code-shaped values in code fields', () => {
    const { logger, lines } = collect();
    logger.info('codes', { event: 'lead.created', reason: 'the lead wrote something long', status: 'privacy_deletion', codes: ['ok', 'not ok'] });
    expect(lines[0]?.record).toEqual({
      level: 'info',
      msg: 'codes',
      event: 'lead.created',
      reason: '[redacted]',
      status: 'privacy_deletion',
      codes: ['ok', '[redacted]'],
    });
  });

  it('binds fields in child loggers', () => {
    const { logger, lines } = collect();
    logger.child({ jobId: 'job-1', jobKind: 'lead_process' }).warn('retrying', { attempt: 2 });
    expect(lines[0]?.record).toEqual({ level: 'warn', msg: 'retrying', jobId: 'job-1', jobKind: 'lead_process', attempt: 2 });
  });

  describe('default sink', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('sends warn and error lines to stderr and the rest to stdout', () => {
      const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const logger = createLogger();
      logger.info('to stdout');
      logger.warn('to stderr');
      logger.error('to stderr too');
      expect(stdout.mock.calls.map(([line]) => JSON.parse(String(line)).msg)).toEqual(['to stdout']);
      expect(stderr.mock.calls.map(([line]) => JSON.parse(String(line)).msg)).toEqual(['to stderr', 'to stderr too']);
    });
  });

  describe('errors', () => {
    it('logs only the name, code, SQLSTATE and HTTP status of an error', () => {
      expect(errorFields(new TransientError('hubspot_rate_limited', { httpStatus: 429, retryAfterMs: 1000 }))).toEqual({
        errorName: 'TransientError',
        errorCode: 'hubspot_rate_limited',
        httpStatus: 429,
      });
      expect(errorFields(new DbError({ sqlstate: '23505', constraint: 'users_email_lower_key' }))).toEqual({
        errorName: 'DbError',
        errorCode: 'db_error',
        sqlstate: '23505',
      });
      expect(errorFields(new PermanentError('validation_failed'))).toEqual({ errorName: 'PermanentError', errorCode: 'validation_failed' });
      expect(errorFields(new TypeError('Cannot read properties of undefined'))).toEqual({ errorName: 'TypeError' });
      expect(errorFields('a thrown string')).toEqual({ errorName: 'string' });
      expect(errorFields(null)).toEqual({ errorName: 'object' });
    });

    it('rejects codes and names that are not identifiers', () => {
      const weird = Object.assign(new Error('x'), { name: 'Bad name with spaces', code: 'not a code', status: 9000 });
      expect(errorFields(weird)).toEqual({ errorName: 'Error' });
    });

    it('adds the error fields to the line', () => {
      const { logger, lines } = collect();
      logger.error('job failed', { event: 'job.failed', jobId: 'job-1' }, new DbError({ sqlstate: '40001' }));
      expect(lines[0]?.record).toEqual({
        level: 'error',
        msg: 'job failed',
        event: 'job.failed',
        jobId: 'job-1',
        errorName: 'DbError',
        errorCode: 'db_error',
        sqlstate: '40001',
      });
    });
  });

  it('rejects non-literal messages at compile time', () => {
    const { logger } = collect();
    const dynamic: string = `lead ${'x'}`;
    // @ts-expect-error a string-typed message is not a static literal
    logger.info(dynamic);
    logger.info('static literal');
  });

  it('rejects fields outside the allow-list at compile time', () => {
    const { logger } = collect();
    // @ts-expect-error `email` is not an allow-listed field
    logger.info('nope', { email: 'x' });
  });
});
