import { Button, Heading, Link, Section, Text } from 'react-email';
import { cardLabel, cardLine, heading, link, notice, note, paragraph, primaryButton, subheading } from './components/styles';
import { Layout } from './Layout';

// The Monday report (brief §5.9, PLAN §9.8, D-17, D-37): short and mobile-first. Presentational only:
// the caller (services/reports) formats every value from the stored metrics. Every label is D-37's,
// below; a value the data cannot support says "Not enough data" (or "Not enough logged history" for
// the baseline) and never an estimate (law 3). The copy rule applies (D-37): an unqualified "reply"
// is the lead's; the owner's is always "your reply" or "reply from you".

export const NOT_ENOUGH_DATA = 'Not enough data';
export const NOT_ENOUGH_LOGGED_HISTORY = 'Not enough logged history';
/** D-37: replaces the waiting list when HubSpot cannot confirm the owner's sends. */
export const SENDS_NOT_CONFIRMABLE = "We can't confirm your sends in HubSpot for your account";

/** D-37's labels, exactly. */
export const WEEKLY_REPORT_LABELS = {
  leadsIn: 'Leads in',
  filtered: 'Filtered (spam etc.)',
  draftsEmailed: 'Drafts emailed to you',
  sendsConfirmed: 'Your sends confirmed in HubSpot',
  sendLinkOpened: 'Send link opened, not confirmed',
  median: 'Median time to your first reply (logged in HubSpot)',
  waiting: 'Leads still waiting for your reply (nothing logged in HubSpot)',
  replies: 'Replies from leads',
  followUps: 'Follow-ups drafted',
  comparison: 'Compared with your baseline',
  percentWithoutReply: '% with no logged reply from you',
} as const;

/**
 * D-37, law 3: sends and replies count only once HubSpot has logged them. (Rows such as "Drafts
 * emailed to you" are Autopilot's own records, so the report never says every count is HubSpot's.)
 */
export const WEEKLY_REPORT_HONESTY_LINE = "Your sends and your leads' replies count only when HubSpot has logged them.";

/** The cohort leads the report's refresh could not read in full (D-77): never claimed as waiting. */
export function uncheckedLeadsLine(count: number): string {
  return count === 1 ? "1 lead couldn't be checked in HubSpot this time." : `${count} leads couldn't be checked in HubSpot this time.`;
}

/** `{PRODUCT_NAME} weekly report: {week label}`. */
export function weeklyReportSubject(productName: string, weekLabel: string): string {
  return `${productName} weekly report: ${weekLabel}`;
}

export interface WeeklyReportRow {
  /** A D-37 label, e.g. "Leads in". */
  label: string;
  /** Already formatted; null shows "Not enough data". */
  value: string | null;
}

export interface WeeklyReportWaitingLead {
  /** e.g. "Lead submitted Tue 6 Oct, 10:05". */
  text: string;
  /** The contact's record in HubSpot; null shows the text without a link. */
  recordUrl: string | null;
}

export type WeeklyReportWaiting =
  | {
      readonly kind: 'list';
      /** The number of leads waiting, formatted. */
      readonly value: string;
      /** At most 20 (D-37). */
      readonly leads: readonly WeeklyReportWaitingLead[];
      /** "and N more". */
      readonly more: number;
    }
  /** Sends can't be confirmed in HubSpot for this account: SENDS_NOT_CONFIRMABLE instead of a list. */
  | { readonly kind: 'unconfirmable' };

export interface WeeklyReportComparisonRow {
  /** A D-37 label. */
  label: string;
  /** The baseline's value, formatted ("Not enough data" when it has none). */
  baseline: string;
  /** This week's value, formatted. */
  thisWeek: string;
}

export type WeeklyReportComparison =
  | { readonly kind: 'rows'; readonly rows: readonly WeeklyReportComparisonRow[] }
  /** No usable baseline: one line, e.g. "Not enough logged history". */
  | { readonly kind: 'unavailable'; readonly text: string };

