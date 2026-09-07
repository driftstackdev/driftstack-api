/**
 * Structural equality for a session's {@link AgentSessionCapabilityReport}.
 *
 * ⛔ Owner item #12 (T-26/T-27) regression: the simulator's manual-input snapshot
 * only re-renders when its capabilityReport is judged CHANGED. That change-detection
 * used to compare ONLY the original health triple (`manual_input_available`,
 * `streaming_state`, `egress_state`) and ignored the T-26 exit-identity fields and
 * the T-27 live-QUIC fields. So once a session had any capabilityReport, a LATER
 * report that changed ONLY exit_ip / exit_country / exit_timezone /
 * webrtc_candidate_ips / observed_at / h3_connection_observed / h3_connection_count
 * (/ reported_at) was judged "unchanged" and DROPPED — the ExitIpChip and the live
 * QUIC signal never updated in steady state, even after the harness began emitting.
 *
 * This compares EVERY field the parser (`capabilityReportOf` in
 * agent-session-control.ts) can put on the report, so any field the harness moves is
 * treated as a change. `webrtc_candidate_ips` is compared ELEMENT-WISE in the order
 * the parser produces it (a `.filter` over the served array, order-preserving), so a
 * changed or reordered candidate list reads as changed too.
 *
 * Kept OUT of SimulatorWindow.tsx (a ~10k-line file mocked by ~17 suites) so the
 * predicate is unit-testable on its own and no SimulatorWindow export can break those
 * mocks — mirrors lib/url-bar-inflight.ts.
 */
import type { AgentSessionCapabilityReport } from './agent-session-control';

/** Order-sensitive, index-wise string-array equality (the parser preserves the
 *  served order). Two `undefined`s are equal; one present and one absent is not. */
function candidateIpsEqual(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * True iff `a` and `b` describe the SAME capability report. Same reference (or both
 * `null`) short-circuits to true; one `null` and one present is a change. Otherwise
 * every field on {@link AgentSessionCapabilityReport} must match — the health triple,
 * the T-26 exit-identity fields, the T-27 QUIC fields, `reported_at`, and an
 * element-wise `webrtc_candidate_ips`.
 */
export function capabilityReportsEqual(
  a: AgentSessionCapabilityReport | null,
  b: AgentSessionCapabilityReport | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.manual_input_available === b.manual_input_available &&
    a.streaming_state === b.streaming_state &&
    a.egress_state === b.egress_state &&
    a.exit_ip === b.exit_ip &&
    a.exit_country === b.exit_country &&
    a.exit_timezone === b.exit_timezone &&
    a.observed_at === b.observed_at &&
    a.h3_connection_observed === b.h3_connection_observed &&
    a.h3_connection_count === b.h3_connection_count &&
    a.reported_at === b.reported_at &&
    candidateIpsEqual(a.webrtc_candidate_ips, b.webrtc_candidate_ips)
  );
}
