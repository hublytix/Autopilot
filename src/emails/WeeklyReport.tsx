import { Button, Heading, Section, Text } from 'react-email';
import { cardLabel, cardLine, heading, paragraph, primaryButton } from './components/styles';
import { Layout } from './Layout';

// The Monday report (brief §5.10, PLAN §9.8, D-17, D-37): a STUB until M6, which computes the metrics
// (cohorts, comparison, honesty rules) and fills the rows. A row without enough data says "Not enough
// data" and never an estimate (law 3). Labels come from D-37 and are passed in by the caller.
// Presentational only.

export const NOT_ENOUGH_DATA = 'Not enough data';

/**
 * D-37, law 3: sends and replies count only once HubSpot has logged them. (Rows such as "Drafts
 * emailed to you" are Autopilot's own records, so the report never says every count is HubSpot's.)
 */
export const WEEKLY_REPORT_HONESTY_LINE = "Your sends and your leads' replies count only when HubSpot has logged them.";

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

export interface WeeklyReportProps {
  /** PRODUCT_NAME. */
  productName: string;
  /** e.g. "Mon 5 Oct – Sun 11 Oct". */
  weekLabel: string;
  rows: readonly WeeklyReportRow[];
  /** `{APP_URL}/dashboard`. */
  dashboardUrl: string;
}

export function WeeklyReport({ productName, weekLabel, rows, dashboardUrl }: WeeklyReportProps) {
  return (
    <Layout productName={productName} preview={`Your week in leads: ${weekLabel}.`}>
      <Heading as="h1" style={heading}>
        Your week: {weekLabel}
      </Heading>
      <Section>
        {rows.map((row) => (
          <Text key={row.label} style={cardLine}>
            <span style={cardLabel}>{row.label}: </span>
            {row.value ?? NOT_ENOUGH_DATA}
          </Text>
        ))}
      </Section>
      <Text style={paragraph}>{WEEKLY_REPORT_HONESTY_LINE}</Text>
      <Button href={dashboardUrl} style={primaryButton}>
        Open your dashboard
      </Button>
    </Layout>
  );
}