export interface WeeklyReportProps {
  /** PRODUCT_NAME. */
  productName: string;
  /** e.g. "Mon 5 Oct – Mon 12 Oct". */
  weekLabel: string;
  /** The exact period, e.g. "From Mon 5 Oct, 08:00 to Mon 12 Oct, 08:00 (America/New_York)." */
  periodLine?: string | undefined;
  /** The leads submitted in the period: "Leads in" … "Median time to your first reply (logged in HubSpot)". */
  rows: readonly WeeklyReportRow[];
  waiting?: WeeklyReportWaiting | undefined;
  /** Cohort leads HubSpot didn't let the report read in full this time; 0 or absent shows nothing. */
  unchecked?: number | undefined;
  /** Events in the period: "Replies from leads", "Follow-ups drafted". */
  activity?: readonly WeeklyReportRow[] | undefined;
  comparison?: WeeklyReportComparison | undefined;
  /** `{APP_URL}/dashboard`. */
  dashboardUrl: string;
}

function Row({ row }: { row: WeeklyReportRow }) {
  return (
    <Text style={cardLine}>
      <span style={cardLabel}>{row.label}: </span>
      {row.value ?? NOT_ENOUGH_DATA}
    </Text>
  );
}

function Waiting({ waiting }: { waiting: WeeklyReportWaiting }) {
  if (waiting.kind === 'unconfirmable') {
    return (
      <Text style={cardLine}>
        <span style={cardLabel}>{WEEKLY_REPORT_LABELS.waiting}: </span>
        {SENDS_NOT_CONFIRMABLE}.
      </Text>
    );
  }
  return (
    <>
      <Text style={cardLine}>
        <span style={cardLabel}>{WEEKLY_REPORT_LABELS.waiting}: </span>
        {waiting.value}
      </Text>
      {waiting.leads.some((lead) => lead.recordUrl !== null) ? <Text style={note}>Each link opens the lead&apos;s record in HubSpot.</Text> : null}
      {waiting.leads.map((lead, index) => (
        <Text key={`${index}-${lead.text}`} style={cardLine}>
          {lead.recordUrl === null ? (
            lead.text
          ) : (
            <Link href={lead.recordUrl} style={link}>
              {lead.text}
            </Link>
          )}
        </Text>
      ))}
      {waiting.more > 0 ? <Text style={cardLine}>and {waiting.more} more</Text> : null}
    </>
  );
}

function Comparison({ comparison }: { comparison: WeeklyReportComparison }) {
  return (
    <Section>
      <Heading as="h2" style={subheading}>
        {WEEKLY_REPORT_LABELS.comparison}
      </Heading>
      {comparison.kind === 'unavailable' ? (
        <Text style={cardLine}>{comparison.text}</Text>
      ) : (
        comparison.rows.map((row) => (
          <Section key={row.label}>
            <Text style={cardLine}>
              <span style={cardLabel}>{row.label}</span>
            </Text>
            <Text style={paragraph}>
              Baseline: {row.baseline} · This week: {row.thisWeek}
            </Text>
          </Section>
        ))
      )}
    </Section>
  );
}

export function WeeklyReport({ productName, weekLabel, periodLine, rows, waiting, unchecked, activity, comparison, dashboardUrl }: WeeklyReportProps) {
  return (
    <Layout productName={productName} preview={`Your week in leads: ${weekLabel}.`}>
      <Heading as="h1" style={heading}>
        Your week: {weekLabel}
      </Heading>
      {periodLine === undefined ? null : <Text style={notice}>{periodLine}</Text>}
      <Section>
        <Heading as="h2" style={subheading}>
          Leads that came in
        </Heading>
        {rows.map((row) => (
          <Row key={row.label} row={row} />
        ))}
        {waiting === undefined ? null : <Waiting waiting={waiting} />}
        {unchecked === undefined || unchecked <= 0 ? null : <Text style={note}>{uncheckedLeadsLine(unchecked)}</Text>}
      </Section>
      {activity === undefined || activity.length === 0 ? null : (
        <Section>
          <Heading as="h2" style={subheading}>
            Also this week
          </Heading>
          {activity.map((row) => (
            <Row key={row.label} row={row} />
          ))}
        </Section>
      )}
      {comparison === undefined ? null : <Comparison comparison={comparison} />}
      <Text style={{ ...paragraph, marginTop: '16px' }}>{WEEKLY_REPORT_HONESTY_LINE}</Text>
      <Button href={dashboardUrl} style={primaryButton}>
        Open your dashboard
      </Button>
    </Layout>
  );
}
