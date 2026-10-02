import 'server-only';
import { z } from 'zod';
import { EMAIL_DIRECTIONS, EMAIL_STATUSES } from '@/server/domain/types';

// The fake portal's data: the fixture format (test/fixtures/hubspot-portal.json, ISO times) and the
// state format (epoch-ms times, plus OAuth and fault-injection state) that `snapshot()` returns and
// `restore()` accepts. Both are Zod-validated: a persisted snapshot comes back from the database as
// untrusted JSON.

/** HubSpot record ids (portal, app, contact, email) are digit strings. */
const recordId = z.string().regex(/^\d{1,18}$/);
const lowerEmail = z.email().transform((s) => s.toLowerCase());
const isoInstant = z.iso.datetime().transform((s) => Date.parse(s));
const epochMs = z.number().int();

/** How an owner mailbox logs to HubSpot (D-14); `unknown` is Autopilot's own state, not a mailbox mode. */
export const MAILBOX_LOGGING_MODES = ['log_all', 'sends_only', 'none'] as const;
export const mailboxLoggingModeSchema = z.enum(MAILBOX_LOGGING_MODES);
export type MailboxLoggingMode = z.infer<typeof mailboxLoggingModeSchema>;

export const portalInfoSchema = z.object({
  portalId: recordId,
  /** The app id webhook events carry (`appId`). */
  appId: recordId,
  accountType: z.string().min(1),
  /** As HubSpot reports it; may be a non-IANA name (D-12). */
  timeZone: z.string().min(1),
  /** Used when `timeZone` is not IANA; otherwise the offset is computed for the current instant. */
  utcOffsetMilliseconds: z.number().int().optional(),
  uiDomain: z.string().min(1),
  dataHostingLocation: z.string().min(1),
  /** Introspection `hub_domain`: the portal's own website domain. */
  hubDomain: z.string().min(1).nullable(),
  /** Introspection `user`: the installing user's email, and the owner mailbox by default. */
  installerEmail: lowerEmail,
  /** The owner's other address used for the inbox check (simulation only). */
  ownerTestAddress: lowerEmail.optional(),
  grantedScopes: z.array(z.string().min(1)),
});
export type PortalInfo = z.infer<typeof portalInfoSchema>;

export const formFieldSchema = z.object({
  name: z.string().min(1),
  fieldType: z.string().min(1),
  hidden: z.boolean().default(false),
  objectTypeId: z.string().optional(),
});

export const formSchema = z.object({
  /** The form GUID. */
  id: z.string().min(1),
  name: z.string(),
  formType: z.string().min(1),
  archived: z.boolean().default(false),
  fields: z.array(formFieldSchema),
  lifecycleStages: z.array(z.string()).default([]),
  hasSubscriptionConsent: z.boolean().default(false),
  submitButtonText: z.string().optional(),
  pageUrl: z.string().optional(),
  /** HubSpot's `configuration.createNewContactForNewEmail`: false means an unknown email creates no contact. */
  createNewContactForNewEmail: z.boolean().default(true),
});
export type FakeForm = z.infer<typeof formSchema>;

const submissionValueSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
  objectTypeId: z.string().optional(),
});

const contactPropertiesSchema = z.record(z.string(), z.string().nullable());

// ---------------------------------------------------------------------------------------------
// Fixture format
// ---------------------------------------------------------------------------------------------

export const portalFixtureSchema = z.object({
  $comment: z.string().optional(),
  portal: portalInfoSchema,
  mailboxes: z.array(z.object({ email: lowerEmail, loggingMode: mailboxLoggingModeSchema })).default([]),
  forms: z.array(formSchema),
  contacts: z
    .array(
      z.object({
        id: recordId,
        createdAt: isoInstant,
        properties: contactPropertiesSchema.refine((p) => typeof p.email === 'string' && p.email.length > 0, {
          message: 'contact needs an email property',
        }),
      }),
    )
    .default([]),
  submissions: z
    .array(
      z.object({
        formId: z.string().min(1),
        conversionId: z.string().min(1).optional(),
        submittedAt: isoInstant,
        values: z.array(submissionValueSchema),
        pageUrl: z.string().optional(),
      }),
    )
    .default([]),
  emails: z
    .array(
      z.object({
        id: recordId,
        direction: z.enum(EMAIL_DIRECTIONS),
        timestamp: isoInstant,
        status: z.enum(EMAIL_STATUSES).optional(),
        from: lowerEmail,
        to: z.array(lowerEmail),
        contactIds: z.array(recordId),
      }),
    )
    .default([]),
});
export type PortalFixture = z.input<typeof portalFixtureSchema>;

