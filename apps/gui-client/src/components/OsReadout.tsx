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
import {
  OS_FINGERPRINT_TTL_MS,
  isFingerprintConfidence,
  isFingerprintedOs,
  osFingerprintVerdict,
} from '../lib/os-fingerprint-verdict';
import { formatRelativeNarrow } from './RelativeTime';
import {
  DETAIL_SEPARATOR,
  READING_MARK,
  READING_WORD,
  badgeText,
} from '../lib/reading-badge-words';

/** Owner item 9 (gui-v0.1.72) — this line in the ONE vocabulary every surface
 *  shares (lib/reading-badge-words): the badge the Proxies tab, the card and the
 *  list draw for the same reading ("✓ Apple", "✗ Windows", "? Linux", "— OS"),
 *  mark first, and what only this line has room for as its DETAIL — the
 *  confidence and, past the freshness window, the age. It read "OS: ✓ iOS/macOS
 *  · high", "OS: Linux · high" (no mark) and "OS: not measured". */
const OS_NOT_MEASURED = badgeText(READING_MARK.notMeasured, READING_WORD.os);

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
            ? 'The OS reading is not available for VPN connections.'
            : 'Not measured yet — run Test on this profile’s proxy (Proxies screen).'
        }
        className="mt-1 text-[10px] leading-snug text-white/50"
      >
        {OS_NOT_MEASURED}
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
  // ⛔ Owner item 9 (2026-09-24): "And if it's a Apple, it should be green status,
  // which we don't always have". This line printed the raw wire value —
  // `OS: macos-or-ios · high` — in the neutral tint, so the one surface a customer
  // watches during a session was the one that never showed Apple as the match the
  // grid, the card and the list all show. It now reads the SAME verdict those
  // surfaces read (`osFingerprintVerdict`), in the customer's words: an Apple
  // reading is `OS: ✓ iOS/macOS`, green (the HTTP/3 line's own status-ready, which
  // this dark drawer scope clears AA with — see QuicReadout), at any age.
  //
  // A different OS is red ONLY from a vantage that describes the path a website
  // sees — the grid's rule, from the same fields: the report now carries how the
  // reading was taken (`observed_via` and the two vantage flags; an absent flag
  // reads as false). From any other vantage it stays neutral, naming the OS and
  // asserting nothing about it.
  const os = fingerprint.os;
  const confidence = fingerprint.confidence;
  const verdict =
    isFingerprintedOs(os) && isFingerprintConfidence(confidence)
      ? osFingerprintVerdict({
          os,
          confidence,
          reason: '',
          ...(fingerprint.observed_via !== undefined
            ? { observedVia: fingerprint.observed_via }
            : {}),
          ...(fingerprint.single_host_vantage === true ? { singleHostVantage: true } : {}),
          ...(fingerprint.web_port_vantage === true ? { webPortVantage: true } : {}),
        })
      : null;
  const match = verdict?.tone === 'match';
  const mismatch = verdict?.tone === 'mismatch';
  // The badge every other surface draws for this reading — the verdict's own
  // mark and word ('✓ Apple', '✗ Windows', '? Linux', '? OS'), never the wire id.
  // A value this build does not know is read, and undetermined: '? OS'.
  const badge =
    verdict !== null
      ? badgeText(verdict.glyph, verdict.label)
      : badgeText(READING_MARK.undetermined, READING_WORD.os);
  const ageText =
    aged && measuredAt !== undefined
      ? `${DETAIL_SEPARATOR}${formatRelativeNarrow(measuredAt, nowMs)}`
      : '';
  return (
    <div
      data-component="sim-os-readout"
      data-state="observed"
      data-os-tone={match ? 'match' : mismatch ? 'mismatch' : 'unknown'}
      data-age={ageMs === null ? 'undated' : aged ? 'aged' : 'fresh'}
      title={
        aged && measuredAt !== undefined
          ? `Measured ${new Date(measuredAt).toLocaleString()}, when this proxy was last tested. ` +
            `${match ? 'It matches the iOS device. ' : ''}` +
            'Press Test on the Proxies screen for a current reading.'
          : match
            ? 'This proxy presents as Apple (iOS or macOS) — it matches the iOS device. Measured when the proxy was last tested.'
            : mismatch && verdict !== null
              ? verdict.hint
              : 'The operating system this proxy presents to websites, measured when it was last tested.'
      }
      className={`mt-1 text-[10px] leading-snug ${
        match ? 'text-status-ready' : mismatch ? 'text-status-error' : 'text-white/70'
      }`}
    >
      {`${badge}${DETAIL_SEPARATOR}${fingerprint.confidence} confidence`}
      {ageText}
    </div>
  );
}
