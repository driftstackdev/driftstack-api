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
//
// ⛔⛔ (V-219) AND IT IS A STORED READING, NOT A LIVE ONE. The control plane
// measures this ONCE, when the customer presses Test on the proxy, and persists
// it on the proxy row; nothing re-takes it while a session runs. So the value
// here can be any age at all, and this line rendered it in bare present tense --
// `OS: windows · high` about a session running now, from a measurement that
// could be months old, with nothing on screen able to say so.
//
// The stamp has been on the row since migration 0119 and the projection simply
// did not read it. It does now, and past the shared freshness window the line
// says WHEN: `OS: windows · high · 3 mo ago`. Labelled rather than dropped,
// because unlike the 178px grid chip there is room here to say it, and an old
// reading that admits its age is worth more than no reading at all.
import { type JSX } from 'react';

import type { AgentSessionCapabilityReport } from '../lib/agent-session-control';
import { OS_FINGERPRINT_TTL_MS } from '../lib/os-fingerprint-verdict';
import { formatRelativeNarrow } from './RelativeTime';

export function OsReadout({
  report,
  nowMs = Date.now(),
}: {
  report: AgentSessionCapabilityReport | null;
  /** Reference moment for the age label; injected by tests so the output is
   *  deterministic without freezing the global clock. */
  nowMs?: number;
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
            ? 'A VPN tunnel does not expose a proxy stack to read.'
            : 'Not measured yet — run Test on this profile’s proxy (Proxies screen).'
        }
        className="mt-1 text-[10px] leading-snug text-white/50"
      >
        {vpn ? 'OS: not available for a VPN tunnel' : 'OS: not measured'}
      </div>
    );
  }

  // The age, and the three states it can be in. `at` is optional on the wire: a
  // control plane that predates it sends none, and that build keeps the old
  // undated line rather than blanking a reading it cannot date — a missing stamp
  // is a gap in OUR plumbing, not evidence about the customer's proxy.
  const measuredAt = fingerprint.at;
  const atMs = measuredAt === undefined ? Number.NaN : Date.parse(measuredAt);
  const ageMs = Number.isFinite(atMs) ? nowMs - atMs : null;
  // Inside the window it is simply current, and a `just now` on every session
  // would be noise. Past it the age is the load-bearing part of the sentence.
  // A stamp in the FUTURE (clock skew) reads as current rather than as a
  // negative age — we cannot say it is old, so we do not say anything.
  const aged = ageMs !== null && ageMs >= OS_FINGERPRINT_TTL_MS;
  return (
    <div
      data-component="sim-os-readout"
      data-state="observed"
      data-age={ageMs === null ? 'undated' : aged ? 'aged' : 'fresh'}
      title={
        aged && measuredAt !== undefined
          ? `Measured ${new Date(measuredAt).toLocaleString()}, when this proxy was last tested. ` +
            'Press Test on the Proxies screen for a current reading.'
          : 'The operating system this proxy presents to websites, measured when it was last tested.'
      }
      className="mt-1 text-[10px] leading-snug text-white/70"
    >
      OS: {fingerprint.os} · {fingerprint.confidence}
      {aged && measuredAt !== undefined ? ` · ${formatRelativeNarrow(measuredAt, nowMs)}` : ''}
    </div>
  );
}
