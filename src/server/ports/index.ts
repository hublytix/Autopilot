import 'server-only';
import type { Db } from '@/server/db';
import type { Env } from '@/server/env';
import type { AuthProvider } from './auth';
import type { Billing } from './billing';
import type { Clock } from './clock';
import type { HubSpotClient } from './hubspot';
import type { LLM } from './llm';
import type { Mailer } from './mailer';
import type { Scheduler } from './scheduler';
import type { WebFetcher } from './web-fetcher';

export type * from './auth';
export type * from './billing';
export type * from './clock';
export type * from './hubspot';
export type * from './llm';
export type * from './mailer';
export type * from './scheduler';
export type * from './web-fetcher';

/**
 * Everything services need from the outside world. Services take a Deps and never import adapters;
 * `src/server/container.ts` builds it from the live or fake adapters (PLAN §3, §4).
 */
export interface Deps {
  /** The parsed environment of this process (`getEnv()`). */
  readonly env: Env;
  /** Postgres.js on the transaction pooler (live) or PGlite (fake mode, tests). */
  readonly db: Db;
  readonly clock: Clock;
  readonly hubspot: HubSpotClient;
  readonly llm: LLM;
  readonly mailer: Mailer;
  readonly scheduler: Scheduler;
  readonly billing: Billing;
  readonly webFetcher: WebFetcher;
  readonly auth: AuthProvider;
}
