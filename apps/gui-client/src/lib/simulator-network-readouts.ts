// Owner item 9 (2026-09-24): "The UDP, QUIC, Apple badges … they should all
// always show accurate stats." — the Simulator's egress readouts.
//
// The Simulator showed the exit IP, HTTP/3 and the OS for a running session,
// but no UDP line, and no "no HTTP/3" state: a session whose proxy does not
// relay UDP (so HTTP/3 cannot work) read "HTTP/3: not observed", exactly as a
// session nothing had reported on. The profile card and the Proxies grid show
// both. These derive the Simulator's two lines from the session's report in the
// same states and the same words those surfaces use for the same reading: the
// card's chip texts, and the grid's own sentences (`proxyCapabilities`, the one
// source of those hints), so the three cannot drift apart.

import type { AgentSessionCapabilityReport } from './agent-session-control';
import type { ProxyTestResult } from './proxies';
import { VPN_UDP_NOT_MEASURED_TITLE } from './proxy-check-copy';
import { proxyCapabilities } from '../components/ProxyCapabilities';
import { READING_MARK, READING_WORD, badgeText, badgeWithDetail } from './reading-badge-words';

/** The UDP line's states: measured and works / measured and does not /
 *  not measured (nothing reported, or a VPN, where UDP rides the tunnel). */
export type UdpReadoutState = 'measured' | 'failed' | 'not-measured';

export interface UdpReadout {
  state: UdpReadoutState;
  text: string;
  title: string;
}

/** A proxy test that carries traffic, with the UDP answer the session reported —
 *  the input the grid's sentences are written for. */
function carrying(udp: boolean): ProxyTestResult {
  return {
    reachable: true,
    auth_ok: true,
    udp_associate: udp,
    can_route: true,
    connect_reply: 0,
    latency_ms: 0,
    message: '',
  };
}

function gridHint(udp: boolean, key: 'webrtc' | 'quic'): string {
  return proxyCapabilities(carrying(udp)).find((c) => c.key === key)?.hint ?? '';
}

export const UDP_NOT_MEASURED_TITLE =
  'UDP not measured yet — the phone reports it once the session is running.';

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
  const udp = report?.proxy_udp_supported;
  if (udp === true)
    return {
      state: 'measured',
      text: badgeText(READING_MARK.works, READING_WORD.udp),
      title: gridHint(true, 'webrtc'),
    };
  if (udp === false)
    return {
      state: 'failed',
      text: badgeText(READING_MARK.fallsBack, READING_WORD.udp),
      title: gridHint(false, 'webrtc'),
    };
  return {
    state: 'not-measured',
    text: badgeText(READING_MARK.notMeasured, READING_WORD.udp),
    title: UDP_NOT_MEASURED_TITLE,
  };
}

/**
 * The measured "no HTTP/3" for a session, or null. Only when nothing has been
 * observed over HTTP/3 (a real connection outranks both): the egress does not
 * relay UDP, so HTTP/3 cannot work (the grid's own sentence); or the session
 * runs HTTP/2 only.
 */
export function noHttp3Reason(report: AgentSessionCapabilityReport | null): string | null {
  if (report === null || report.h3_connection_observed === true) return null;
  const vpn = report.proxy_kind === 'openvpn' || report.proxy_kind === 'wireguard';
  if (!vpn && report.proxy_udp_supported === false) return gridHint(false, 'quic');
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
