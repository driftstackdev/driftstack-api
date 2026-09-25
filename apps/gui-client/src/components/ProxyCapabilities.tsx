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
// ⛔ A UDP ASSOCIATE GRANT IS NOT A RELAY (proxy-accuracy audit G1). This header
// used to say the probe "establishes that the proxy will relay a UDP datagram";
// it established only that the proxy said yes. A proxy that grants UDP and drops
// every datagram read ✓ UDP and "~ QUIC likely". The native check now sends one
// datagram through the relay and reports `udp_relay`: ✓ only for 'relays', ⤵
// only for the proxy's own refusal ('refused'), and "— UDP" for a relay that
// stayed silent ("not verified" — the check is one DNS query, and an exit that
// blocks only that port reads the same) or a check that did not run.
//
// A relay that answered is NECESSARY for QUIC and nowhere near SUFFICIENT: QUIC
// additionally needs sustained bidirectional UDP on :443 with datagrams large
// enough for the handshake, and plenty of exits relay UDP while blocking UDP/443
// outright, DPI-ing the QUIC Initial, or fragmenting past its minimum MTU. The
// probe has no QUIC signal, so QUIC is reported as INFERRED ('~') — and only from
// a relay that answered, never from a grant. Same lesson as isProxyUsable: one
// signal must not be quietly restated as a different claim.
//
// proxyCapabilities() is pure + exported for unit tests; the chips component is
// shared by ProxiesView and ProfilesView so the proxy story is identical
// everywhere.

import { isProxyUsable, type ProxyTestResult } from '../lib/proxies';
import { udpRelayOf } from '../lib/udp-relay-verdict';
import type { MeasuredQuic } from '../lib/account-proxies';
import {
  agedOsFingerprintVerdict,
  agedReadingHint,
  osFingerprintVerdict,
  type OsFingerprint,
} from '../lib/os-fingerprint-verdict';
import type { AgedReading, AgedRowReadings } from '../lib/proxy-probe-cache';
import { DETAIL_SEPARATOR, READING_MARK } from '../lib/reading-badge-words';
import { formatRelativeNarrow } from './RelativeTime';

/** Owner item 9 (2026-09-24) — ONE word for the UDP reading on every surface: the
 *  Proxies tab's chip said "WebRTC", the profile card and the list said "UDP",
 *  about the same measurement. It is "UDP" — what the chip measures (the proxy
 *  relays UDP) — and WebRTC, what that makes possible, is in its hover. The
 *  capability KEY stays `webrtc` (a data attribute, not copy). */
export const UDP_LABEL = 'UDP';

/** What a reading nobody has taken says after its word — the OS chip's sentence
 *  ("OS not measured yet. Run Test on this proxy.", os-fingerprint-verdict.ts),
 *  so the three missing readings read as one voice wherever they are listed. */
const NOT_MEASURED_YET_HINT = 'not measured yet. Run Test on this proxy.';

/** G1 — the detail after "— UDP" when the proxy granted UDP and no answer came back. */
export const UDP_NOT_VERIFIED_DETAIL = 'not verified';
/** …and its hover. Not a verdict either way: the check is one small query, and an
 *  exit that blocks only that kind of traffic reads the same as a dead relay. */
export const UDP_NOT_VERIFIED_HINT =
  'UDP not verified from this Mac — the proxy accepts UDP, but no answer came back through it when checked. That does not mean UDP fails: some proxies block only the kind of traffic the check sends.';
/** G1/G4 — this Mac's check did not finish its UDP step (the proxy turned away a
 *  second connection, or a check from before this release). Not measured. */
export const UDP_NOT_RUN_HINT =
  'UDP not measured from this Mac — its check did not finish the UDP step.';

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
   * Owner item 9 (2026-09-24) — nothing has measured this capability. Two rows
   * have one: a row this Mac has not tested itself (`serverReadingCapabilities`),
   * where a chip the server's readings do not cover says so ('— UDP') rather
   * than vanishing beside the ones they do; and a proxy that carried nothing on
   * its last test (`proxyCapabilities`), whose UDP, QUIC and HTTP/2 nobody
   * could ask.
   */
  unmeasured?: true;
  /** What a not-measured chip says after its word ("— UDP · not verified"). */
  detail?: string;
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
// (measured as "? iOS/macOS · 5 h ago", 108px, before the OS word became
// "Apple") is wider than the whole column, so "moves to
// the next line" cannot help — unbroken, it lay 10px over the Health column's
// text. There, and only there, it may break (balanced, inside ONE border). The
// rule is scoped to the proxies grid by its `data-component`, not by this class
// alone: the profiles list draws its aged UDP chip with the same string and has
// the room to keep it whole.
export const AGED_CHIP_CLASS =
  'ds-proxy-aged-chip whitespace-nowrap border border-dashed border-surface-divider bg-surface-inset text-ink-muted';
