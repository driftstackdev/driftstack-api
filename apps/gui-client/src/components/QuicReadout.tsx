// QuicReadout (owner item 11) — the live HTTP/3 (QUIC) verdict for a running
// session, shown in the simulator cockpit's Egress panel beside the exit identity.
//
// Reads the session's `capabilityReport` (h3_connection_observed / _count), which
// the fork latches node-side once a real HTTP/3 connection completes this session.
// It never fetches — it reads the report the cockpit already holds.
//
// ⛔ T-27 SEMANTICS. `h3_connection_observed` is LATCHED (`true` once observed,
// answering "ever", not "now") and ABSENT when the report did not say — absence
// must NOT read as "no HTTP/3". Three states, decided by `h3ReadoutState`:
//   • observed      — the green "HTTP/3 ✓ live"; the monotone `_count` (when >1)
//                     is surfaced because its rate is the liveness the latched
//                     boolean cannot carry (W-29);
//   • none-yet      — (q) Item 11 residual: a MEASURED `h3_connection_count` of 0
//                     without the flag. The node counted and found none so far;
//                     the store's own contract calls a zero a measurement, and
//                     this readout says so ("none yet (0 connections)") instead
//                     of folding it back into the absent state;
//   • not-observed  — the report carried neither. This used to read "measuring…",
//                     which asserts work in progress that nothing in this repo
//                     can prove (a fork build that never emits the marker reads
//                     "measuring" forever) — the same (o) O4 argument that
//                     renamed the OS readout. It is "not observed": NEVER a
//                     negative verdict, never a claim of activity.
import { type JSX } from 'react';

import type { AgentSessionCapabilityReport } from '../lib/agent-session-control';
import { h3ReadoutState } from '../lib/session-h3-observation';

export function QuicReadout({
  report,
}: {
  report: AgentSessionCapabilityReport | null;
}): JSX.Element {
  const state = h3ReadoutState(report);
  if (state === 'not-observed') {
    return (
      <div
        data-component="sim-quic-readout"
        data-state="not-observed"
        title="The device has not reported an HTTP/3 observation for this session. This is not a verdict about the proxy — it only says nothing was reported."
        className="mt-1 text-[10px] leading-snug text-white/40"
      >
        HTTP/3: not observed
      </div>
    );
  }
  if (state === 'none-yet') {
    return (
      <div
        data-component="sim-quic-readout"
        data-state="none-yet"
        title="The device counted this session's HTTP/3 connections and found none so far. The count rises once a site is reached over HTTP/3 through this egress."
        className="mt-1 text-[10px] leading-snug text-white/40"
      >
        HTTP/3: none yet (0 connections)
      </div>
    );
  }

  const count = report?.h3_connection_count;
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
