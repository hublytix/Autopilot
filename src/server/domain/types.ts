import 'server-only';

// Shared string-literal enums (PLAN §5, DECISIONS). Each enum is an `as const` array (usable with
// `z.enum(...)` and for SQL `check` lists), its union type, and a type guard. Data only: rules that
// use these values live in their own domain modules.

/** Builds a type guard for one of the `as const` arrays below. */
export function isOneOf<const T extends string>(values: readonly T[]): (value: unknown) => value is T {
  const set: ReadonlySet<string> = new Set(values);
  return (value: unknown): value is T => typeof value === 'string' && set.has(value);
}

// ---------------------------------------------------------------------------------------------
// Accounts, connections, billing
// ---------------------------------------------------------------------------------------------

/** `accounts.processing_state`, derived by `computeProcessingState` (PLAN §6.1, D-42, D-48). */
export const ACCOUNT_PROCESSING_STATES = ['onboarding', 'active', 'paused', 'inactive', 'revoked', 'disconnected'] as const;
export type AccountProcessingState = (typeof ACCOUNT_PROCESSING_STATES)[number];
export const isAccountProcessingState = isOneOf(ACCOUNT_PROCESSING_STATES);

/** `hubspot_connections.status`. */
export const CONNECTION_STATUSES = ['active', 'revoked', 'disconnected'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];
export const isConnectionStatus = isOneOf(CONNECTION_STATUSES);

/** `accounts.logging_mode`: how the owner's mailbox logs to HubSpot (D-14). */
export const LOGGING_MODES = ['unknown', 'log_all', 'sends_only', 'none'] as const;
export type LoggingMode = (typeof LOGGING_MODES)[number];
export const isLoggingMode = isOneOf(LOGGING_MODES);

/**
 * `accounts.timezone_source`. PLAN §5 names the column without values; these follow D-12: the IANA
 * zone from HubSpot account details, HubSpot's fixed UTC offset when the zone is not IANA, or the
 * owner's choice when the call fails.
 */
export const TIMEZONE_SOURCES = ['hubspot', 'utc_offset', 'owner'] as const;
export type TimezoneSource = (typeof TIMEZONE_SOURCES)[number];
export const isTimezoneSource = isOneOf(TIMEZONE_SOURCES);

/** The nine Razorpay subscription statuses (RZP-SUB-STATUSES). Razorpay may send others: parse as an open string. */
export const RAZORPAY_SUBSCRIPTION_STATUSES = [
  'created',
  'authenticated',
  'active',
  'pending',
  'halted',
  'cancelled',
  'completed',
  'expired',
  'paused',
] as const;
export type RazorpaySubscriptionStatus = (typeof RAZORPAY_SUBSCRIPTION_STATUSES)[number];
export const isRazorpaySubscriptionStatus = isOneOf(RAZORPAY_SUBSCRIPTION_STATUSES);

