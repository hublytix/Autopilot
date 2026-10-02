import 'server-only';

// Server Action bodies for the onboarding pages (PLAN §3 actions/). Pages import each from its own
// 'use server' module; the shared form-state types and FormData parsing live in ./types and ./parse.
export type { BriefFormState, BriefFormValues, FieldIssue, GenerateBriefFormState, PreferencesFormState, PreferencesFormValues } from './types';
export { briefInputFromValues, NOTIFY_EMAIL_FIELDS, parseBriefForm, parsePreferencesForm, preferencesInputFromValues } from './parse';
