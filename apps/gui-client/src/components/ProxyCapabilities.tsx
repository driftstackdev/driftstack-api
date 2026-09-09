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
  /** 'quic-relay' — T-1's SEPARATE probe chip: the fleet Mac's standalone QUIC
   *  handshake through the proxy. Present only when that probe ran. */
  key: 'webrtc' | 'quic' | 'http2' | 'quic-relay';
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
 * ONE QUIC chip, strongest evidence wins (2026-09-09). Previously `quicProbe` got its
 * OWN "QUIC relayed" chip beside the `quicMeasured`/inferred "QUIC" chip; when the relay
 * probe was green and no live session had measured HTTP/3, operators saw a green "QUIC
 * relayed" next to a muted "QUIC" and read them as two contradictory badges. They are
 * not contradictory — relay-capable and live-h3-observed are different strengths of the
 * same claim — so they now collapse into a single verdict.
 * @param quicMeasured T-6 — the QUIC verdict MEASURED in a live session: 'h3' → HTTP/3
 *   verified (green), 'h2-only' → measured NO HTTP/3 (measured negative), null/undefined
 *   → never measured. A live measurement OUTRANKS the relay probe (it's what the browser
 *   actually did).
 * @param quicProbe T-1 — the fleet Mac's standalone QUIC handshake through the proxy
 *   (the server's `quic_ok`): true → the proxy relays QUIC (green), false → it does not
 *   (measured negative), undefined → no relay measurement. It FEEDS the single QUIC chip
 *   below the live measurement; only when NEITHER was measured does the chip fall back to
 *   the UDP inference ('~', never green). WebRTC and HTTP/2 are unchanged.
 */
export function proxyCapabilities(
  result: ProxyTestResult,
  quicMeasured?: MeasuredQuic | null,
  quicProbe?: boolean,
): ProxyCapability[] {
  // Capability chips describe a proxy that can carry traffic. Auth alone is not
  // that: a proxy can authenticate and refuse every CONNECT.
  const live = isProxyUsable(result);
  const udp = live && result.udp_associate;
  // ONE QUIC verdict, strongest evidence first (2026-09-09). A live session's HTTP/3
  // is green; a live session's h2-only is a measured negative; the fleet relay probe
  // true is green / false is a measured negative; and only when NOTHING was measured
  // do we fall back to the UDP inference ('~', never green). Collapsed into a single
  // chip on purpose: a green "QUIC relayed" (relay probe) sitting next to a muted
  // inferred "QUIC" read to operators as two contradictory QUIC badges. A live
  // measurement outranks the relay probe because it is what the browser actually did.
  const quicChip: ProxyCapability =
    quicMeasured === 'h3'
      ? {
          key: 'quic',
          label: 'QUIC',
          ok: true,
          inferred: false,
          hint: 'HTTP/3 verified in a live session through this exit.',
        }
      : quicMeasured === 'h2-only'
        ? {
            key: 'quic',
            label: 'QUIC',
            ok: false,
            inferred: false,
            hint: 'No HTTP/3 — a live session used HTTP/2 over TCP through this exit.',
          }
        : quicProbe === true
          ? {
              key: 'quic',
              label: 'QUIC',
              ok: true,
              inferred: false,
              hint: 'This proxy relays QUIC — measured from a fleet Mac, the kind that runs your profiles. HTTP/3 works through this exit.',
            }
          : quicProbe === false
            ? {
                key: 'quic',
                label: 'QUIC',
                ok: false,
                inferred: false,
                hint: 'This proxy does not relay QUIC — measured from a fleet Mac. HTTP/3 falls back to HTTP/2 over TCP.',
              }
            : {
                key: 'quic',
                label: 'QUIC',
                // Nothing measured → the UDP inference: LIKELY when UDP relays,
                // impossible when it does not. Never green (it's a guess).
                ok: udp,
                inferred: udp,
                hint: udp
                  ? 'UDP relay verified, so HTTP/3 is LIKELY — not tested. Some exits relay UDP yet still block UDP/443 or fragment the QUIC handshake, so run Test (or a session) to confirm.'
                  : 'No UDP relay — HTTP/3 cannot work here; it downgrades to HTTP/2 over TCP.',
              };
  return [
    {
      key: 'webrtc',
      label: 'WebRTC',
      ok: udp,
      hint: udp
        ? 'UDP relay verified — WebRTC gathers host/srflx candidates and streams media through this exit.'
        : 'No UDP relay — WebRTC falls back to TURN-over-TCP (slower, more detectable).',
    },
    quicChip,
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
  quicProbe,
  size = 'sm',
}: {
  result: ProxyTestResult;
  /** T-6 — a measured QUIC verdict promotes the QUIC chip out of the inferred
   *  '~' state: 'h3' → green ✓, 'h2-only' → measured negative; null/undefined
   *  keeps the inferred rendering. */
  quicMeasured?: MeasuredQuic | null;
  /** T-1 — the fleet Mac's QUIC-relay verdict: its OWN chip, never merged into
   *  the QUIC chip above; undefined renders no relay chip. */
  quicProbe?: boolean;
  size?: 'xs' | 'sm';
}): JSX.Element {
  const caps = proxyCapabilities(result, quicMeasured, quicProbe);
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
