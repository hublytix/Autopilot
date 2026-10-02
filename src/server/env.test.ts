import { QSTASH_PUBLIC_DEV_TOKEN } from '../../test/support/fake-secrets';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ENV_DEFAULTS, ENV_NAMES, EnvError, FAKE_ENV, getEnv, parseEnv, type EnvSource } from './env';

// Plausible, clearly non-real live values (no real secrets anywhere in the repo).
const key = (fill: number): string => Buffer.alloc(32, fill).toString('base64');

function liveSource(overrides: Record<string, string | undefined> = {}): EnvSource {
  return {
    APP_MODE: 'live',
    APP_URL: 'https://autopilot.example.com',
    APP_SECRET: key(1),
    TOKEN_ENCRYPTION_KEY: key(2),
    ADMIN_EMAILS: 'Ops@Example.com, second@example.com',
    ENV_NAMESPACE: 'prod',
    DATABASE_URL: 'postgresql://postgres.ref:pw-test-123@aws-0-eu-central-1.pooler.supabase.com:6543/postgres',
    SUPABASE_URL: 'https://ref.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_testvalue123',
    SUPABASE_SECRET_KEY: 'sb_secret_testvalue456',
    HUBSPOT_CLIENT_ID: '11111111-2222-4333-8444-555555555555',
    HUBSPOT_CLIENT_SECRET: '66666666-7777-4888-9999-000000000000',
    HUBSPOT_APP_ID: '1234567',
    HUBSPOT_REDIRECT_URI: 'https://autopilot.example.com/api/hubspot/oauth/callback',
    HUBSPOT_WEBHOOK_TARGET_URL: 'https://autopilot.example.com/api/hubspot/webhooks',
    QSTASH_URL: 'https://qstash-eu-central-1.upstash.io',
    QSTASH_TOKEN: 'qstash-test-token-value',
    QSTASH_CURRENT_SIGNING_KEY: 'sig_testCurrentKey000000000000',
    QSTASH_NEXT_SIGNING_KEY: 'sig_testNextKey00000000000000',
    CRON_SECRET: 'c'.repeat(40),
    RESEND_API_KEY: 're_testvalue_123',
    EMAIL_FROM: 'Hublytix Autopilot <noreply@autopilot.example.com>',
    EMAIL_REPLY_TO: 'support@autopilot.example.com',
    ANTHROPIC_API_KEY: 'sk-ant-testvalue',
    RAZORPAY_KEY_ID: 'rzp_test_testvalue',
    RAZORPAY_KEY_SECRET: 'razorpay-test-secret',
    RAZORPAY_WEBHOOK_SECRET: 'razorpay-test-webhook-secret',
    RAZORPAY_PLAN_ID: 'plan_testvalue',
    ...overrides,
  };
}

/** Variables env.ts reads but never asks anyone to set (they are switches live mode refuses). */
const READ_ONLY: readonly string[] = ['VERCEL_ENV', 'QSTASH_DEV', 'QSTASH_REGION', 'SENTRY_TRACES_SAMPLE_RATE', 'SENTRY_SPOTLIGHT', 'SENTRY_DEBUG'];

function issuesOf(source: EnvSource): readonly string[] {
  try {
    parseEnv(source);
  } catch (error) {
    if (error instanceof EnvError) return error.issues;
    throw error;
  }
  return [];
}

