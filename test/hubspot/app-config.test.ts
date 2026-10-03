import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FAKE_ENV } from '@/server/env';
import { ASK_FOR_EMAIL_READ_SCOPE } from '@/server/hubspot/email-scope-switch';
import { HUBSPOT_OAUTH_CALLBACK_PATH, HUBSPOT_WEBHOOK_PATH, REQUIRED_SCOPES, requiredScopesFor } from '@/server/hubspot/scopes';

// D-02, D-03, D-06: the HubSpot app config committed in hubspot-app/ must agree with the code.
// HubSpot blocks an install whose scope set differs from the app's, and signs webhooks over the exact
// target URL, so drift between these files and the constants breaks install or every delivery.

const root = process.cwd();
const readJson = (relative: string): unknown => JSON.parse(readFileSync(path.join(root, 'hubspot-app', relative), 'utf8'));

const projectSchema = z.object({ name: z.string(), srcDir: z.string(), platformVersion: z.string() });
const appSchema = z.object({
  uid: z.string(),
  type: z.literal('app'),
  config: z.object({
    distribution: z.string(),
    auth: z.object({
      type: z.string(),
      redirectUrls: z.array(z.string()),
      requiredScopes: z.array(z.string()),
      optionalScopes: z.array(z.string()),
      conditionallyRequiredScopes: z.array(z.string()),
    }),
  }),
});
const webhooksSchema = z.object({
  uid: z.string(),
  type: z.literal('webhooks'),
  config: z.object({
    settings: z.object({ targetUrl: z.string(), maxConcurrentRequests: z.number() }),
    subscriptions: z.object({
      crmObjects: z.array(z.object({ subscriptionType: z.string(), objectType: z.string(), active: z.boolean() })).optional(),
      legacyCrmObjects: z.array(z.object({ subscriptionType: z.string(), active: z.boolean() })).optional(),
      hubEvents: z.array(z.object({ subscriptionType: z.string(), active: z.boolean() })).optional(),
    }),
  }),
});

const project = projectSchema.parse(readJson('hsproject.json'));
const app = appSchema.parse(readJson('src/app/app-hsmeta.json'));
const webhooks = webhooksSchema.parse(readJson('src/app/webhooks/webhooks-hsmeta.json'));

describe('hubspot-app project', () => {
  it('is a 2026.09 developer-platform project with its source in src/', () => {
    expect(project).toMatchObject({ srcDir: 'src', platformVersion: '2026.09' });
  });

  it('is a marketplace OAuth app', () => {
    expect(app.config.distribution).toBe('marketplace');
    expect(app.config.auth.type).toBe('oauth');
  });

  it('keeps uids within HubSpot limits', () => {
    for (const uid of [app.uid, webhooks.uid]) expect(uid).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});

describe('REQUIRED_SCOPES', () => {
  it('equals app-hsmeta.json requiredScopes, in order', () => {
    expect(app.config.auth.requiredScopes).toEqual([...REQUIRED_SCOPES]);
  });

  it('is exactly the D-03 set the switch selects (sales-email-read unless D-03 path (b) is switched on)', () => {
    expect(REQUIRED_SCOPES.join(' ')).toBe(
      ASK_FOR_EMAIL_READ_SCOPE ? 'oauth crm.objects.contacts.read forms sales-email-read' : 'oauth crm.objects.contacts.read forms',
    );
    expect(requiredScopesFor(true).join(' ')).toBe('oauth crm.objects.contacts.read forms sales-email-read');
    expect(requiredScopesFor(false).join(' ')).toBe('oauth crm.objects.contacts.read forms');
  });

  it('asks for nothing optional or conditional, and no write scope (law 2)', () => {
    expect(app.config.auth.optionalScopes).toEqual([]);
    expect(app.config.auth.conditionallyRequiredScopes).toEqual([]);
    for (const scope of app.config.auth.requiredScopes) expect(scope).not.toMatch(/write|delete|import|export|automation/i);
  });
});

describe('redirect URL', () => {
  it('is the HTTPS OAuth callback path HUBSPOT_REDIRECT_URI uses', () => {
    const [first] = app.config.auth.redirectUrls;
    expect(first).toBeDefined();
    const url = new URL(first ?? '');
    expect(url.protocol).toBe('https:');
    expect(url.pathname).toBe(HUBSPOT_OAUTH_CALLBACK_PATH);
    expect(url.search).toBe('');
    expect(new URL(FAKE_ENV.HUBSPOT_REDIRECT_URI).pathname).toBe(HUBSPOT_OAUTH_CALLBACK_PATH);
  });
});

describe('webhooks', () => {
  it('targets the documented path /api/hubspot/webhooks over HTTPS, with no query or trailing slash', () => {
    const target = webhooks.config.settings.targetUrl;
    const url = new URL(target);
    expect(HUBSPOT_WEBHOOK_PATH).toBe('/api/hubspot/webhooks');
    expect(url.protocol).toBe('https:');
    expect(url.pathname).toBe(HUBSPOT_WEBHOOK_PATH);
    expect(url.search).toBe('');
    expect(target.endsWith('/')).toBe(false);
    expect(new URL(FAKE_ENV.HUBSPOT_WEBHOOK_TARGET_URL).pathname).toBe(HUBSPOT_WEBHOOK_PATH);
  });

  it('uses the same host as the redirect URL', () => {
    expect(new URL(webhooks.config.settings.targetUrl).host).toBe(new URL(app.config.auth.redirectUrls[0] ?? '').host);
  });

  it('subscribes to contact creation and privacy deletion only (D-06)', () => {
    const { crmObjects = [], legacyCrmObjects = [], hubEvents = [] } = webhooks.config.subscriptions;
    expect(crmObjects).toEqual([{ subscriptionType: 'object.creation', objectType: 'contact', active: true }]);
    expect(legacyCrmObjects).toEqual([]);
    expect(hubEvents).toEqual([{ subscriptionType: 'contact.privacyDeletion', active: true }]);
  });

  it('sets a concurrency HubSpot accepts (more than five)', () => {
    expect(webhooks.config.settings.maxConcurrentRequests).toBeGreaterThan(5);
    expect(Number.isInteger(webhooks.config.settings.maxConcurrentRequests)).toBe(true);
  });
});
