import 'server-only';

// The driver-independent surface. Import a driver explicitly where one is built:
// `./pglite` (tests, fake mode) or `./postgres` (live), so neither is bundled where it isn't used.
export type { Db, DbRow } from './types';
export { DbError, DbUsageError, isDbError, isDbUsageError, isTransientSqlstate } from './errors';
export type { DbErrorFields, DbUsageErrorCode } from './errors';