/** Owner item 9 (2026-09-24) — the ONE aged reading that keeps its colour: an OS
 *  reading of Apple, which matches the device however old it is ("if it's a
 *  Apple, it should be green status"). Same dashed, dated chrome as every aged
 *  chip — so it still reads as "when last checked" — in the ready hue. */
export const AGED_MATCH_CHIP_CLASS =
  'ds-proxy-aged-chip whitespace-nowrap border border-dashed border-status-ready/50 bg-status-ready/10 text-status-ready';

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
  // G1 — what UDP does is the RELAY verdict, never the grant (`udp_associate`).
  const relay = udpRelayOf(result);
  const udp = live && relay === 'relays';
  // The one measured NO: the proxy refused UDP.
  const udpRefused = live && relay === 'refused';
  // Granted but silent, or not run: nothing says whether UDP works.
  const udpUnknown = live && !udp && !udpRefused;
  // ⛔ A proxy that carried NOTHING on its last test (unreachable, login refused,
  // every CONNECT refused) gave no UDP answer and no QUIC one: its UDP-associate
  // flag is false because nothing was asked, not because the proxy said no. So
  // both are NOT MEASURED ("— UDP", "— QUIC"), never the "⤵" of a measured
  // fall-back — which is what the list and the card's sheet drew for a down
  // proxy, while the Proxies tab said "not verified" (gui-v0.1.72 review). A QUIC
  // reading Driftstack DID take (`quicMeasured` / `quicProbe`) still wins below.
  const DOWN_HINT = (reading: 'UDP' | 'QUIC' | 'HTTP/2'): string =>
    `${reading} not measured — no traffic got through this proxy on its last test, so nothing could be checked through it.`;
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
            : !live
              ? {
                  key: 'quic',
                  label: 'QUIC',
                  ok: false,
                  inferred: false,
                  unmeasured: true,
                  hint: DOWN_HINT('QUIC'),
                }
              : udpUnknown
                ? {
                    // G1 — never "~ likely" from a grant, and never the ⤵ of "no
                    // UDP" from a relay nobody heard back from.
                    key: 'quic',
                    label: 'QUIC',
                    ok: false,
                    inferred: false,
                    unmeasured: true,
                    hint:
                      relay === 'silent'
                        ? 'QUIC not measured — UDP was not verified from this Mac, so nothing here says whether HTTP/3 works.'
                        : `QUIC ${NOT_MEASURED_YET_HINT}`,
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
  // WHICH fallback the aged reading may stand in for:
  //
  //  • UDP relays → the fallback is the INFERENCE ("QUIC is likely — not yet
  //    tested"), which is a guess, and a dated reading beats a guess. Always.
  //  • UDP does NOT relay → the fallback is "No UDP — HTTP/3 cannot work here",
  //    deduced from the native handshake the sweep keeps current. An aged
  //    NEGATIVE must not replace it: both say the same thing and the current one
  //    says it in the present tense.
  //
  // ⛔ (2026-09-17) …but an aged POSITIVE in that second case is a CONTRADICTION,
  // and hiding it was the defect. Driftstack measured HTTP/3 working through this
  // exit; this Mac cannot open UDP to it now. Replacing that with a flat
  // present-tense "HTTP/3 cannot work here" throws away the stronger, measured
  // evidence in favour of a deduction from a different check — and the customer
  // sees the card say one thing and the grid another about one proxy. The reading
  // is shown, aged like every other aged reading, and the hint says the two checks
  // disagree rather than pretending either one settles it.
  //
  // G1 — and when UDP is NOT KNOWN (granted but silent, or not run) the fallback
  // is "not measured", so a dated reading of either polarity beats it, exactly as
  // it beats the inference.
  const agedStandsIn =
    nothingCurrent && agedQuic !== undefined && (udp || udpUnknown || agedQuic.value);
  if (agedStandsIn && agedQuic !== undefined) {
    quicChip.aged = agedQuic;
    delete quicChip.unmeasured;
    const when = agedReadingHint(agedQuic.atMs, agedHint.nowMs, agedHint.autoRecheck);
    quicChip.hint = !udpRefused
      ? `${when} ${
          agedQuic.value
            ? 'HTTP/3 worked through this exit then.'
            : 'HTTP/3 did not work through this exit then — it fell back to HTTP/2.'
        }`
      : `${when} HTTP/3 worked through this exit then, but the proxy refused UDP from this Mac now — the two checks disagree, so HTTP/3 may fall back to HTTP/2.`;
  }
  return [
    !live
      ? { key: 'webrtc', label: UDP_LABEL, ok: false, unmeasured: true, hint: DOWN_HINT('UDP') }
      : udpUnknown
        ? relay === 'silent'
          ? {
              key: 'webrtc',
              label: UDP_LABEL,
              ok: false,
              unmeasured: true,
              detail: UDP_NOT_VERIFIED_DETAIL,
              hint: UDP_NOT_VERIFIED_HINT,
            }
          : { key: 'webrtc', label: UDP_LABEL, ok: false, unmeasured: true, hint: UDP_NOT_RUN_HINT }
        : {
            key: 'webrtc',
            label: UDP_LABEL,
            ok: udp,
            hint: udp
              ? 'UDP works — WebRTC calls and media stream through this exit.'
              : 'No UDP — WebRTC falls back to a slower, more detectable path.',
          },
    quicChip,
    // gui-v0.1.73 review — HTTP/2 is a reading too, and a proxy that carried
    // nothing had it read "⤵ HTTP/2" beside "— UDP" "— QUIC": the mark of a
    // measured fall-back, for a protocol nothing got through to fall back from.
    // Its hover said "could not be reached or the login failed", which is false
    // for a proxy that logged in and refused every CONNECT. It is the same
    // missing state as its neighbours now, with their sentence.
    live
      ? {
          key: 'http2',
          label: 'HTTP/2',
          ok: true,
          hint: 'Connected and logged in — HTTP/2 works through this exit.',
        }
      : { key: 'http2', label: 'HTTP/2', ok: false, unmeasured: true, hint: DOWN_HINT('HTTP/2') },
  ];
}

