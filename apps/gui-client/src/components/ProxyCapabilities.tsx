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
import {
  agedOsFingerprintVerdict,
  agedReadingHint,
  osFingerprintVerdict,
  type OsFingerprint,
} from '../lib/os-fingerprint-verdict';
import type { AgedReading, AgedRowReadings } from '../lib/proxy-probe-cache';
import { formatRelativeNarrow } from './RelativeTime';

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
  /**
   * Set when this chip shows a reading that is NO LONGER CURRENT: what it found
   * (`value`) and when (`atMs`). `ok` / `inferred` beside it still describe the
   * inference the chip would otherwise have shown, and are NOT what is rendered —
   * an aged chip has its own muted, past-tense rendering (`data-ok="aged"`) so it
   * can never be mistaken for a current verdict. Only the QUIC chip can carry one:
   * WebRTC and HTTP/2 come from the native handshake, which has no aged state.
   */
  aged?: AgedReading<boolean>;
}

/**
 * The one aged QUIC reading a row shows, from the two that answer the same
 * question (does HTTP/3 work through this exit): the LATER measurement, whichever
 * kind it is. The fresh chip ranks a live session above the Test's own reading
 * because at the same moment it is the stronger evidence; between two readings
 * that are both hours old, the newer one is simply the better description of the
 * proxy, and a tie keeps the live one.
 */
export function agedQuicReading(
  aged: AgedRowReadings | undefined,
): AgedReading<boolean> | undefined {
  const live: AgedReading<boolean> | undefined =
    aged?.quicMeasured !== undefined
      ? { value: aged.quicMeasured.value === 'h3', atMs: aged.quicMeasured.atMs }
      : undefined;
  const relay = aged?.quicProbe;
  if (live === undefined) return relay;
  if (relay === undefined) return live;
  return relay.atMs > live.atMs ? relay : live;
}

/** The chip text of an aged reading's age — the app's narrow relative style
 *  ('4 h ago', 'yesterday', '2 d ago'), the same words the profile card dates by. */
export function agedChipAge(atMs: number, nowMs: number): string {
  return formatRelativeNarrow(new Date(atMs).toISOString(), nowMs);
}

/** How an aged chip looks: the muted ground of a non-verdict, a dashed outline no
 *  current chip has, and never the green / red of a present-tense claim. */
