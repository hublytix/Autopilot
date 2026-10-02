import 'server-only';
import { z } from 'zod';

// Zod schemas for every HubSpot response the live client reads (HS-OAUTH-TOKEN-RESPONSE,
// HS-TOKEN-METADATA, HS-ACCOUNT-DETAILS, HS-ONBOARD-FORMS-LIST, HS-INTAKE-SUBMISSIONS-API,
// HS-CONTACT-GET-WITH-EMAILS, HS-EMAIL-BY-CONTACT, HS-EMAIL-ENDPOINTS-PROPS, HS-429-SHAPE).
// Only the fields Autopilot uses are declared; unknown keys are stripped. Fields HubSpot documents as
// optional, or whose shape is unverified, are optional or tolerant, so a harmless change on HubSpot's
// side does not break intake.

/** HubSpot ids arrive as numbers or strings (int64); Autopilot keeps them as strings. */
export const hubSpotIdSchema = z
  .union([z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), z.number().int().nonnegative()])
  .transform((value) => String(value));

/** An integer that may arrive as a JSON number or a digit string. */
const intLike = z.union([z.number().int(), z.string().regex(/^-?\d{1,18}$/).transform(Number)]).pipe(z.number().int());

/** A property value: HubSpot sends strings (or null), but a number or boolean is read as its text. */
const propertyValue = z
  .union([z.string(), z.number(), z.boolean(), z.null()])
  .transform((value) => (value === null ? null : String(value)));

const pagingSchema = z
  .object({ next: z.object({ after: z.string().min(1) }).optional() })
  .optional()
  .nullable();

// ---------------------------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------------------------

/** `AccessTokenResponse`; `refresh_token` is required by the spec but optional here, so a refresh that omits it keeps the old one. */
export const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: intLike.pipe(z.number().int().positive()),
  hub_id: hubSpotIdSchema.optional(),
  scopes: z.array(z.string()).optional(),
});

/** Introspection: `{active:false}` for a revoked token, the token metadata otherwise. */
export const introspectionSchema = z.object({
  active: z.union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')]),
  hub_id: hubSpotIdSchema.optional(),
  app_id: hubSpotIdSchema.optional(),
  user: z.string().nullable().optional(),
  hub_domain: z.string().nullable().optional(),
  scopes: z.array(z.string()).optional(),
  token_use: z.string().optional(),
});

// ---------------------------------------------------------------------------------------------
// Account, forms, submissions
// ---------------------------------------------------------------------------------------------

export const accountDetailsSchema = z.object({
  portalId: hubSpotIdSchema,
  accountType: z.string().min(1),
  timeZone: z.string().min(1),
  utcOffsetMilliseconds: intLike,
  /** A host name only: it is interpolated into record links (D-12). */
  uiDomain: z.string().regex(/^[A-Za-z0-9.-]{1,253}$/),
  dataHostingLocation: z.string().min(1),
});

const formFieldSchema = z.object({
  name: z.string().min(1),
  fieldType: z.string().min(1),
  hidden: z.boolean().optional(),
  objectTypeId: z.string().optional(),
});

/** `HubSpotFormDefinition`, tolerant beyond the fields form selection reads (non-`hubspot` types are undocumented). */
export const formSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  formType: z.string().min(1),
  archived: z.boolean().optional(),
  fieldGroups: z.array(z.object({ fields: z.array(formFieldSchema).optional() })).optional(),
  configuration: z
    .object({ lifecycleStages: z.array(z.object({ value: z.string() })).optional() })
    .optional()
    .nullable(),
  legalConsentOptions: z
    .object({
      communicationsCheckboxes: z.array(z.unknown()).optional(),
      subscriptionTypeIds: z.array(z.unknown()).optional(),
    })
    .optional()
    .nullable(),
  displayOptions: z.object({ submitButtonText: z.string().optional() }).optional().nullable(),
});

export const formsPageSchema = z.object({
  results: z.array(formSchema),
  paging: pagingSchema,
});

export const submissionsPageSchema = z.object({
  results: z.array(
    z.object({
      conversionId: z.string().min(1).nullable().optional(),
      /** Epoch milliseconds. */
      submittedAt: intLike,
      values: z
        .array(
          z.object({
            name: z.string(),
            value: propertyValue.transform((value) => value ?? ''),
            objectTypeId: z.string().nullable().optional(),
          }),
        )
        .optional(),
      pageUrl: z.string().nullable().optional(),
    }),
  ),
  paging: pagingSchema,
});

// ---------------------------------------------------------------------------------------------
// Contacts and emails
// ---------------------------------------------------------------------------------------------

/** `SimplePublicObjectWithAssociations` for a contact GET with `associations=emails`. */
export const contactSchema = z.object({
  id: hubSpotIdSchema,
  properties: z.record(z.string(), propertyValue).optional(),
  associations: z
    .object({
      emails: z
        .object({
          results: z.array(z.object({ id: hubSpotIdSchema })),
          paging: pagingSchema,
        })
        .optional(),
    })
    .optional()
    .nullable(),
});

/**
 * The dated associations endpoint. The v4-style shape is `{toObjectId}` (a number in production
 * responses, a string in the spec: HS-EMAIL-BY-CONTACT); `{id}` is accepted too.
 */
export const associationsPageSchema = z.object({
  results: z.array(
    z.union([
      z.object({ toObjectId: hubSpotIdSchema }).transform((item) => item.toObjectId),
      z.object({ id: hubSpotIdSchema }).transform((item) => item.id),
    ]),
  ),
  paging: pagingSchema,
});

/** `emails/batch/read` (200, or 207 when some ids were not found). */
export const emailsBatchReadSchema = z.object({
  results: z.array(
    z.object({
      id: hubSpotIdSchema,
      properties: z.record(z.string(), propertyValue).optional(),
    }),
  ),
});

/** `emails/search`: only `total` is read (`limit=1`). */
export const searchTotalSchema = z.object({
  total: z.number().int().nonnegative(),
});

/** The generic error body of API calls; every field is optional (HS-HTTP-ERROR-CODES, HS-429-SHAPE). */
export const apiErrorBodySchema = z.object({
  category: z.string().optional().catch(undefined),
  policyName: z.string().optional().catch(undefined),
  message: z.string().optional().catch(undefined),
});

/** The OAuth token endpoint's error body (only `status` is read here; the classifier reads the rest). */
export const oauthErrorBodySchema = z.object({
  status: z.string().optional().catch(undefined),
});
