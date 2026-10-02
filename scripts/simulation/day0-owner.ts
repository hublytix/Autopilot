// The owner's Day 0 taps (PLAN §13 Day 0 row, D-26, D-39; M4), Tue 2026-10-06 America/New_York:
//   10:12  "Send from my email" on #1's new_lead email; the owner sends, HubSpot logs it at 10:13
//   10:30  the same on #2; the owner never sends it (nothing is logged)
//   10:40  the same on #6; logged at 10:41
// Each tap goes through the real /a/{token}/send handler from a desktop browser (Gmail → 302 to the
// web compose window). It comes well over 60 s after the email was sent, so D-26's heuristic counts
// it as the owner's click (`first_send_clicked_at`). #5 is never tapped on Day 0 (sent on Day 1).
// A logged send is HubSpot's `EMAIL` engagement to the lead with `hs_timestamp` = the send time
// (13 min after #1's submission, 21 min after #6's: the M6 report's reply times).
import { handleSendLink } from '@/server/http/action-links';
import { day0LeadId, day0Submission } from './day0-scenario';
import { DESKTOP_UA, emailActionLinks, OWNER_IP } from './owner-browser';
import type { Simulation } from './types';

export interface Day0OwnerTap {
  /** The submission's number (#1 → `L1`). */
  readonly n: number;
  /** Local time of the tap on "Send from my email". */
  readonly tapAt: string;
  /** Local time the owner's mail app sends it (HubSpot logs it then); null: never sent. */
  readonly sentAt: string | null;
}

export const DAY0_OWNER_TAPS: readonly Day0OwnerTap[] = [
  { n: 1, tapAt: '2026-10-06T10:12:00', sentAt: '2026-10-06T10:13:00' },
  { n: 2, tapAt: '2026-10-06T10:30:00', sentAt: null },
  { n: 6, tapAt: '2026-10-06T10:40:00', sentAt: '2026-10-06T10:41:00' },
];

/** The lead's new_lead email, as the fake mailer accepted it (its `lead` tag is the lead id). */
export async function newLeadEmailOf(sim: Simulation, n: number) {
  const leadId = await day0LeadId(sim, n);
  return leadId === null ? undefined : sim.fakes.mailer.sent.find((mail) => mail.kind === 'new_lead' && mail.lead === leadId);
}

async function tapSend(sim: Simulation, tap: Day0OwnerTap): Promise<void> {
  const { deps } = sim;
  const ref = `L${tap.n}`;
  const mail = await newLeadEmailOf(sim, tap.n);
  const token = mail === undefined ? null : emailActionLinks(mail.text).send;
  let status = 0;
  let host: string | null = null;
  if (token !== null) {
    const response = await handleSendLink(
      new Request(`${deps.env.APP_URL}/a/${token}/send`, { headers: { 'user-agent': DESKTOP_UA, 'x-real-ip': OWNER_IP } }),
      deps,
      token,
    );
    status = response.status;
    const location = response.headers.get('location');
    host = location === null ? null : new URL(location).host;
  }
  sim.check(`day0.${ref}.send_link_opens_gmail_compose`, status === 302 && host === 'mail.google.com', `status ${status}, host ${host ?? 'none'}`);
  sim.record('step', 'new_lead.send_tapped', { lead: ref, httpStatus: status, composeHost: host });
}

async function ownerSends(sim: Simulation, tap: Day0OwnerTap): Promise<void> {
  const ref = `L${tap.n}`;
  // Gmail with BCC logging on: the owner's mailbox logs everything (PLAN §13), HubSpot shows it now.
  const logged = sim.fakes.hubspot.logOwnerSend({ to: day0Submission(tap.n).email, at: sim.clock.now() });
  sim.check(`day0.${ref}.owner_send_logged_in_hubspot`, logged !== null, logged === null ? 'not logged' : 'logged');
  sim.record('step', 'new_lead.reply_sent_by_owner', { lead: ref, loggedInHubSpot: logged !== null });
}

/** Schedules the taps (and the sends that follow them) before Day 0's time travel. */
export function scheduleDay0OwnerActions(sim: Simulation): void {
  for (const tap of DAY0_OWNER_TAPS) {
    sim.travel.at(sim.local(tap.tapAt), `send tap #${tap.n}`, () => tapSend(sim, tap));
    if (tap.sentAt !== null) sim.travel.at(sim.local(tap.sentAt), `owner sends #${tap.n}`, () => ownerSends(sim, tap));
  }
}
