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
import type { MeasuredQuic } from '../lib/account-proxies';
import { osFingerprintVerdict, type OsFingerprint } from '../lib/os-fingerprint-verdict';

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

/**
 * @param quicMeasured T-6 — the QUIC verdict MEASURED in a live session, when the
 *   control plane observed one: 'h3' → HTTP/3 verified (a real green ✓), 'h2-only'
 *   → measured NO HTTP/3 (a measured negative, not a guess), null/undefined → never
 *   measured, so the QUIC chip falls back to the INFERRED '~' the probe can offer
 *   and NEVER renders green. WebRTC and HTTP/2 are unchanged.
 */
export function proxyCapabilities(
  result: ProxyTestResult,
  quicMeasured?: MeasuredQuic | null,
): ProxyCapability[] {
  // Capability chips describe a proxy that can carry traffic. Auth alone is not
  // that: a proxy can authenticate and refuse every CONNECT.
  const live = isProxyUsable(result);
  const udp = live && result.udp_associate;
  // A measured verdict overrides the inference entirely. 'h3' is the ONLY green;
  // 'h2-only' is a measured negative; anything else means we never measured it.
  const quicIsMeasured = quicMeasured === 'h3' || quicMeasured === 'h2-only';
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
      // Measured: ok is exactly whether HTTP/3 was seen. Unmeasured: fall back to
      // the UDP inference — LIKELY when UDP relays, impossible when it does not.
      ok: quicIsMeasured ? quicMeasured === 'h3' : udp,
      // Inferred ONLY when we did not measure and are claiming the positive. A
      // measured verdict (either way) is not a guess; and with no UDP relay the
      // negative is solid — QUIC cannot work without one.
      inferred: quicIsMeasured ? false : udp,
      hint: quicIsMeasured
        ? quicMeasured === 'h3'
          ? 'HTTP/3 verified in a live session through this exit.'
          : 'No HTTP/3 — measured in a live session. Traffic falls back to HTTP/2 over TCP.'
        : udp
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
  quicMeasured,
  size = 'sm',
}: {
  result: ProxyTestResult;
  /** T-6 — a measured QUIC verdict promotes the QUIC chip out of the inferred
   *  '~' state: 'h3' → green ✓, 'h2-only' → measured negative; null/undefined
   *  keeps the inferred rendering. */
  quicMeasured?: MeasuredQuic | null;
  size?: 'xs' | 'sm';
}): JSX.Element {
  const caps = proxyCapabilities(result, quicMeasured);
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

/**
 * N-2 — the proxy's passive OS fingerprint as a chip. Three tones, and the
 * neutral one is load-bearing: not measured must never look like a pass. The
 * colour rule itself lives in osFingerprintVerdict so the grid and the profile
 * card cannot disagree about what a fingerprint means.
 */
export function ProxyOsChip({
  fingerprint,
  size = 'sm',
}: {
  fingerprint: OsFingerprint | undefined;
  size?: 'xs' | 'sm';
}): JSX.Element {
  const v = osFingerprintVerdict(fingerprint);
  const text = size === 'xs' ? 'text-[9px]' : 'text-[10px]';
  const tone =
    v.tone === 'match'
      ? 'bg-status-ready/15 text-status-ready'
      : v.tone === 'mismatch'
        ? 'bg-status-error/15 text-status-error'
        : 'bg-surface-inset text-ink-muted';
  return (
    <span
      title={v.hint}
      data-component="proxy-os-fingerprint"
      data-verdict={v.tone}
      className={`inline-flex items-center gap-0.5 rounded-sm px-1 py-px ${text} ${tone}`}
    >
      <span aria-hidden="true">{v.glyph}</span>
      {v.label}
    </span>
  );
}
