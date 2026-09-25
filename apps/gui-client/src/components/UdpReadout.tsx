// UdpReadout (owner item 9) — does this session's exit relay UDP, shown in the
// Simulator's Egress panel beside the exit IP, HTTP/3 and the OS. WebRTC and
// HTTP/3 both need it, which is what the tooltip says.
//
// Same states and words as the profile card and the Proxies grid for the same
// reading (lib/simulator-network-readouts.ts): 'UDP ✓' in the ready green,
// '⤵ UDP' muted (a fall-back, never red), '⇢ UDP' for a VPN tunnel, and
// 'UDP: not measured yet' until the phone reports. It never fetches — it reads
// the report the window already holds.
import { type JSX } from 'react';

import type { AgentSessionCapabilityReport } from '../lib/agent-session-control';
import { udpReadout } from '../lib/simulator-network-readouts';

export function UdpReadout({
  report,
}: {
  report: AgentSessionCapabilityReport | null;
}): JSX.Element {
  const r = udpReadout(report);
  return (
    <div
      data-component="sim-udp-readout"
      data-state={r.state}
      title={r.title}
      className={`mt-1 text-[10px] leading-snug ${
        r.state === 'measured' ? 'text-status-ready' : 'text-white/50'
      }`}
    >
      {r.text}
    </div>
  );
}