// ---------------------------------------------------------------------------------------------
// State format
// ---------------------------------------------------------------------------------------------

const contactStateSchema = z.object({
  id: recordId,
  properties: contactPropertiesSchema,
  createdAtMs: epochMs,
  /** Before this instant the contact exists but reads 404 (HubSpot's indexing lag after a submission). */
  visibleAtMs: epochMs,
  deletedAtMs: epochMs.nullable(),
  /** Set on both records a merge replaced; their ids resolve to this one. */
  mergedIntoId: recordId.nullable(),
});
export type ContactState = z.infer<typeof contactStateSchema>;

const submissionStateSchema = z.object({
  /** Insertion order: the tie-break for equal `submittedAtMs` and part of the paging cursor. */
  seq: z.number().int().min(1),
  formId: z.string().min(1),
  conversionId: z.string().min(1).nullable(),
  submittedAtMs: epochMs,
  values: z.array(submissionValueSchema),
  pageUrl: z.string().nullable(),
});
export type SubmissionState = z.infer<typeof submissionStateSchema>;

const emailStateSchema = z.object({
  id: recordId,
  direction: z.enum(EMAIL_DIRECTIONS),
  /** `hs_timestamp`. */
  timestampMs: epochMs,
  status: z.string().nullable(),
  fromEmail: z.string().nullable(),
  toEmails: z.array(z.string()),
  contactIds: z.array(recordId),
  /** Before this instant the engagement is not logged yet (invisible to every read). */
  visibleAtMs: epochMs,
});
export type EmailState = z.infer<typeof emailStateSchema>;

export const TRANSIENT_REFRESH_STATUSES = [429, 500, 502, 503, 504] as const;

const refreshModeStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ok') }),
  z.object({ kind: z.literal('revoked'), variant: z.enum(['bad_refresh_token', 'bad_hub']) }),
  z.object({ kind: z.literal('config') }),
  z.object({
    kind: z.literal('transient'),
    remaining: z.number().int().min(1),
    failure: z.union([z.literal('timeout'), ...TRANSIENT_REFRESH_STATUSES.map((s) => z.literal(s))]),
  }),
  z.object({
    kind: z.literal('migration'),
    remaining: z.number().int().min(1),
    retryAfterSeconds: z.number().int().min(0),
  }),
]);
export type RefreshModeState = z.infer<typeof refreshModeStateSchema>;

/** Port operations that take an access token; each can have failures injected. */
export const FAKE_HUBSPOT_API_OPERATIONS = [
  'accountDetails',
  'listForms',
  'listSubmissions',
  'getContact',
  'listContactEmailIds',
  'batchReadEmails',
  'searchEmailsCount',
  'uninstallApp',
] as const;
export type FakeHubSpotApiOperation = (typeof FAKE_HUBSPOT_API_OPERATIONS)[number];

/** Injectable API failures, each with its HubSpot status and the typed error the port documents. */
export const API_FAILURE_KINDS = [
  'rate_limited',
  'daily_limit',
  'locked',
  'migration',
  'server_error',
  'timeout',
  'network',
  'unauthorized',
] as const;
export type ApiFailureKind = (typeof API_FAILURE_KINDS)[number];

const faultStateSchema = z.object({
  operation: z.union([z.enum(FAKE_HUBSPOT_API_OPERATIONS), z.literal('*')]),
  kind: z.enum(API_FAILURE_KINDS),
  remaining: z.number().int().min(1),
  retryAfterSeconds: z.number().int().min(0).nullable(),
});
export type FaultState = z.infer<typeof faultStateSchema>;