/**
 * Owner item 9 (2026-09-24) — the chips of a SOCKS5 row this Mac has NOT tested
 * itself but Driftstack has: a second Mac, a reinstall, the automatic capability
 * check. Its readings are Driftstack's own — UDP through the proxy (`udpProbe`)
 * and QUIC (`quicMeasured` / `quicProbe`) — and until this change the grid drew
 * none of them: the row read "untested" beside a green "✓ iOS/macOS" from the
 * same automatic check ("has not been measured, but QUIC did, or the other way
 * around"). Same chips, same words, same colours as a tested row's, so a reading
 * reads the same whichever machine took it:
 *   • UDP    — `udpProbe`: ✓ / ⤵, aged when old, '—' when nothing measured it;
 *   • QUIC   — the same strongest-evidence order as `proxyCapabilities`; with no
 *              QUIC reading, the inference from Driftstack's UDP reading ('~' when
 *              UDP relays, ⤵ when it does not), and '—' when there is neither.
 * No HTTP/2 chip: that is the native handshake's fact, and nothing here took it.
 */
export function serverReadingCapabilities(
  udpProbe: boolean | undefined,
  quicMeasured: MeasuredQuic | null | undefined,
  quicProbe: boolean | undefined,
  aged?: AgedRowReadings,
  agedHint: { nowMs: number; autoRecheck: boolean } = { nowMs: Date.now(), autoRecheck: false },
): ProxyCapability[] {
  const agedUdp = udpProbe === undefined ? aged?.udpProbe : undefined;
  const udpKnown = udpProbe !== undefined;
  const webrtc: ProxyCapability =
    udpProbe !== undefined
      ? {
          key: 'webrtc',
          label: UDP_LABEL,
          ok: udpProbe,
          hint: udpProbe
            ? 'UDP works through this exit (measured by Driftstack) — WebRTC calls and media stream through it.'
            : 'No UDP through this exit (measured by Driftstack) — WebRTC falls back to a slower, more detectable path.',
        }
      : agedUdp !== undefined
        ? {
            key: 'webrtc',
            label: UDP_LABEL,
            ok: agedUdp.value,
            aged: agedUdp,
            hint: `${agedReadingHint(agedUdp.atMs, agedHint.nowMs, agedHint.autoRecheck)} ${
              agedUdp.value
                ? 'UDP worked through this exit then.'
                : 'UDP did not work through this exit then.'
            }`,
          }
        : {
            key: 'webrtc',
            label: UDP_LABEL,
            ok: false,
            unmeasured: true,
            // gui-v0.1.73 review — the OS chip's own voice ("OS not measured yet.
            // Run Test on this proxy."): the card's details sheet prints all
            // three missing readings one under another.
            hint: `${UDP_LABEL} ${NOT_MEASURED_YET_HINT}`,
          };
  // The QUIC chip: the tested row's own rule over a result that grants exactly
  // what Driftstack measured about UDP — so a relay/live verdict wins, and the
  // fallback is the same inference a tested row draws from its own UDP.
  const synthetic: ProxyTestResult = {
    reachable: true,
    auth_ok: true,
    udp_associate: udpProbe === true,
    // Driftstack's reading as the relay verdict it stands for: a measured true
    // relays, a measured false refused, and no reading is not measured.
    udp_relay: udpProbe === true ? 'relays' : udpProbe === false ? 'refused' : 'not_run',
    can_route: true,
    connect_reply: 0x00,
    latency_ms: 0,
    message: '',
  };
  const quic = proxyCapabilities(synthetic, quicMeasured, quicProbe, aged, agedHint).find(
    (c) => c.key === 'quic',
  ) as ProxyCapability;
  const quicMeasuredNow =
    quicMeasured === 'h3' || quicMeasured === 'h2-only' || quicProbe !== undefined;
  // Neither a QUIC reading nor a UDP one to infer from: say "not measured", never
  // the '⤵' the inference would draw from a UDP grant nobody measured.
  const quicChip: ProxyCapability =
    !quicMeasuredNow && !udpKnown && quic.aged === undefined
      ? {
          key: 'quic',
          label: 'QUIC',
          ok: false,
          unmeasured: true,
          hint: `QUIC ${NOT_MEASURED_YET_HINT}`,
        }
      : quic;
  return [webrtc, quicChip];
}