// `whitespace-nowrap`: an aged chip is one phrase — "✓ QUIC · 5 h ago" — and in
// a narrow Network column it broke between "5 h" and "ago" INSIDE its dashed
// border, which read as two chips. A chip that does not fit moves to the next
// line whole (the row's flex-wrap does that); it never splits.
// `ds-proxy-aged-chip` is the one exception, and it lives in styles/index.css:
// at the MINIMUM window the Network column holds 90px and the longest aged chip
// ("? iOS/macOS · 5 h ago", 108px) is wider than the whole column, so "moves to
// the next line" cannot help — unbroken, it lay 10px over the Health column's
// text. There, and only there, it may break (balanced, inside ONE border). The
// rule is scoped to the proxies grid by its `data-component`, not by this class
// alone: the profiles list draws its aged UDP chip with the same string and has
// the room to keep it whole.
export const AGED_CHIP_CLASS =
  'ds-proxy-aged-chip whitespace-nowrap border border-dashed border-surface-divider bg-surface-inset text-ink-muted';

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
  /** The row's AGED readings. Consulted ONLY where the QUIC chip would otherwise
   *  fall back to the inference — a current verdict of either kind always wins. */
  aged?: AgedRowReadings,
  agedHint: { nowMs: number; autoRecheck: boolean } = { nowMs: Date.now(), autoRecheck: false },
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
            hint: 'No HTTP/3 — a live session fell back to HTTP/2 through this exit.',
          }
        : quicProbe === true
          ? {
              key: 'quic',
              label: 'QUIC',
              ok: true,
              inferred: false,
              hint: 'This proxy carries QUIC — HTTP/3 works through this exit.',
            }
          : quicProbe === false
            ? {
                key: 'quic',
                label: 'QUIC',
                ok: false,
                inferred: false,
                hint: 'This proxy does not carry QUIC — HTTP/3 falls back to HTTP/2.',
              }
            : {
                key: 'quic',
                label: 'QUIC',
                // Nothing measured → the UDP inference: LIKELY when UDP relays,
                // impossible when it does not. Never green (it's a guess).
                ok: udp,
                inferred: udp,
                hint: udp
                  ? 'UDP works, so HTTP/3 is likely — not yet tested. Run Test or a session to confirm.'
                  : 'No UDP — HTTP/3 cannot work here; it falls back to HTTP/2.',
              };
  // The third state: nothing CURRENT was measured, but something was, a while
  // ago. Showing the inference here ("not yet tested — run Test") is what told a
  // customer to test a proxy they had tested that morning.
  const agedQuic = live ? agedQuicReading(aged) : undefined;
  // ⛔ Keyed on the INPUTS, not on `inferred`: the fallback chip is `inferred:
  // false` too when UDP does not relay, so that flag cannot tell "nothing current
  // was measured" from "a current verdict exists".
  const nothingCurrent =
    quicMeasured !== 'h3' && quicMeasured !== 'h2-only' && quicProbe === undefined;
  // ⛔ …and only where the fallback IS the inference (`udp`). With no UDP the
  // fallback chip is not a guess: "No UDP — HTTP/3 cannot work here" is deduced
  // from the native handshake the sweep keeps CURRENT, and a past-tense "✓ QUIC ·
  // 4 h ago" in its place would swap a present-tense negative for an old tick.
  if (nothingCurrent && udp && agedQuic !== undefined) {
    quicChip.aged = agedQuic;
    quicChip.hint = `${agedReadingHint(agedQuic.atMs, agedHint.nowMs, agedHint.autoRecheck)} ${
      agedQuic.value
        ? 'HTTP/3 worked through this exit then.'
        : 'HTTP/3 did not work through this exit then — it fell back to HTTP/2.'
    }`;
  }
  return [
    {
      key: 'webrtc',
      label: 'WebRTC',
      ok: udp,
      hint: udp
        ? 'UDP works — WebRTC calls and media stream through this exit.'
        : 'No UDP — WebRTC falls back to a slower, more detectable path.',
    },
    quicChip,
    {
      key: 'http2',
      label: 'HTTP/2',
      ok: live,
      hint: live
        ? 'Connected and logged in — HTTP/2 works through this exit.'
        : 'The proxy could not be reached or the login failed — no traffic can go through it.',
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
  aged,
  autoRecheck = false,
  nowMs = Date.now(),
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
  /** The row's AGED readings (`ProbeViewState.aged`): shown, muted and dated,
   *  only where no current QUIC verdict exists. Absent = today's rendering. */
  aged?: AgedRowReadings;
  /** Whether the app will re-take an aged reading by itself — it decides the
   *  hover's last sentence. ⛔ Defaults to FALSE, so a caller that does not know
   *  names the button instead of promising a recheck that may never come; the
   *  caller that does know asks `isCapabilityRowCheckable` (proxy-probe-sweeper). */
  autoRecheck?: boolean;
  /** Reference moment for the age, injected by tests. */
  nowMs?: number;
  size?: 'xs' | 'sm';
}): JSX.Element {
  const caps = proxyCapabilities(result, quicMeasured, quicProbe, aged, { nowMs, autoRecheck });
  const text = size === 'xs' ? 'text-[9px]' : 'text-[10px]';
  return (
    <div className="flex flex-wrap items-center gap-1" data-component="proxy-capabilities">
      {caps.map((c) =>
        c.aged !== undefined ? (
          // An AGED reading: past tense, muted, dated. `data-ok="aged"` — never
          // "true" / "false", which every consumer reads as a current verdict.
          <span
            key={c.key}
            title={c.hint}
            data-capability={c.key}
            data-ok="aged"
            data-aged-value={c.aged.value ? 'true' : 'false'}
            data-inferred="false"
            className={`inline-flex items-center gap-0.5 rounded-sm px-1 py-px ${text} ${AGED_CHIP_CLASS}`}
          >
            <span aria-hidden="true">{c.aged.value ? '✓' : '⤵'}</span>
            {c.label} · {agedChipAge(c.aged.atMs, nowMs)}
          </span>
        ) : (
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
        ),
      )}
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
  aged,
  autoRecheck = false,
  size = 'sm',
  nowMs = Date.now(),
}: {
  fingerprint: OsFingerprint | undefined;
  /** The row's AGED OS reading. Rendered ONLY when `fingerprint` is undefined —
   *  a current reading, a cause and the in-flight sentinel all outrank it — and
   *  then muted, in the neutral tone, with its age beside the label. */
  aged?: AgedReading<OsFingerprint>;
  /** See `ProxyCapabilityChips`. */
  autoRecheck?: boolean;
  size?: 'xs' | 'sm';
  /** (p) — reference moment for the hint's age sentence ("Measured by
   *  Driftstack, 10 minutes ago"); injected by tests so the rendered output is
   *  deterministic without freezing the global clock, exactly as OsReadout takes
   *  it. Production passes nothing. */
  nowMs?: number;
}): JSX.Element {
  // (p) — the reading carries its own date (`fp.at`) when its holder knows one:
  // every cached record does, and since this item that includes a reading the
  // SERVER measured on another machine. The verdict appends where it came from
  // and how old it is; a reading with no date says nothing about age.
  const showAged = fingerprint === undefined && aged !== undefined;
  const v = showAged
    ? agedOsFingerprintVerdict(aged.value, aged.atMs, nowMs, autoRecheck)
    : osFingerprintVerdict(fingerprint, nowMs);
  const text = size === 'xs' ? 'text-[9px]' : 'text-[10px]';
  const tone =
    v.aged === true
      ? AGED_CHIP_CLASS
      : v.tone === 'match'
        ? 'bg-status-ready/15 text-status-ready'
        : v.tone === 'mismatch'
          ? 'bg-status-error/15 text-status-error'
          : 'bg-surface-inset text-ink-muted';
  return (
    <span
      title={v.hint}
      data-component="proxy-os-fingerprint"
      data-os-tone={v.tone}
      {...(v.aged === true ? { 'data-ok': 'aged' } : {})}
      // `whitespace-nowrap` on the AGED chip only. A current "✓ iOS/macOS" is short
      // and never wrapped; the aged one ("? iOS/macOS · 5 h ago") did, inside its
      // own dashed box. Scoping it keeps the present-tense chip byte-for-byte what
      // it was before the aged state existed — which a test pins, because "fresh
      // behaviour unchanged" is only a claim until the markup is compared.
      className={`inline-flex items-center gap-0.5 ${v.aged === true ? 'whitespace-nowrap ' : ''}rounded-sm px-1 py-px ${text} ${tone}`}
    >
      <span aria-hidden="true">{v.glyph}</span>
      {v.label}
      {v.aged === true && showAged ? ` · ${agedChipAge(aged.atMs, nowMs)}` : ''}
    </span>
  );
}
