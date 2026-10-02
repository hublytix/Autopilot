import { describe, expect, it } from 'vitest';
import { AppError, errorCode, isRetryable } from '@/server/domain/errors';
import { DbError, DbUsageError, isTransientSqlstate } from './errors';

describe('DbError', () => {
  it('keeps only the SQLSTATE and object names, with a static message', () => {
    const error = new DbError({ sqlstate: '23505', constraint: 'users_email_lower_key', table: 'users', column: 'email' });
    expect(error).toBeInstanceOf(AppError);
    expect(errorCode(error)).toBe('db_error');
    expect(error.message).toBe('db_error');
    expect(error).toMatchObject({ sqlstate: '23505', constraint: 'users_email_lower_key', table: 'users', column: 'email' });
    expect(error.kind).toBe('permanent');
    expect(error.isUniqueViolation()).toBe(true);
    expect(error.isUniqueViolation('users_email_lower_key')).toBe(true);
    expect(error.isUniqueViolation('other_key')).toBe(false);
    expect('cause' in error).toBe(false);
  });

  it('drops malformed fields instead of carrying arbitrary text', () => {
    const error = new DbError({
      sqlstate: 'Key (email)=(secret@example.com)',
      constraint: 'has spaces; drop table',
      table: 'x'.repeat(100),
      column: 'secret@example.com',
    });
    expect(error.sqlstate).toBeUndefined();
    expect(error.constraint).toBeUndefined();
    expect(error.table).toBeUndefined();
    expect(error.column).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('secret');
  });

  it('classifies connection, serialization, deadlock, resource and shutdown errors as transient', () => {
    for (const sqlstate of ['08006', '08001', '40001', '40P01', '53300', '57014', '57P01', '57P03']) {
      expect(isTransientSqlstate(sqlstate)).toBe(true);
      expect(new DbError({ sqlstate }).kind).toBe('transient');
    }
    for (const sqlstate of ['23505', '23502', '42P01', '22P02', '25P02']) {
      expect(new DbError({ sqlstate }).kind).toBe('permanent');
    }
    expect(new DbError({ connectionFailure: true }).kind).toBe('transient');
    expect(new DbError().kind).toBe('permanent');
  });
});

describe('isRetryable (domain/errors) on database errors', () => {
  it('retries transient database errors and not permanent ones', () => {
    expect(isRetryable(new DbError({ sqlstate: '40001' }))).toBe(true);
    expect(isRetryable(new DbError({ connectionFailure: true }))).toBe(true);
    expect(isRetryable(new DbError({ sqlstate: '23505' }))).toBe(false);
    expect(isRetryable(new DbUsageError('db_handle_used_inside_tx'))).toBe(false);
  });
});

describe('DbUsageError', () => {
  it('is a permanent AppError whose message is its code', () => {
    const error = new DbUsageError('db_unexpected_row_count', 3);
    expect(error).toBeInstanceOf(AppError);
    expect(error.kind).toBe('permanent');
    expect(error.message).toBe('db_unexpected_row_count');
    expect(error.rowCount).toBe(3);
  });
});