describe('env.ts (PLAN §14, D-29, D-51)', () => {
  describe('APP_MODE', () => {
    it('is required', () => {
      expect(issuesOf({})).toContainEqual(expect.stringMatching(/^APP_MODE: /));
      expect(issuesOf({ APP_MODE: '' })).toContainEqual(expect.stringMatching(/^APP_MODE: /));
    });

    it('must be fake or live', () => {
      expect(issuesOf({ APP_MODE: 'staging' })).toContainEqual('APP_MODE: must be "fake" or "live" (required)');
    });
  });

  describe('documented defaults', () => {
    it('match the PLAN §14 table', () => {
      expect(ENV_DEFAULTS).toEqual({
        PRODUCT_NAME: 'Hublytix Autopilot',
        ANTHROPIC_MODEL_DRAFT: 'claude-sonnet-5-5',
        ANTHROPIC_MODEL_FAST: 'claude-haiku-4-5-20251001',
        ANTHROPIC_DRAFT_THINKING: 'between_tools',
        ANTHROPIC_DRAFT_EFFORT: 'medium',
        ANTHROPIC_DRAFT_MAX_TOKENS: '1024',
        ANTHROPIC_BRIEF_EFFORT: 'high',
        HUBSPOT_API_VERSION: '2026-09',
        HUBSPOT_JOURNAL_ENABLED: 'false',
        QSTASH_MAX_DELAY_SECONDS: '601200',
        COMPOSE_URL_LIMIT: '1800',
        COMPOSE_GMAIL_FORM: 'u',
        COMPOSE_OUTLOOK_MODE: 'mailtouri',
        COMPOSE_OUTLOOK_WORK_BASE: 'https://outlook.cloud.microsoft/mail/deeplink/compose',
        COMPOSE_OUTLOOK_PERSONAL_BASE: 'https://outlook.live.com/mail/deeplink/compose',
        MAX_DRAFTED_LEADS_PER_DAY: '50',
        AI_DAILY_BUDGET_USD: '25',
        FAKE_DB_DIR: '.data/pglite',
      });
    });

    it('apply in live mode, parsed to their types', () => {
      const env = parseEnv(liveSource());
      expect(env).toMatchObject({
        PRODUCT_NAME: 'Hublytix Autopilot',
        ANTHROPIC_MODEL_DRAFT: 'claude-sonnet-5-5',
        ANTHROPIC_MODEL_FAST: 'claude-haiku-4-5-20251001',
        ANTHROPIC_DRAFT_THINKING: 'between_tools',
        ANTHROPIC_DRAFT_EFFORT: 'medium',
        ANTHROPIC_DRAFT_MAX_TOKENS: 1024,
        ANTHROPIC_BRIEF_EFFORT: 'high',
        HUBSPOT_API_VERSION: '2026-09',
        HUBSPOT_JOURNAL_ENABLED: false,
        QSTASH_MAX_DELAY_SECONDS: 601200,
        COMPOSE_URL_LIMIT: 1800,
        COMPOSE_GMAIL_FORM: 'u',
        COMPOSE_OUTLOOK_MODE: 'mailtouri',
        MAX_DRAFTED_LEADS_PER_DAY: 50,
        AI_DAILY_BUDGET_USD: 25,
        FAKE_DB_DIR: '.data/pglite',
      });
    });

    it('can be overridden', () => {
      const env = parseEnv(
        liveSource({
          COMPOSE_URL_LIMIT: '2000',
          COMPOSE_GMAIL_FORM: 'view',
          COMPOSE_OUTLOOK_MODE: 'params',
          HUBSPOT_JOURNAL_ENABLED: 'true',
          AI_DAILY_BUDGET_USD: '12.50',
          ANTHROPIC_DRAFT_THINKING: 'adaptive',
          PRODUCT_NAME: '  Autopilot  ',
        }),
      );
      expect(env).toMatchObject({
        COMPOSE_URL_LIMIT: 2000,
        COMPOSE_GMAIL_FORM: 'view',
        COMPOSE_OUTLOOK_MODE: 'params',
        HUBSPOT_JOURNAL_ENABLED: true,
        AI_DAILY_BUDGET_USD: 12.5,
        ANTHROPIC_DRAFT_THINKING: 'adaptive',
        PRODUCT_NAME: 'Autopilot',
      });
    });

    it('treat empty strings as unset', () => {
      expect(parseEnv(liveSource({ COMPOSE_URL_LIMIT: '', TOKEN_ENCRYPTION_KEY_PREVIOUS: '' }))).toMatchObject({
        COMPOSE_URL_LIMIT: 1800,
        TOKEN_ENCRYPTION_KEY_PREVIOUS: undefined,
      });
    });

    it.each([
      ['COMPOSE_URL_LIMIT', 'abc'],
      ['COMPOSE_URL_LIMIT', '10'],
      ['COMPOSE_GMAIL_FORM', 'x'],
      ['COMPOSE_OUTLOOK_MODE', 'deeplink'],
      ['ANTHROPIC_DRAFT_EFFORT', 'extreme'],
      ['ANTHROPIC_DRAFT_THINKING', 'enabled'],
      ['HUBSPOT_JOURNAL_ENABLED', 'yes'],
      ['HUBSPOT_API_VERSION', 'v3'],
      ['QSTASH_MAX_DELAY_SECONDS', '700000'],
      ['AI_DAILY_BUDGET_USD', '-1'],
      ['COMPOSE_OUTLOOK_WORK_BASE', 'not a url'],
    ])('reject a malformed %s', (name, value) => {
      expect(issuesOf(liveSource({ [name]: value }))).toContainEqual(expect.stringMatching(new RegExp(`^${name}: `)));
    });
  });

  describe('fake mode', () => {
    it('runs with no other variable, using the documented fake values', () => {
      const env = parseEnv({ APP_MODE: 'fake' });
      expect(env.APP_MODE).toBe('fake');
      for (const [name, value] of Object.entries(FAKE_ENV)) {
        if (name === 'ADMIN_EMAILS') expect(env.ADMIN_EMAILS).toEqual([value]);
        else if (name === 'APP_URL') expect(env.APP_URL).toBe(value);
        else expect(env[name as keyof typeof env]).toBe(value);
      }
      expect(env.FAKE_DB_DIR).toBe('.data/pglite');
      expect(env.SENTRY_DSN).toBeUndefined();
    });

    it('uses clearly named fake values', () => {
      for (const [name, value] of Object.entries(FAKE_ENV)) {
        const decoded = /^[A-Za-z0-9+/]{43}=$/.test(value) ? Buffer.from(value, 'base64').toString('utf8') : value;
        if (name === 'HUBSPOT_APP_ID' || name === 'APP_URL' || name.startsWith('HUBSPOT_REDIRECT') || name.startsWith('HUBSPOT_WEBHOOK')) continue;
        expect(decoded.toLowerCase(), name).toMatch(/fake/);
      }
    });

    it('keeps a provided value and derives the fake HubSpot URLs from a custom APP_URL', () => {
      const env = parseEnv({ APP_MODE: 'fake', APP_URL: 'http://localhost:3001/', PRODUCT_NAME: 'Demo' });
      expect(env.APP_URL).toBe('http://localhost:3001');
      expect(env.PRODUCT_NAME).toBe('Demo');
      expect(env.HUBSPOT_REDIRECT_URI).toBe('http://localhost:3001/api/hubspot/oauth/callback');
      expect(env.HUBSPOT_WEBHOOK_TARGET_URL).toBe('http://localhost:3001/api/hubspot/webhooks');
    });

    it('still checks the shape of provided values', () => {
      expect(issuesOf({ APP_MODE: 'fake', TOKEN_ENCRYPTION_KEY: 'short' })).toContainEqual(
        'TOKEN_ENCRYPTION_KEY: must be base64 for exactly 32 bytes',
      );
    });

    it.each(['production', 'preview'])('is refused on Vercel %s', (vercelEnv) => {
      const realKeys = { APP_SECRET: key(7), TOKEN_ENCRYPTION_KEY: key(8) };
      expect(issuesOf({ APP_MODE: 'fake', VERCEL_ENV: vercelEnv, ...realKeys })).toEqual([
        `APP_MODE: fake mode is refused on Vercel ${vercelEnv} unless ALLOW_FAKE_ON_VERCEL=1`,
      ]);
      expect(issuesOf({ APP_MODE: 'fake', VERCEL_ENV: vercelEnv, ALLOW_FAKE_ON_VERCEL: '0', ...realKeys })).toHaveLength(1);
      expect(issuesOf({ APP_MODE: 'fake', VERCEL_ENV: vercelEnv })).toContainEqual(
        `APP_MODE: fake mode is refused on Vercel ${vercelEnv} unless ALLOW_FAKE_ON_VERCEL=1`,
      );
    });

    it('is allowed on Vercel with ALLOW_FAKE_ON_VERCEL=1 and real keys, and on Vercel development', () => {
      const realKeys = { APP_SECRET: key(7), TOKEN_ENCRYPTION_KEY: key(8) };
      expect(parseEnv({ APP_MODE: 'fake', VERCEL_ENV: 'preview', ALLOW_FAKE_ON_VERCEL: '1', ...realKeys }).ALLOW_FAKE_ON_VERCEL).toBe(true);
      expect(parseEnv({ APP_MODE: 'fake', VERCEL_ENV: 'development' }).APP_MODE).toBe('fake');
    });

    // The fake keys are public: on a reachable deployment they would let anyone forge an ap_session
    // cookie (its key is derived from APP_SECRET) for any user, admins included.
    it.each([
      ['Vercel preview', { VERCEL_ENV: 'preview', ALLOW_FAKE_ON_VERCEL: '1' }],
      ['Vercel production', { VERCEL_ENV: 'production', ALLOW_FAKE_ON_VERCEL: '1' }],
      ['a public APP_URL', { APP_URL: 'https://demo.autopilot.example.com' }],
      ['a LAN APP_URL', { APP_URL: 'http://192.168.1.20:3000' }],
    ])('on %s, refuses the documented fake APP_SECRET and TOKEN_ENCRYPTION_KEY', (_where, overrides) => {
      const problem = 'fake mode on a Vercel deployment or a non-loopback APP_URL needs a real, non-fake value';
      expect(issuesOf({ APP_MODE: 'fake', ...overrides })).toEqual([`APP_SECRET: ${problem}`, `TOKEN_ENCRYPTION_KEY: ${problem}`]);
      expect(issuesOf({ APP_MODE: 'fake', ...overrides, APP_SECRET: FAKE_ENV.APP_SECRET, TOKEN_ENCRYPTION_KEY: key(8) })).toEqual([
        `APP_SECRET: ${problem}`,
      ]);
      expect(issuesOf({ APP_MODE: 'fake', ...overrides, APP_SECRET: key(7), TOKEN_ENCRYPTION_KEY: key(8) })).toEqual([]);
    });

    it.each(['http://localhost:3000', 'http://127.0.0.1:4100', 'http://[::1]:3000', 'http://autopilot.localhost:3000'])(
      'keeps the fake keys on the loopback origin %s',
      (appUrl) => {
        expect(parseEnv({ APP_MODE: 'fake', APP_URL: appUrl }).APP_SECRET).toBe(FAKE_ENV.APP_SECRET);
      },
    );

    it('allows QSTASH_DEV', () => {
      expect(parseEnv({ APP_MODE: 'fake', QSTASH_DEV: 'true' }).QSTASH_DEV).toBe('true');
    });
  });

  describe('live mode', () => {
    it('accepts a complete, well-formed environment', () => {
      const env = parseEnv(liveSource());
      expect(env.APP_MODE).toBe('live');
      expect(env.APP_URL).toBe('https://autopilot.example.com');
      expect(env.ADMIN_EMAILS).toEqual(['ops@example.com', 'second@example.com']);
      expect(Object.isFrozen(env)).toBe(true);
    });

    it('requires every variable without a documented default', () => {
      const issues = issuesOf({ APP_MODE: 'live' });
      const required = issues.filter((issue) => issue.endsWith(': is required in live mode')).map((issue) => issue.split(':')[0]);
      expect(required.sort()).toEqual(
        [
          'APP_URL', 'APP_SECRET', 'TOKEN_ENCRYPTION_KEY', 'ADMIN_EMAILS', 'ENV_NAMESPACE', 'DATABASE_URL', 'SUPABASE_URL',
          'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'HUBSPOT_CLIENT_ID', 'HUBSPOT_CLIENT_SECRET', 'HUBSPOT_APP_ID',
          'HUBSPOT_REDIRECT_URI', 'HUBSPOT_WEBHOOK_TARGET_URL', 'QSTASH_URL', 'QSTASH_TOKEN', 'QSTASH_CURRENT_SIGNING_KEY',
          'QSTASH_NEXT_SIGNING_KEY', 'CRON_SECRET', 'RESEND_API_KEY', 'EMAIL_FROM', 'EMAIL_REPLY_TO', 'ANTHROPIC_API_KEY',
          'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'RAZORPAY_PLAN_ID',
        ].sort(),
      );
    });

    it('keeps rotation and Sentry variables optional', () => {
      const env = parseEnv(liveSource());
      for (const name of [
        'TOKEN_ENCRYPTION_KEY_PREVIOUS', 'HUBSPOT_CLIENT_SECRET_PREVIOUS', 'RAZORPAY_WEBHOOK_SECRET_PREVIOUS', 'ALLOW_FAKE_ON_VERCEL',
        'SENTRY_DSN', 'NEXT_PUBLIC_SENTRY_DSN', 'SENTRY_ORG', 'SENTRY_PROJECT', 'SENTRY_AUTH_TOKEN',
      ] as const) {
        expect(env[name], name).toBeUndefined();
      }
    });

    it.each(Object.keys(FAKE_ENV).filter((name) => name !== 'HUBSPOT_APP_ID'))('refuses the documented fake value of %s', (name) => {
      const value = FAKE_ENV[name as keyof typeof FAKE_ENV];
      expect(issuesOf(liveSource({ [name]: value }))).toContainEqual(`${name}: a documented fake value is not allowed in live mode`);
    });

    it('refuses any value marked fake-only, including inside a base64 key', () => {
      expect(issuesOf(liveSource({ QSTASH_TOKEN: 'my-fake-only-token' }))).toContainEqual(
        'QSTASH_TOKEN: a documented fake value is not allowed in live mode',
      );
      const fakeKey = Buffer.from('xx-fake_only-previous-key-000000').toString('base64');
      expect(issuesOf(liveSource({ TOKEN_ENCRYPTION_KEY_PREVIOUS: fakeKey }))).toContainEqual(
        'TOKEN_ENCRYPTION_KEY_PREVIOUS: a documented fake value is not allowed in live mode',
      );
    });

    it.each([
      ['SUPABASE_SECRET_KEY', 'service-role-jwt', 'must start with sb_secret_'],
      ['SUPABASE_PUBLISHABLE_KEY', 'anon-key', 'must start with sb_publishable_'],
      ['RESEND_API_KEY', 'key_123', 'must start with re_'],
      ['ANTHROPIC_API_KEY', 'sk-openai-123', 'must start with sk-ant-'],
      ['RAZORPAY_KEY_ID', 'key_123', 'must start with rzp_test_ or rzp_live_'],
      ['RAZORPAY_PLAN_ID', 'pl_123', 'must start with plan_'],
      ['QSTASH_CURRENT_SIGNING_KEY', 'key_123', 'must start with sig_'],
      ['APP_SECRET', Buffer.alloc(16, 1).toString('base64'), 'must be base64 for exactly 32 bytes'],
      ['TOKEN_ENCRYPTION_KEY', 'not-base64-at-all', 'must be base64 for exactly 32 bytes'],
      ['CRON_SECRET', 'short', 'must be at least 32 visible ASCII characters without spaces'],
      ['ADMIN_EMAILS', 'ops@example.com, not-an-email', 'must be a comma-separated list of email addresses'],
      ['EMAIL_REPLY_TO', 'support', 'must be an email address'],
      ['ENV_NAMESPACE', 'Prod Env', 'must be 1-32 lower-case letters, digits or dashes'],
      ['APP_URL', 'https://autopilot.example.com/app', 'must be an origin (scheme and host only, no path)'],
      ['DATABASE_URL', 'mysql://x@y/z', 'must be a postgres:// or postgresql:// URL'],
    ])('checks the shape of %s', (name, value, problem) => {
      expect(issuesOf(liveSource({ [name]: value }))).toContainEqual(`${name}: ${problem}`);
    });

    it('requires rzp_live_ on Vercel production only', () => {
      expect(issuesOf(liveSource({ VERCEL_ENV: 'production' }))).toEqual(['RAZORPAY_KEY_ID: must start with rzp_live_ on Vercel production']);
      expect(parseEnv(liveSource({ VERCEL_ENV: 'production', RAZORPAY_KEY_ID: 'rzp_live_abc123' })).RAZORPAY_KEY_ID).toBe('rzp_live_abc123');
      expect(parseEnv(liveSource({ VERCEL_ENV: 'preview' })).RAZORPAY_KEY_ID).toBe('rzp_test_testvalue');
    });

    it('requires the previous keys and secrets to differ from the current ones', () => {
      expect(issuesOf(liveSource({ TOKEN_ENCRYPTION_KEY_PREVIOUS: key(2) }))).toContainEqual(
        'TOKEN_ENCRYPTION_KEY_PREVIOUS: must differ from TOKEN_ENCRYPTION_KEY',
      );
      // The same 32 bytes written as base64url still count as the same key.
      expect(issuesOf(liveSource({ TOKEN_ENCRYPTION_KEY_PREVIOUS: Buffer.alloc(32, 2).toString('base64url') }))).toContainEqual(
        'TOKEN_ENCRYPTION_KEY_PREVIOUS: must differ from TOKEN_ENCRYPTION_KEY',
      );
      expect(issuesOf(liveSource({ HUBSPOT_CLIENT_SECRET_PREVIOUS: '66666666-7777-4888-9999-000000000000' }))).toContainEqual(
        'HUBSPOT_CLIENT_SECRET_PREVIOUS: must differ from HUBSPOT_CLIENT_SECRET',
      );
      expect(issuesOf(liveSource({ RAZORPAY_WEBHOOK_SECRET_PREVIOUS: 'razorpay-test-webhook-secret' }))).toContainEqual(
        'RAZORPAY_WEBHOOK_SECRET_PREVIOUS: must differ from RAZORPAY_WEBHOOK_SECRET',
      );
      expect(issuesOf(liveSource({ APP_SECRET: key(2) }))).toContainEqual('APP_SECRET: must differ from the token encryption keys');
      expect(parseEnv(liveSource({ TOKEN_ENCRYPTION_KEY_PREVIOUS: key(3) })).TOKEN_ENCRYPTION_KEY_PREVIOUS).toBe(key(3));
    });

    it('refuses QSTASH_DEV, and the public QStash dev signing keys', () => {
      expect(issuesOf(liveSource({ QSTASH_DEV: 'true' }))).toContainEqual('QSTASH_DEV: must be unset in live mode');
      expect(issuesOf(liveSource({ QSTASH_DEV: 'false' }))).toContainEqual('QSTASH_DEV: must be unset in live mode');
      expect(parseEnv(liveSource({ QSTASH_DEV: '' })).QSTASH_DEV).toBeUndefined();
      expect(issuesOf(liveSource({ QSTASH_CURRENT_SIGNING_KEY: 'sig_7kYjw48mhY7kAjqNGcy6cr29RJ6r' }))).toContainEqual(
        'QSTASH_CURRENT_SIGNING_KEY: the public QStash dev-server key is not allowed in live mode',
      );
    });

    it('refuses the QStash dev token, QSTASH_REGION and region-prefixed QStash variables', () => {
      expect(issuesOf(liveSource({ QSTASH_TOKEN: QSTASH_PUBLIC_DEV_TOKEN }))).toContainEqual(
        'QSTASH_TOKEN: the public QStash dev-server token is not allowed in live mode',
      );
      expect(issuesOf(liveSource({ QSTASH_REGION: 'EU_CENTRAL_1' }))).toEqual([
        'QSTASH_REGION: must be unset in live mode (it routes to region-prefixed credentials that are not validated)',
      ]);
      expect(
        issuesOf(liveSource({ US_EAST_1_QSTASH_CURRENT_SIGNING_KEY: 'sig_7kYjw48mhY7kAjqNGcy6cr29RJ6r', EU_CENTRAL_1_QSTASH_TOKEN: 'secret-value-1' })),
      ).toEqual([
        'EU_CENTRAL_1_QSTASH_TOKEN: region-prefixed QStash variables are not allowed in live mode; use the QSTASH_* variables',
        'US_EAST_1_QSTASH_CURRENT_SIGNING_KEY: region-prefixed QStash variables are not allowed in live mode; use the QSTASH_* variables',
      ]);
      expect(parseEnv(liveSource({ US_EAST_1_QSTASH_TOKEN: '' })).APP_MODE).toBe('live');
      expect(parseEnv({ APP_MODE: 'fake', QSTASH_REGION: 'US_EAST_1' }).APP_MODE).toBe('fake');
    });

    it('refuses SENTRY_TRACES_SAMPLE_RATE, SENTRY_SPOTLIGHT and SENTRY_DEBUG (errors-only, no sidecar, no SDK debug output)', () => {
      expect(issuesOf(liveSource({ SENTRY_TRACES_SAMPLE_RATE: '0' }))).toContainEqual(
        'SENTRY_TRACES_SAMPLE_RATE: must be unset (Sentry runs errors-only, D-23)',
      );
      expect(issuesOf(liveSource({ SENTRY_SPOTLIGHT: 'true' }))).toEqual([
        'SENTRY_SPOTLIGHT: must be unset in live mode (it forwards every event to a sidecar)',
      ]);
      expect(issuesOf(liveSource({ SENTRY_DEBUG: '1' }))).toEqual(['SENTRY_DEBUG: must be unset in live mode']);
    });

    it('requires https, a redirect URI on APP_URL, the transaction pooler and a UUID client id', () => {
      expect(issuesOf(liveSource({ QSTASH_URL: 'http://qstash.upstash.io' }))).toContainEqual('QSTASH_URL: must use https in live mode');
      expect(issuesOf(liveSource({ SENTRY_DSN: 'http://public@o1.ingest.sentry.io/1' }))).toContainEqual('SENTRY_DSN: must use https in live mode');
      expect(issuesOf(liveSource({ HUBSPOT_REDIRECT_URI: 'https://elsewhere.example.com/api/hubspot/oauth/callback' }))).toContainEqual(
        'HUBSPOT_REDIRECT_URI: must be on the APP_URL origin',
      );
      expect(
        issuesOf(liveSource({ DATABASE_URL: 'postgresql://postgres.ref:pw-test-123@aws-0-eu-central-1.pooler.supabase.com:5432/postgres' })),
      ).toContainEqual('DATABASE_URL: must be the Supabase transaction pooler (port 6543, D-28)');
      expect(issuesOf(liveSource({ HUBSPOT_CLIENT_ID: 'my-client' }))).toContainEqual('HUBSPOT_CLIENT_ID: must be the app client id (a UUID)');
    });

    it('accepts optional Sentry values when well-formed', () => {
      const env = parseEnv(
        liveSource({ SENTRY_DSN: 'https://public@o1.ingest.sentry.io/1', SENTRY_ORG: 'acme', SENTRY_PROJECT: 'autopilot' }),
      );
      expect(env.SENTRY_DSN).toBe('https://public@o1.ingest.sentry.io/1');
    });
  });

  describe('errors', () => {
    it('name every problem and never include a value', () => {
      const secrets = {
        SUPABASE_SECRET_KEY: 'service_role_Hunter2_1',
        RESEND_API_KEY: 'Hunter2_2',
        TOKEN_ENCRYPTION_KEY: 'Hunter2_3',
        CRON_SECRET: 'Hunter2 4',
        ADMIN_EMAILS: 'hunter2-admin-5@example',
        SENTRY_DSN: 'https://Hunter2_6:pw@o1.ingest.sentry.io/1',
      };
      let caught: unknown;
      try {
        parseEnv(liveSource(secrets));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(EnvError);
      const error = caught as EnvError;
      expect(error.code).toBe('env_invalid');
      expect(error.issues).toHaveLength(Object.keys(secrets).length);
      const exposed = JSON.stringify({ message: error.message, issues: error.issues, stack: error.stack });
      for (const value of [...Object.values(secrets), 'service_role', 'Hunter2', 'hunter2']) {
        expect(exposed).not.toContain(value);
      }
      for (const name of Object.keys(secrets)) expect(error.message).toContain(name);
    });
  });

  describe('getEnv()', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('lists every variable from PLAN §14', () => {
      const plan = [
        'APP_MODE', 'ALLOW_FAKE_ON_VERCEL', 'APP_URL', 'PRODUCT_NAME', 'APP_SECRET', 'TOKEN_ENCRYPTION_KEY', 'TOKEN_ENCRYPTION_KEY_PREVIOUS',
        'ADMIN_EMAILS', 'ENV_NAMESPACE', 'COMPOSE_URL_LIMIT', 'COMPOSE_GMAIL_FORM', 'COMPOSE_OUTLOOK_MODE', 'COMPOSE_OUTLOOK_WORK_BASE',
        'COMPOSE_OUTLOOK_PERSONAL_BASE', 'MAX_DRAFTED_LEADS_PER_DAY', 'AI_DAILY_BUDGET_USD', 'FAKE_DB_DIR', 'DATABASE_URL', 'SUPABASE_URL',
        'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'HUBSPOT_CLIENT_ID', 'HUBSPOT_CLIENT_SECRET', 'HUBSPOT_CLIENT_SECRET_PREVIOUS',
        'HUBSPOT_APP_ID', 'HUBSPOT_REDIRECT_URI', 'HUBSPOT_WEBHOOK_TARGET_URL', 'HUBSPOT_API_VERSION', 'HUBSPOT_JOURNAL_ENABLED', 'QSTASH_URL',
        'QSTASH_TOKEN', 'QSTASH_CURRENT_SIGNING_KEY', 'QSTASH_NEXT_SIGNING_KEY', 'QSTASH_MAX_DELAY_SECONDS', 'CRON_SECRET', 'RESEND_API_KEY',
        'EMAIL_FROM', 'EMAIL_REPLY_TO', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL_DRAFT', 'ANTHROPIC_MODEL_FAST', 'ANTHROPIC_DRAFT_THINKING',
        'ANTHROPIC_DRAFT_EFFORT', 'ANTHROPIC_DRAFT_MAX_TOKENS', 'ANTHROPIC_BRIEF_EFFORT', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET',
        'RAZORPAY_WEBHOOK_SECRET', 'RAZORPAY_WEBHOOK_SECRET_PREVIOUS', 'RAZORPAY_PLAN_ID', 'SENTRY_DSN', 'NEXT_PUBLIC_SENTRY_DSN',
        'SENTRY_ORG', 'SENTRY_PROJECT', 'SENTRY_AUTH_TOKEN',
      ];
      expect([...ENV_NAMES].filter((name) => !READ_ONLY.includes(name)).sort()).toEqual(
        [...plan].sort(),
      );
    });

    it('.env.example lists every variable, each with a one-line comment above it', () => {
      const lines = readFileSync(path.join(process.cwd(), '.env.example'), 'utf8').split('\n');
      const listed = new Map<string, number>();
      lines.forEach((line, index) => {
        const match = /^([A-Z0-9_]+)=/.exec(line);
        if (match?.[1] !== undefined) listed.set(match[1], index);
      });
      expect([...listed.keys()].sort()).toEqual(ENV_NAMES.filter((name) => !READ_ONLY.includes(name)).sort());
      for (const [name, index] of listed) {
        expect(lines[index - 1], name).toMatch(/^# \S/);
        // No values except the mode itself.
        expect(lines[index], name).toBe(name === 'APP_MODE' ? 'APP_MODE=fake' : `${name}=`);
      }
    });

    it('is not parsed at import time and throws EnvError when called without APP_MODE', () => {
      vi.stubEnv('APP_MODE', '');
      expect(() => getEnv()).toThrow(EnvError);
    });

    it('memoises the parsed environment', () => {
      vi.stubEnv('APP_MODE', 'fake');
      vi.stubEnv('VERCEL_ENV', '');
      const first = getEnv();
      expect(getEnv()).toBe(first);
    });

    it('re-parses when a variable it reads changes', () => {
      vi.stubEnv('APP_MODE', 'fake');
      vi.stubEnv('VERCEL_ENV', '');
      vi.stubEnv('PRODUCT_NAME', 'First');
      expect(getEnv().PRODUCT_NAME).toBe('First');
      vi.stubEnv('PRODUCT_NAME', 'Second');
      expect(getEnv().PRODUCT_NAME).toBe('Second');
    });
  });
});