export const fakeHubSpotStateSchema = z.object({
  version: z.literal(1),
  portal: portalInfoSchema,
  mailboxes: z.record(z.string(), mailboxLoggingModeSchema),
  forms: z.array(formSchema),
  contacts: z.array(contactStateSchema),
  submissions: z.array(submissionStateSchema),
  emails: z.array(emailStateSchema),
  oauth: z.object({
    installed: z.boolean(),
    authCodes: z.array(
      z.object({ code: z.string(), redirectUri: z.string(), expiresAtMs: epochMs, used: z.boolean() }),
    ),
    refreshTokens: z.array(z.object({ token: z.string(), revoked: z.boolean() })),
    accessTokens: z.array(z.object({ token: z.string(), expiresAtMs: epochMs, revoked: z.boolean() })),
    refreshMode: refreshModeStateSchema,
  }),
  faults: z.array(faultStateSchema),
  settings: z.object({ contactVisibilityDelayMs: z.number().int().min(0) }),
  counters: z.object({
    contact: z.number().int().min(1),
    email: z.number().int().min(1),
    submission: z.number().int().min(1),
    conversion: z.number().int().min(1),
    token: z.number().int().min(1),
    event: z.number().int().min(1),
  }),
});
export type FakeHubSpotState = z.infer<typeof fakeHubSpotStateSchema>;

/** Throws on a malformed snapshot. */
export function parseState(value: unknown): FakeHubSpotState {
  return fakeHubSpotStateSchema.parse(value);
}

function nextId(base: number, ids: readonly string[]): number {
  return Math.max(base, ...ids.map((id) => Number(id) + 1));
}

/** Validates a fixture (shape and cross-references) and builds the initial state: not installed, all modes ok. */
export function stateFromFixture(value: unknown): FakeHubSpotState {
  const fixture = portalFixtureSchema.parse(value);

  const formIds = new Set(fixture.forms.map((f) => f.id));
  if (formIds.size !== fixture.forms.length) throw new Error('fake_hubspot_fixture: duplicate form id');
  const contactIds = new Set(fixture.contacts.map((c) => c.id));
  if (contactIds.size !== fixture.contacts.length) throw new Error('fake_hubspot_fixture: duplicate contact id');
  const primaryEmails = new Set(fixture.contacts.map((c) => c.properties.email?.toLowerCase()));
  if (primaryEmails.size !== fixture.contacts.length) throw new Error('fake_hubspot_fixture: duplicate contact email');
  for (const s of fixture.submissions) {
    if (!formIds.has(s.formId)) throw new Error('fake_hubspot_fixture: submission for an unknown form');
  }
  for (const e of fixture.emails) {
    if (e.contactIds.some((id) => !contactIds.has(id))) throw new Error('fake_hubspot_fixture: email for an unknown contact');
  }

  const mailboxes: Record<string, MailboxLoggingMode> = { [fixture.portal.installerEmail]: 'log_all' };
  for (const m of fixture.mailboxes) mailboxes[m.email] = m.loggingMode;

  return {
    version: 1,
    portal: fixture.portal,
    mailboxes,
    forms: fixture.forms,
    contacts: fixture.contacts.map((c) => ({
      id: c.id,
      properties: { ...c.properties, email: c.properties.email?.toLowerCase() ?? null },
      createdAtMs: c.createdAt,
      visibleAtMs: c.createdAt,
      deletedAtMs: null,
      mergedIntoId: null,
    })),
    submissions: fixture.submissions.map((s, i) => ({
      seq: i + 1,
      formId: s.formId,
      conversionId: s.conversionId ?? null,
      submittedAtMs: s.submittedAt,
      values: s.values,
      pageUrl: s.pageUrl ?? null,
    })),
    emails: fixture.emails.map((e) => ({
      id: e.id,
      direction: e.direction,
      timestampMs: e.timestamp,
      status: e.status ?? null,
      fromEmail: e.from,
      toEmails: e.to,
      contactIds: e.contactIds,
      visibleAtMs: e.timestamp,
    })),
    oauth: { installed: false, authCodes: [], refreshTokens: [], accessTokens: [], refreshMode: { kind: 'ok' } },
    faults: [],
    settings: { contactVisibilityDelayMs: 0 },
    counters: {
      contact: nextId(1001, fixture.contacts.map((c) => c.id)),
      email: nextId(70001, fixture.emails.map((e) => e.id)),
      submission: fixture.submissions.length + 1,
      conversion: 1,
      token: 1,
      event: 4100000001,
    },
  };
}
