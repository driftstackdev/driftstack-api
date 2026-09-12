// OsReadout (owner item 11) — the exit's passive TCP/IP OS fingerprint for a
// running session, shown in the simulator cockpit's Egress panel beside the exit
// identity and the HTTP/3 verdict.
//
// Reads the session's `capabilityReport` (os_fingerprint), which the CONTROL
// PLANE measures once per proxy (the /:id/test SYN fingerprint), persists on the
// proxy row, and projects onto the report at serve time as the {os, confidence}
// subset. It never fetches — it reads the report the cockpit already holds.
//
// ⛔ NIL-vs-VALUE. `os_fingerprint` is ABSENT when the report did not carry a
// well-typed one (never measured, or no owned proxy) — absence must NOT read as a
// placeholder OS. So an absent value renders a muted "measuring…", never a coerced
// OS; only a real {os, confidence} shows the observed line. Unlike the green HTTP/3
// verdict, the observed OS is a neutral fact (like the exit IP), so it uses the
// same muted text-white/70 as ExitIpChip rather than a status colour.
import { type JSX } from 'react';

import type { AgentSessionCapabilityReport } from '../lib/agent-session-control';

export function OsReadout({
  report,
}: {
  report: AgentSessionCapabilityReport | null;
}): JSX.Element {
  const fingerprint = report?.os_fingerprint;
  if (fingerprint === undefined) {
    // (o) O4 — this used to read "OS: measuring…", which asserts work in progress.
    // Nothing measures a session's OS fingerprint: `observeOs` has exactly one call
    // site, the customer-initiated proxy Test, and the session report only carries
    // the value that Test stored on the proxy row. So absence is "not measured",
    // never "measuring" — and the hint names the one action that can produce it.
    // A VPN tunnel has no SOCKS5 stack for the control plane to fingerprint, so for
    // an openvpn/wireguard session even that action cannot help; say so instead.
    // NEVER a placeholder OS: absence is "the report did not say".
    const vpn = report?.proxy_kind === 'openvpn' || report?.proxy_kind === 'wireguard';
    return (
      <div
        data-component="sim-os-readout"
        data-state={vpn ? 'not-available' : 'not-measured'}
        title={
          vpn
            ? 'A VPN tunnel has no SOCKS5 stack for the control plane to fingerprint.'
            : 'Not measured yet — run Test on this profile’s proxy (Proxies screen) to fingerprint its stack.'
        }
        className="mt-1 text-[10px] leading-snug text-white/50"
      >
        {vpn ? 'OS: not available for a VPN tunnel' : 'OS: not measured'}
      </div>
    );
  }

  return (
    <div
      data-component="sim-os-readout"
      data-state="observed"
      className="mt-1 text-[10px] leading-snug text-white/70"
    >
      OS: {fingerprint.os} · {fingerprint.confidence}
    </div>
  );
}