/** `subscriptions.status`: Razorpay's nine plus the local `stale` (D-18). */
export const SUBSCRIPTION_STATUSES = [...RAZORPAY_SUBSCRIPTION_STATUSES, 'stale'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
export const isSubscriptionStatus = isOneOf(SUBSCRIPTION_STATUSES);

/** `settings.mail_client` (D-13). */
export const MAIL_CLIENTS = ['gmail', 'outlook_work', 'outlook_personal', 'other'] as const;
export type MailClient = (typeof MAIL_CLIENTS)[number];
export const isMailClient = isOneOf(MAIL_CLIENTS);

/** `login_intents.purpose` (D-22). */
export const LOGIN_INTENT_PURPOSES = ['login', 'onboarding'] as const;
export type LoginIntentPurpose = (typeof LOGIN_INTENT_PURPOSES)[number];
export const isLoginIntentPurpose = isOneOf(LOGIN_INTENT_PURPOSES);

/** The `type` values `POST /auth/confirm` accepts for `verifyOtp` (D-22). */
export const AUTH_OTP_TYPES = ['email', 'magiclink', 'signup'] as const;
export type AuthOtpType = (typeof AUTH_OTP_TYPES)[number];
export const isAuthOtpType = isOneOf(AUTH_OTP_TYPES);

/** `webhook_events.provider`. */
export const WEBHOOK_PROVIDERS = ['hubspot', 'razorpay'] as const;
export type WebhookProvider = (typeof WEBHOOK_PROVIDERS)[number];
export const isWebhookProvider = isOneOf(WEBHOOK_PROVIDERS);

/** Result of `classifyRefreshFailure` (D-11). Each maps to RevokedError / ConfigError / TransientError. */
export const REFRESH_FAILURE_CLASSES = ['revoked', 'config', 'transient'] as const;
export type RefreshFailureClass = (typeof REFRESH_FAILURE_CLASSES)[number];
export const isRefreshFailureClass = isOneOf(REFRESH_FAILURE_CLASSES);

// ---------------------------------------------------------------------------------------------
// Leads, drafts, follow-ups
// ---------------------------------------------------------------------------------------------

/** `leads.processing_state`, the only stored lifecycle field (D-32). */
export const LEAD_PROCESSING_STATES = ['new', 'processing', 'notified', 'filtered', 'deferred', 'failed', 'skipped'] as const;
export type LeadProcessingState = (typeof LEAD_PROCESSING_STATES)[number];
export const isLeadProcessingState = isOneOf(LEAD_PROCESSING_STATES);

/** The status `deriveLeadStatus(lead, now)` shows the owner, in precedence order; never stored (D-32). */
export const LEAD_DISPLAY_STATUSES = [
  'dismissed',
  'replied',
  'filtered',
  'not_processed',
  'no_reply',
  'send_confirmed',
  'send_clicked',
  'drafted',
  'processing',
] as const;
export type LeadDisplayStatus = (typeof LEAD_DISPLAY_STATUSES)[number];
export const isLeadDisplayStatus = isOneOf(LEAD_DISPLAY_STATUSES);

/** Lead classes from the fast model (brief §5.2). Any classification failure becomes `unclear` (D-24). */
export const CLASSIFICATIONS = ['lead', 'spam', 'vendor_pitch', 'job_seeker', 'support_request', 'unclear'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];
export const isClassification = isOneOf(CLASSIFICATIONS);

/** The classes that get a draft; every other class is shown as filtered (brief §5.2). */
export const DRAFTABLE_CLASSIFICATIONS = ['lead', 'unclear'] as const satisfies readonly Classification[];
export type DraftableClassification = (typeof DRAFTABLE_CLASSIFICATIONS)[number];
export const isDraftableClassification = isOneOf(DRAFTABLE_CLASSIFICATIONS);

/** `leads.intake_trigger` (PLAN §9.2, §9.7). */
export const INTAKE_TRIGGERS = ['webhook', 'cron', 'inbox_check'] as const;
export type IntakeTrigger = (typeof INTAKE_TRIGGERS)[number];
export const isIntakeTrigger = isOneOf(INTAKE_TRIGGERS);

/** `leads.stop_reason`: why follow-ups stopped (PLAN §6.2 stop table). */
export const STOP_REASONS = [
  'dismissed',
  'replied',
  'contact_deleted',
  'opted_out',
  'bounced',
  'superseded',
  'privacy_deletion',
  'followups_off',
  'account_inactive',
  'max_followups',
  'test_lead',
] as const;
export type StopReason = (typeof STOP_REASONS)[number];
export const isStopReason = isOneOf(STOP_REASONS);

/** `drafts.kind`. */
export const DRAFT_KINDS = ['initial', 'fu1', 'fu2'] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];
export const isDraftKind = isOneOf(DRAFT_KINDS);

/** `drafts.flags`: a closed enum the model must choose from (D-24). */
export const DRAFT_FLAGS = [
  'asks_pricing',
  'urgent',
  'non_english',
  'missing_info',
  'possible_spam',
  'sensitive_topic',
  'other',
] as const;
export type DraftFlag = (typeof DRAFT_FLAGS)[number];
export const isDraftFlag = isOneOf(DRAFT_FLAGS);

/** Draft validator error codes; stored in `drafts.validation_errors` (PLAN §9.4, D-47). */
export const VALIDATION_ERROR_CODES = [
  'too_long',
  'not_plain_text',
  'placeholder',
  'missing_first_name',
  'missing_booking_link',
  'currency',
  'never_promise',
  'bad_subject',
  'url_not_allowed',
  'contact_not_allowed',
  'addresses_owner',
  'echoes_lead',
] as const;
export type ValidationErrorCode = (typeof VALIDATION_ERROR_CODES)[number];
export const isValidationErrorCode = isOneOf(VALIDATION_ERROR_CODES);

/** `action_tokens.purpose` (D-45, D-46). */
export const ACTION_TOKEN_PURPOSES = ['send', 'edit', 'dismiss', 'verify_notify'] as const;
export type ActionTokenPurpose = (typeof ACTION_TOKEN_PURPOSES)[number];
export const isActionTokenPurpose = isOneOf(ACTION_TOKEN_PURPOSES);

// ---------------------------------------------------------------------------------------------
// Briefs
// ---------------------------------------------------------------------------------------------

/** `brief_versions.source`. */
export const BRIEF_SOURCES = ['generated', 'owner'] as const;
export type BriefSource = (typeof BRIEF_SOURCES)[number];
export const isBriefSource = isOneOf(BRIEF_SOURCES);

