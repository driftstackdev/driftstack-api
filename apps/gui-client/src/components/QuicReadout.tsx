// QuicReadout (owner item 11) — the live HTTP/3 (QUIC) verdict for a running
// session, shown in the simulator cockpit's Egress panel beside the exit identity.
//
// Reads the session's `capabilityReport` (h3_connection_observed / _count), which
// the fork latches node-side once a real HTTP/3 connection completes this session.
// It never fetches — it reads the report the cockpit already holds.
//
// ⛔ T-27 SEMANTICS. `h3_connection_observed` is LATCHED (`true` once observed,
// answering "ever", not "now") and ABSENT when the report did not say — absence
// must NOT read as "no HTTP/3". So an absent/false value renders a muted
// "measuring…", never a negative verdict; only a real `true` shows the green
// "HTTP/3 ✓". The monotone `_count` (when >1) is surfaced because its rate is the
// liveness the latched boolean cannot carry (W-29).
import { type JSX } from 'react';

import type { AgentSessionCapabilityReport } from '../lib/agent-session-control';

export function QuicReadout({
  report,
}: {
  report: AgentSessionCapabilityReport | null;
}): JSX.Element {
  if (report?.h3_connection_observed !== true) {
    // Not observed yet — the live state until the fork latches an h3 connection.
    // NEVER "no HTTP/3": absence is "the report did not say", not a negative.
    return (
      <div
        data-component="sim-quic-readout"
        data-state="measuring"
        className="mt-1 text-[10px] leading-snug text-white/40"
      >
        HTTP/3: measuring…
      </div>
    );
  }

  const count = report.h3_connection_count;
  return (
    <div
      data-component="sim-quic-readout"
      data-state="observed"
      className="mt-1 text-[10px] leading-snug text-status-ready"
    >
      HTTP/3 ✓ live
      {typeof count === 'number' && count > 1 ? ` · ${count.toString()} connections` : ''}
    </div>
  );
}
