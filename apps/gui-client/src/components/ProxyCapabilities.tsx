// Proxy egress protocol capabilities — the "professional" breakdown of what a
// SOCKS5 exit can actually carry, derived honestly from the native probe
// (reachability / auth / UDP-associate). Founder ask (2026-06-14): replace the
// single "UDP" badge with explicit "Has WebRTC / Has QUIC / …" capability
// indicators.
//
// Derivation: a reachable + authenticated exit carries the TCP stack (TLS,
// HTTP/2). UDP-associate is the gate for the UDP-borne protocols — HTTP/3
// (QUIC) and WebRTC media/candidate gathering. No UDP relay → those downgrade
// (QUIC→h2, WebRTC→TURN-over-TCP), which is slower and more detectable, so we
// show them as "fell back" rather than simply absent.
//
// ⚠️ WebRTC and QUIC are NOT the same claim, and deriving both from
// `udp_associate` alone said they were. Reported: a proxy that relays UDP but
// does not carry HTTP/3 still showed a green ✓ QUIC.
//
// UDP ASSOCIATE is NECESSARY for QUIC and nowhere near SUFFICIENT. The probe
// establishes that the proxy will relay a UDP datagram — which is exactly what
// WebRTC needs, so that chip is a fair verdict. QUIC additionally needs
// sustained bidirectional UDP on :443 with datagrams large enough for the
// handshake, and plenty of exits relay UDP while blocking UDP/443 outright,
// DPI-ing the QUIC Initial, or fragmenting past its minimum MTU.
//
// The probe has no QUIC signal (ProxyTestResult carries reachable / auth_ok /
// udp_associate / can_route / connect_reply / latency_ms), so QUIC cannot be
// verified from here — only inferred. It is therefore reported as INFERRED, a
// third state, rather than as a measurement we did not take. Same lesson as
// isProxyUsable: one signal must not be quietly restated as a different claim.
//
// proxyCapabilities() is pure + exported for unit tests; the chips component is
// shared by ProxiesView and ProfilesView so the proxy story is identical
// everywhere.

import { isProxyUsable, type ProxyTestResult } from '../lib/proxies';

export interface ProxyCapability {
  key: 'webrtc' | 'quic' | 'http2';
  label: string;
  ok: boolean;
  /**
   * True when `ok` is an INFERENCE rather than something the probe measured.
   * Rendered distinctly so a green tick never stands for an untaken measurement.
   */
  inferred?: boolean;
  /** Long-form tooltip explaining what the state means for a session. */
  hint: string;
}

export function proxyCapabilities(result: ProxyTestResult): ProxyCapability[] {
  // Capability chips describe a proxy that can carry traffic. Auth alone is not
  // that: a proxy can authenticate and refuse every CONNECT.
  const live = isProxyUsable(result);
  const udp = live && result.udp_associate;
  return [
    {
      key: 'webrtc',
      label: 'WebRTC',
      ok: udp,
      hint: udp
        ? 'UDP relay verified — WebRTC gathers host/srflx candidates and streams media through this exit.'
        : 'No UDP relay — WebRTC falls back to TURN-over-TCP (slower, more detectable).',
    },
    {
      key: 'quic',
      label: 'QUIC',
      ok: udp,
      // Inferred whenever we are claiming it. With no UDP relay the NEGATIVE is
      // solid — QUIC cannot work without one — so only the positive is a guess.
      inferred: udp,
      hint: udp
        ? 'UDP relay verified, so HTTP/3 is LIKELY — but not tested. Some exits relay UDP yet still block UDP/443, inspect the QUIC handshake, or fragment it. Run a session to confirm.'
        : 'No UDP relay — HTTP/3 cannot work here; it downgrades to HTTP/2 over TCP.',
    },
    {
      key: 'http2',
      label: 'HTTP/2',
      ok: live,
      hint: live
        ? 'Reachable + authenticated — HTTP/2 over TLS works through this exit.'
        : 'Exit unreachable or auth failed — no traffic flows.',
    },
  ];
}

/**
 * Capability chips. `size` tunes density: 'xs' for the dense card proxy-row,
 * 'sm' for the proxies-tab detail. A fell-back protocol shows a ⤵ glyph + muted
 * styling (not struck-through — it still works, just downgraded).
 */
export function ProxyCapabilityChips({
  result,
  size = 'sm',
}: {
  result: ProxyTestResult;
  size?: 'xs' | 'sm';
}): JSX.Element {
  const caps = proxyCapabilities(result);
  const text = size === 'xs' ? 'text-[9px]' : 'text-[10px]';
  return (
    <div className="flex flex-wrap items-center gap-1" data-component="proxy-capabilities">
      {caps.map((c) => (
        <span
          key={c.key}
          title={c.hint}
          data-capability={c.key}
          data-ok={c.ok ? 'true' : 'false'}
          data-inferred={c.inferred === true ? 'true' : 'false'}
          className={`inline-flex items-center gap-0.5 rounded-sm px-1 py-px ${text} ${
            c.ok
              ? c.inferred === true
                ? // Neither green nor struck through: we believe it, we did not
                  // measure it, and a ✓ here would be the false positive.
                  'bg-surface-inset text-ink-secondary'
                : 'bg-status-ready/15 text-status-ready'
              : 'bg-surface-inset text-ink-muted'
          }`}
        >
          <span aria-hidden="true">{c.ok ? (c.inferred === true ? '~' : '✓') : '⤵'}</span>
          {c.label}
        </span>
      ))}
    </div>
  );
}