/** `briefs.booking_link_choice` (brief §5.3: a link, or an explicit "no booking link"). */
export const BOOKING_LINK_CHOICES = ['unset', 'link', 'none'] as const;
export type BookingLinkChoice = (typeof BOOKING_LINK_CHOICES)[number];
export const isBookingLinkChoice = isOneOf(BOOKING_LINK_CHOICES);

/** `brief_jobs.status`. */
export const BRIEF_JOB_STATUSES = ['queued', 'running', 'done', 'failed'] as const;
export type BriefJobStatus = (typeof BRIEF_JOB_STATUSES)[number];
export const isBriefJobStatus = isOneOf(BRIEF_JOB_STATUSES);

/** Brief `tone.style` (brief §5.3). */
export const TONE_STYLES = ['friendly', 'formal', 'direct'] as const;
export type ToneStyle = (typeof TONE_STYLES)[number];
export const isToneStyle = isOneOf(TONE_STYLES);

// ---------------------------------------------------------------------------------------------
// Jobs and notifications
// ---------------------------------------------------------------------------------------------

/** `scheduled_jobs.kind` (PLAN §8.2). */
export const JOB_KINDS = [
  'portal_poll',
  'lead_process',
  'followup',
  'weekly_report',
  'baseline',
  'brief_generate',
  'inbox_check',
  'privacy_delete',
  'account_daily',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export const isJobKind = isOneOf(JOB_KINDS);

/** `scheduled_jobs.status` (PLAN §8.3). */
export const JOB_STATUSES = ['scheduled', 'running', 'done', 'cancelled', 'skipped', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const isJobStatus = isOneOf(JOB_STATUSES);

/** `notifications_sent.kind`: every owner email goes through `reserveAndSend` (PLAN §8.4). */
export const NOTIFICATION_KINDS = [
  'new_lead',
  'needs_touch',
  'follow_up',
  'reply_detected',
  'inbox_test',
  'weekly_report',
  'reconnect',
  'billing_inactive',
  'magic_link',
  'verify_notify',
  'lead_cap',
  'owner_alert',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export const isNotificationKind = isOneOf(NOTIFICATION_KINDS);

/** `notifications_sent.status`: only `sent` blocks a resend (PLAN §8.4). */
export const NOTIFICATION_STATUSES = ['sending', 'sent', 'failed'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];
export const isNotificationStatus = isOneOf(NOTIFICATION_STATUSES);

/** `weekly_reports.status`. */
export const WEEKLY_REPORT_STATUSES = ['pending', 'sent', 'failed'] as const;
export type WeeklyReportStatus = (typeof WEEKLY_REPORT_STATUSES)[number];
export const isWeeklyReportStatus = isOneOf(WEEKLY_REPORT_STATUSES);

// ---------------------------------------------------------------------------------------------
// Onboarding: inbox check, baseline
// ---------------------------------------------------------------------------------------------

/** The two legs of the inbox-logging check (D-14). */
export const INBOX_LEGS = ['send', 'reply'] as const;
export type InboxLeg = (typeof INBOX_LEGS)[number];
export const isInboxLeg = isOneOf(INBOX_LEGS);

/** `inbox_checks.send_leg` / `reply_leg`. */
export const INBOX_LEG_STATUSES = ['pending', 'passed', 'failed', 'skipped'] as const;
export type InboxLegStatus = (typeof INBOX_LEG_STATUSES)[number];
export const isInboxLegStatus = isOneOf(INBOX_LEG_STATUSES);

/** `inbox_checks.status`. */
export const INBOX_CHECK_STATUSES = ['open', 'closed'] as const;
export type InboxCheckStatus = (typeof INBOX_CHECK_STATUSES)[number];
export const isInboxCheckStatus = isOneOf(INBOX_CHECK_STATUSES);

/** `baselines.status` (D-38). */
export const BASELINE_STATUSES = ['ok', 'insufficient', 'unavailable'] as const;
export type BaselineStatus = (typeof BASELINE_STATUSES)[number];
export const isBaselineStatus = isOneOf(BASELINE_STATUSES);

// ---------------------------------------------------------------------------------------------
// AI calls
// ---------------------------------------------------------------------------------------------

/** How an LLM call failed (D-24); `LlmResult` carries one of these. */
export const LLM_FAILURE_KINDS = ['refusal', 'max_tokens', 'invalid_output', 'transient', 'fatal_config'] as const;
export type LlmFailureKind = (typeof LLM_FAILURE_KINDS)[number];
export const isLlmFailureKind = isOneOf(LLM_FAILURE_KINDS);

/** Anthropic `stop_details.category` on a refusal (AI-REFUSAL-HANDLING); `ai_calls.refusal_category`. */
export const REFUSAL_CATEGORIES = ['cyber', 'bio', 'frontier_llm', 'reasoning_extraction', 'general_harms'] as const;
export type RefusalCategory = (typeof REFUSAL_CATEGORIES)[number];
export const isRefusalCategory = isOneOf(REFUSAL_CATEGORIES);

/** `ai_calls.purpose`. Baseline classification runs in memory but its cost is still recorded (D-38). */
export const AI_CALL_PURPOSES = ['classify', 'baseline_classify', 'brief', 'draft', 'followup'] as const;
export type AiCallPurpose = (typeof AI_CALL_PURPOSES)[number];
export const isAiCallPurpose = isOneOf(AI_CALL_PURPOSES);

/** `ai_calls.outcome`: `ok`, a validator rejection of valid output, or an LLM failure kind. */
export const AI_CALL_OUTCOMES = ['ok', 'validator_fail', ...LLM_FAILURE_KINDS] as const;
export type AiCallOutcome = (typeof AI_CALL_OUTCOMES)[number];
export const isAiCallOutcome = isOneOf(AI_CALL_OUTCOMES);

// ---------------------------------------------------------------------------------------------
// HubSpot values (external; parsed by the HubSpot client)
// ---------------------------------------------------------------------------------------------

/** `hs_email_direction` values (HS-EMAIL-ENDPOINTS-PROPS). EMAIL = sent by the owner; the others are inbound. */
export const EMAIL_DIRECTIONS = ['EMAIL', 'INCOMING_EMAIL', 'FORWARDED_EMAIL'] as const;
export type EmailDirection = (typeof EMAIL_DIRECTIONS)[number];
export const isEmailDirection = isOneOf(EMAIL_DIRECTIONS);

/** `hs_email_status` values. A confirmed send needs the status absent or `SENT` (D-08). */
export const EMAIL_STATUSES = ['BOUNCED', 'FAILED', 'SCHEDULED', 'SENDING', 'SENT'] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];
export const isEmailStatus = isOneOf(EMAIL_STATUSES);

/**
 * The only email properties Autopilot ever requests (D-03, HS-EMAIL-DATA-MINIMISATION). Subjects,
 * bodies, headers and previews are never requested, so they are not representable here.
 */
export const EMAIL_METADATA_PROPERTIES = [
  'hs_timestamp',
  'hs_email_direction',
  'hs_email_status',
  'hs_email_from_email',
  'hs_email_to_email',
] as const;
export type EmailMetadataProperty = (typeof EMAIL_METADATA_PROPERTIES)[number];
export const isEmailMetadataProperty = isOneOf(EMAIL_METADATA_PROPERTIES);

/** The only contact properties Autopilot ever requests (PLAN §9.2 intake, §9.5 follow-up stops). */
export const HUBSPOT_CONTACT_PROPERTIES = [
  'email',
  'firstname',
  'lastname',
  'company',
  'message',
  'hs_additional_emails',
  'hs_email_optout',
  'hs_email_bad_address',
  'hs_email_hard_bounce_reason_enum',
  'hs_sales_email_last_replied',
] as const;
export type HubSpotContactProperty = (typeof HUBSPOT_CONTACT_PROPERTIES)[number];
export const isHubSpotContactProperty = isOneOf(HUBSPOT_CONTACT_PROPERTIES);

/** HubSpot `formType` values (HS-ONBOARD-FORMS-LIST); `selected_forms.form_type`. */
export const HUBSPOT_FORM_TYPES = ['hubspot', 'flow', 'captured', 'blog_comment'] as const;
export type HubSpotFormType = (typeof HUBSPOT_FORM_TYPES)[number];
export const isHubSpotFormType = isOneOf(HUBSPOT_FORM_TYPES);

/** The form types offered for selection in v1; `captured` waits for WIRE_UP check #2 (D-07). */
export const OFFERED_FORM_TYPES = ['hubspot', 'flow'] as const satisfies readonly HubSpotFormType[];
export type OfferedFormType = (typeof OFFERED_FORM_TYPES)[number];
export const isOfferedFormType = isOneOf(OFFERED_FORM_TYPES);

// ---------------------------------------------------------------------------------------------
// Web fetching (brief builder)
// ---------------------------------------------------------------------------------------------

/** Why `WebFetcher.fetch` refused or failed a page (PLAN §10.4); carried by `WebFetchError.code`. */
export const WEB_FETCH_ERROR_CODES = [
  'blocked_by_ssrf',
  'robots_disallowed',
  'too_large',
  'timeout',
  'bad_content_type',
  'http_error',
] as const;
export type WebFetchErrorCode = (typeof WEB_FETCH_ERROR_CODES)[number];
export const isWebFetchErrorCode = isOneOf(WEB_FETCH_ERROR_CODES);
