// Owner item 7 (2026-09-24): "IN a active session i randomly got this; Waiting
// on the phone — it has not reported yet whether it can accept taps -- might
// want to investigate why"
//
// WHAT THE WAIT IS WAITING ON. The phone's "capability report" — the one
// message in which it says whether it accepts taps (`manual_input_available`).
// It travels phone → server over the phone's own control connection; the server
// keeps the latest one IN MEMORY per session and adds it to GET
// /v1/agent-sessions/:id as `capability_report`, or leaves the key out when it
// holds none. The window reads that every 5 s.
//
// WHY IT GOES MISSING MID-SESSION.
//   • The server restarts (a deploy): its in-memory copy is gone, and the phone
//     does not re-send on reconnect — only on its next state change or its
//     periodic refresh, about every five minutes. Every read in between leaves
//     the key out.
//   • The window REPLACED its copy with whatever each read carried, so the first
//     read without the key erased a report the phone had already given — and
//     with it the right to tap: the same flag unlocks remote control. A healthy
//     session read "Waiting on the phone" and went view-only for minutes.
//
// THE APP'S SIDE.
//   • A read that leaves the report out says nothing new about the phone. Keep
//     the phone's last word for this session until it says something else (a new
//     report, including an explicit "no"). Never across a session switch, never
//     past the session's end, and never past a refused key (the control key has
//     expired: nothing about the session can be trusted any more).
//   • When the phone truly has not reported yet, say how long it can take and
//     what to do if it does not come — after a short patience, not at once.

import type { AgentSessionCapabilityReport } from './agent-session-control';

/** The last report the phone gave for a session. */
export interface LastInputReport {
  sessionId: string;
  report: AgentSessionCapabilityReport;
}

/**
 * The report a successful session read should leave in place. `polled` is the
 * report the read carried (undefined when it left the key out).
 */
export function inputReportAfterRead(args: {
  sessionId: string;
  polled: AgentSessionCapabilityReport | undefined;
  terminal: boolean;
  last: LastInputReport | null;
}): AgentSessionCapabilityReport | null {
  if (args.polled !== undefined) return args.polled;
  // An ended session's report is withheld by the server on purpose; the ended
  // copy speaks for it.
  if (args.terminal) return null;
  return args.last !== null && args.last.sessionId === args.sessionId ? args.last.report : null;
}

/** Remember what a read carried (a read that carried nothing changes nothing). */
export function rememberInputReport(
  last: LastInputReport | null,
  sessionId: string,
  polled: AgentSessionCapabilityReport | undefined,
): LastInputReport | null {
  if (polled !== undefined) return { sessionId, report: polled };
  return last !== null && last.sessionId === sessionId ? last : null;
}

/**
 * How long the plain "waiting on the phone" line stands before the window says
 * more. A phone that is only slow reports within seconds of its screen going
 * live; past this, it is waiting for the phone's periodic report.
 */
export const INPUT_REPORT_PATIENCE_MS = 20_000;

/** What the badge says once that patience has run out: how long, and what to do. */
export const MANUAL_INPUT_UNREPORTED_LONG_BADGE =
  'Still waiting on the phone — it can take a few minutes. If taps stay off, end the session and open the profile again.';
