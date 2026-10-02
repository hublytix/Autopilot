import 'server-only';
import type { Env } from '@/server/env';
import type { FormSubmission, HubSpotContact } from '@/server/ports';
import { deriveKey, hmacHex } from '@/server/security/keys';

// Mapping one form submission (HS-INTAKE-SUBMISSIONS-API, HS-INTAKE-SUBMISSION-CONTACT-MATCH, D-31):
// - only contact fields count (`objectTypeId` 0-1, or absent): email, firstname, lastname, company,
//   message; values are trimmed and an empty value is missing;
// - a missing value is filled from the same-named contact property (brief §5.2, D-31);
// - `submission_key` = HubSpot's conversionId, else HMAC(K_dedupe, formId|submittedAt ISO|lower(email));
// - the inbox-check skip compares HMAC(K_dedupe, lower(email)) with `inbox_checks.test_address_hmac`
//   (D-14), so the raw address never has to be kept.

const CONTACT_OBJECT_TYPE = '0-1';

/** The lead fields D-31 allows us to store (in `lead_messages` only). */
export interface LeadContent {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  message: string | null;
}

function clean(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function normalizeEmail(value: string | null | undefined): string | null {
  const email = clean(value)?.toLowerCase() ?? null;
  return email !== null && email.includes('@') ? email : null;
}

/** The submitted value of a contact field, or null. */
function submittedValue(submission: FormSubmission, name: string): string | null {
  for (const field of submission.values) {
    if (field.name !== name) continue;
    if (field.objectTypeId !== undefined && field.objectTypeId !== CONTACT_OBJECT_TYPE) continue;
    const value = clean(field.value);
    if (value !== null) return value;
  }
  return null;
}

/** The content as submitted, before any contact fallback. */
export function submissionContent(submission: FormSubmission): LeadContent {
  return {
    email: normalizeEmail(submittedValue(submission, 'email')),
    firstName: submittedValue(submission, 'firstname'),
    lastName: submittedValue(submission, 'lastname'),
    company: submittedValue(submission, 'company'),
    message: submittedValue(submission, 'message'),
  };
}

/** D-31: each missing field falls back to the same-named contact property. */
export function fillFromContact(content: LeadContent, contact: HubSpotContact): LeadContent {
  const property = (name: 'email' | 'firstname' | 'lastname' | 'company' | 'message'): string | null => clean(contact.properties[name]);
  return {
    email: content.email ?? normalizeEmail(property('email')),
    firstName: content.firstName ?? property('firstname'),
    lastName: content.lastName ?? property('lastname'),
    company: content.company ?? property('company'),
    message: content.message ?? property('message'),
  };
}

const dedupeKeys = new WeakMap<Env, Buffer>();

function dedupeKey(env: Env): Buffer {
  let key = dedupeKeys.get(env);
  if (key === undefined) {
    key = deriveKey(env.APP_SECRET, 'dedupe');
    dedupeKeys.set(env, key);
  }
  return key;
}

/**
 * HMAC(K_dedupe, lower(email)) as hex: `inbox_checks.test_address_hmac` is computed with this when
 * the owner enters the test address (D-14), and intake compares submissions against it.
 */
export function emailHmac(env: Env, email: string): string {
  return hmacHex(dedupeKey(env), email.trim().toLowerCase());
}

/** `leads.submission_key` (D-31): conversionId, else HMAC(K_dedupe, formId|submittedAt ISO|lower(email)). */
export function submissionKey(env: Env, formId: string, submission: FormSubmission, email: string | null): string {
  const conversionId = clean(submission.conversionId);
  if (conversionId !== null) return conversionId;
  return hmacHex(dedupeKey(env), `${formId}|${submission.submittedAt.toISOString()}|${email ?? ''}`);
}
