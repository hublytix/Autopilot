import 'server-only';

// The form states the onboarding Server Actions return to their pages (useActionState). Kept out of
// the 'use server' modules, which may export only async functions. Values are the owner's own
// input echoed back so a form with an error keeps what they typed; codes are machine-readable.

export interface FieldIssue {
  /** `company_name`, `faqs.2.a`, `notify_emails.1`, … */
  path: string;
  code: string;
}

export interface GenerateBriefFormState {
  /** Why the request was refused (a BriefRequestRefusal code), or null. */
  error: string | null;
  websiteUrl: string;
}

export interface BriefFormValues {
  company_name: string;
  one_line: string;
  /** One per line. */
  services: string;
  who_we_serve: string;
  tone_style: string;
  tone_note: string;
  sign_off_name: string;
  allow_pricing: boolean;
  /** One per line. */
  never_promise: string;
  faqs: { q: string; a: string }[];
  booking_choice: string;
  booking_link_found: string;
  booking_link_other: string;
}

export interface BriefFormState {
  issues: FieldIssue[];
  values: BriefFormValues | null;
}

export interface PreferencesFormValues {
  mail_client: string;
  gmail_account_email: string;
  notify_emails: string[];
  quiet_start_hour: string;
  quiet_end_hour: string;
  skip_weekends: boolean;
  followups_enabled: boolean;
  bcc_address: string;
  timezone: string;
}

export interface PreferencesFormState {
  issues: FieldIssue[];
  values: PreferencesFormValues | null;
}
