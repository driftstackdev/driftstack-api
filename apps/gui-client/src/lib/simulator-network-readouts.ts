// Owner item 9 (2026-09-24): "The UDP, QUIC, Apple badges … they should all
// always show accurate stats." — the Simulator's egress readouts.
//
// The Simulator showed the exit IP, HTTP/3 and the OS for a running session,
// but no UDP line, and no "no HTTP/3" state: a session whose proxy does not
// relay UDP (so HTTP/3 cannot work) read "HTTP/3: not observed", exactly as a
// session nothing had reported on. The profile card and the Proxies grid show
// both. These derive the Simulator's two lines from the session's report in the
// same vocabulary those surfaces use for the same reading.
//
// ⛔ Proxy-accuracy audit G5 — the report carries no UDP MEASUREMENT for a SOCKS5
// session, only the launch setting the server wrote (`proxy_udp_supported`), so
// the UDP line says "not measured in this session" rather than turning that
// setting into a verdict. The measured states return when the device reports its
// own QUIC-relay reading (D3).

import type { AgentSessionCapabilityReport } from './agent-session-control';
import { VPN_UDP_NOT_MEASURED_TITLE } from './proxy-check-copy';
import { READING_MARK, READING_WORD, badgeText, badgeWithDetail } from './reading-badge-words';

/** The UDP line's states: measured and works / measured and does not /
 *  not measured (nothing reported, or a VPN, where UDP rides the tunnel). */
export type UdpReadoutState = 'measured' | 'failed' | 'not-measured';

export interface UdpReadout {
  state: UdpReadoutState;
  text: string;
  title: string;
}

export const UDP_NOT_MEASURED_TITLE =
  'UDP not measured yet — the phone reports it once the session is running.';

/** The detail after "— UDP" while a session's report carries only its launch
 *  setting for UDP, which is not a measurement of the proxy. */
export const SESSION_UDP_NOT_MEASURED_DETAIL = 'not measured in this session';
/** ⛔ Names only what an HTTP/3 connection proves — UDP both ways on the
 *  session's own path, to the web port. It does not prove that calls and media
 *  (WebRTC, other ports) get through, so the hover never says they do. */
export const SESSION_UDP_MEASURED_BY_HTTP3_TITLE =
  'UDP works in this session — an HTTP/3 connection went through this exit, and HTTP/3 needs UDP both ways.';
export const SESSION_UDP_NOT_MEASURED_TITLE =
  'UDP was not measured in this session. The session asks for UDP through your proxy; whether your proxy relays it has not been checked here.';

export function udpReadout(report: AgentSessionCapabilityReport | null): UdpReadout {
  // A VPN tunnel carries UDP inside it; the phone asserts it rather than
  // measuring it, so this is the card's own "routed through" state and sentence.
  // Owner item 9 (gui-v0.1.72) — the ONE vocabulary (lib/reading-badge-words):
  // the mark first, and "— UDP" for a reading nobody took. This line read
  // "UDP ✓" and "UDP: not measured yet" where the Proxies tab said "✓ UDP" and
  // the list "— UDP"; the sentence is the hover, as everywhere else.
  if (report?.proxy_kind === 'openvpn' || report?.proxy_kind === 'wireguard') {
    return {
      state: 'not-measured',
      text: badgeText(READING_MARK.inTunnel, READING_WORD.udp),
      title: VPN_UDP_NOT_MEASURED_TITLE,
    };
  }
  // The one UDP MEASUREMENT a session's report carries today: an HTTP/3
  // connection completed in THIS session, and QUIC cannot complete without
  // datagrams both ways through the session's own path (proxy-accuracy audit
  // §4.1 — a measured QUIC ✓ on the phone's path is a UDP ✓ on that path).
  if (report?.h3_connection_observed === true)
    return {
      state: 'measured',
      text: badgeText(READING_MARK.works, READING_WORD.udp),
      title: SESSION_UDP_MEASURED_BY_HTTP3_TITLE,
    };
  // ⛔ Proxy-accuracy audit G5 (paths-03) — `proxy_udp_supported` is the
  // DISPATCH CONSTANT: the server writes `udp_associate: true` into every SOCKS5
  // launch config and the phone echoes `descriptor.supportsUDP` back. Nothing
  // sent a datagram. This line read "✓ UDP" in the measured state for every
  // SOCKS5 session, whatever the proxy does with UDP. A config value is never
  // shown as measured, either way: until the report carries a real measurement
  // (the device's QUIC-relay reading, D3), the session's UDP is not measured.
  if (typeof report?.proxy_udp_supported === 'boolean')
    return {
      state: 'not-measured',
      text: badgeWithDetail(
        READING_MARK.notMeasured,
        READING_WORD.udp,
        SESSION_UDP_NOT_MEASURED_DETAIL,
      ),
      title: SESSION_UDP_NOT_MEASURED_TITLE,
    };
  return {
    state: 'not-measured',
    text: badgeText(READING_MARK.notMeasured, READING_WORD.udp),
    title: UDP_NOT_MEASURED_TITLE,
  };
}

/**
 * The "no HTTP/3" for a session, or null. Only when nothing has been observed
 * over HTTP/3 (a real connection outranks it) and the session runs HTTP/2 only.
 */
export function noHttp3Reason(report: AgentSessionCapabilityReport | null): string | null {
  if (report === null || report.h3_connection_observed === true) return null;
  // ⛔ G5 — no branch on `proxy_udp_supported`: it is the launch setting, not a
  // measurement, so it can state no "HTTP/3 cannot work here".
  if (report.transport_mode_active === 'h2-only') {
    return 'HTTP/3 is off for this session — it uses HTTP/2.';
  }
  return null;
}

/** The measured NO in the ONE vocabulary: "⤵ QUIC", with what the session uses
 *  instead as its detail. It read "⤵ HTTP/3 · HTTP/2 only" — the Simulator's own
 *  word for the reading every other surface calls QUIC (gui-v0.1.72). */
export const NO_HTTP3_TEXT = badgeWithDetail(
  READING_MARK.fallsBack,
  READING_WORD.quic,
  'HTTP/2 only',
);