/** The NEUTRAL chip: a reading nobody took ("— UDP", "— QUIC", "— OS") and the
 *  OS tones that are not a verdict ("? Linux", "… OS"). Every "not measured"
 *  chip in a Proxies network cell wears this one look. */
export const NEUTRAL_CHIP_CLASS = 'bg-surface-inset text-ink-muted';

/**
 * Capability chips. `size` tunes density: 'xs' for the dense card proxy-row,
 * 'sm' for the proxies-tab detail. A fell-back protocol shows a ⤵ glyph + muted
 * styling (not struck-through — it still works, just downgraded).
 */
export function ProxyCapabilityChips({
  result,
  udpProbe,
  quicMeasured,
  quicProbe,
  aged,
  autoRecheck = false,
  nowMs = Date.now(),
  size = 'sm',
}: {
  /** This Mac's own handshake. ABSENT (owner item 9) for a row only Driftstack has
   *  measured: the chips are then Driftstack's readings (`serverReadingCapabilities`). */
  result: ProxyTestResult | undefined;
  /** Driftstack's UDP reading — read ONLY when `result` is absent (a tested row's
   *  WebRTC chip is its own handshake's, exactly as before). */
  udpProbe?: boolean;
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
  const caps =
    result !== undefined
      ? proxyCapabilities(result, quicMeasured, quicProbe, aged, { nowMs, autoRecheck })
      : serverReadingCapabilities(udpProbe, quicMeasured, quicProbe, aged, { nowMs, autoRecheck });
  const text = size === 'xs' ? 'text-[9px]' : 'text-[10px]';
  return (
    <div className="flex flex-wrap items-center gap-1" data-component="proxy-capabilities">
      {caps.map((c) =>
        c.unmeasured === true ? (
          // Owner item 9 — "not measured yet", stated: the '—' every surface uses
          // for it, never a ⤵ that reads as a measured NO.
          // ⛔ gui-v0.1.72 review — and in the SAME chip as the "— OS" beside it
          // (ProxyOsChip's neutral tone). For a day these wore the tab's old
          // "untested" wash (divider/30) while "— OS" kept surface-inset: one
          // state, two looks in one cell, plainly visible in dark. The words
          // are one vocabulary; the chip is one look.
          <span
            key={c.key}
            title={c.hint}
            data-capability={c.key}
            data-ok="unmeasured"
            data-inferred="false"
            className={`inline-flex items-center gap-0.5 rounded-sm px-1 py-px ${text} ${NEUTRAL_CHIP_CLASS}`}
          >
            <span aria-hidden="true">{READING_MARK.notMeasured}</span>
            {c.label}
            {c.detail !== undefined ? `${DETAIL_SEPARATOR}${c.detail}` : ''}
          </span>
        ) : c.aged !== undefined ? (
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
            <span aria-hidden="true">
              {c.aged.value ? READING_MARK.works : READING_MARK.fallsBack}
            </span>
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
            <span aria-hidden="true">
              {c.ok
                ? c.inferred === true
                  ? READING_MARK.likely
                  : READING_MARK.works
                : READING_MARK.fallsBack}
            </span>
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
      ? v.tone === 'match'
        ? AGED_MATCH_CHIP_CLASS
        : AGED_CHIP_CLASS
      : v.tone === 'match'
        ? 'bg-status-ready/15 text-status-ready'
        : v.tone === 'mismatch'
          ? 'bg-status-error/15 text-status-error'
          : NEUTRAL_CHIP_CLASS;
  return (
    <span
      title={v.hint}
      data-component="proxy-os-fingerprint"
      data-os-tone={v.tone}
      {...(v.aged === true ? { 'data-ok': 'aged' } : {})}
      // `whitespace-nowrap` on the AGED chip only. A current "✓ Apple" is short
      // and never wrapped; the aged one ("? Apple · 5 h ago") did, inside its
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
