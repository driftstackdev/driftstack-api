// Latest validated capability report per live AGENT session.
//
// The harness emits capabilityReport on activation and re-emits it whenever
// streamingState or egressState changes. FleetControlRegistry used to accept
// and ignore those frames, leaving view-only input, blank/failed capture, and a
// dead upstream proxy invisible to the GUI. This bounded store is the live read
// side for PublicAgentSession; the ownership-gated relay is the only writer.

import type { CapabilityReport } from '../schemas/harness-control-protocol.js';

export interface SessionCapabilityReport {
  timestamp: string;
  manual_input_available: boolean | null;
  streaming_state: CapabilityReport['streamingState'] | null;
  egress_state: CapabilityReport['egressState'] | null;
  proxy_kind: CapabilityReport['proxyKind'];
  proxy_udp_supported: boolean;
  transport_mode_requested: CapabilityReport['transportModeRequested'];
  transport_mode_active: CapabilityReport['transportModeActive'];
  safeguards_passed: boolean;
  /**
   * T-6 — did this session ACTUALLY carry an HTTP/3 connection?
   *
   * `true` once a real QUIC handshake completed; `null` means NOT OBSERVED and
   * must never be read as "no HTTP/3" — the node reports the field only once it
   * has seen a handshake, so an older build, or a session that simply has not
   * negotiated one yet, both report null. This is the only honest QUIC signal:
   * `transport_mode_active` above is the CONFIGURED mode, and a node's
   * interpose flag merely restates it, so neither can answer "did it carry".
   *
   * Without this field the fact was unobservable from the control plane at all,
   * which made a live verification read ABSENT for a reason that had nothing to
   * do with the device.
   */
  h3_connection_observed: boolean | null;
  /**
   * (o) O2 2026-09-11 — HOW MANY HTTP/3 connections the node has seen on this
   * session. `null` means NOT REPORTED (an older harness, or a node that has not
   * sent one yet) and must never be read as zero.
   *
   * ⛔ IT IS NOT A NICER `h3_connection_observed`. That flag is backed by an
   * insert-only Set on the node and can never return to false, so it is a sound
   * "h3 was reached at least once" claim and an UNSOUND liveness signal: a
   * consumer reading it as current refreshes a verdict on a relay that died an
   * hour ago, and the timestamp looks fresh BECAUSE nothing was checking. The
   * count is monotone, so its RATE carries the liveness the latched boolean
   * cannot — and a rate is unobservable from a boolean, however often you read it.
   *
   * The node has sent it since the schema accepted it; nothing consumed it. The
   * customer-safe projection stripped it, so the desktop readout's `· N
   * connections` branch was unreachable code, and the cockpit could only ever
   * show the latched "ever". This field is the one hop that was missing.
   */
  h3_connection_count: number | null;
  /** T-6 — the interpose image was seen loaded in the node's network process.
   *  INTERNAL diagnostic only (it names an implementation detail, and loaded is
   *  not carried), so it is deliberately NOT in the customer subset below. */
  interpose_image_loaded: boolean | null;
  /**
   * T-26 — the LIVE exit identity this session's traffic leaves through, and the
   * IPs its WebRTC candidates surface. `null` means NOT OBSERVED (a pre-T-26
   * harness, or a session that has not yet reported one) and must never be read
   * as "no exit" — the same absent-until-measured contract as
   * `h3_connection_observed` above. Customer-safe (the customer's own egress),
   * so these ARE in the subset below.
   */
  exit_ip: string | null;
  exit_country: string | null;
  exit_timezone: string | null;
  webrtc_candidate_ips: string[] | null;
  observed_at: string | null;
  /**
   * Per-session streaming degradation counters, when the node reported them.
   *
   * ⛔ `null` means UNKNOWN — the node never sent them (older build, or the
   * `DRIFTSTACK_STREAMING_HEALTH_REPORT` flag is off) — and must never be
   * rendered as healthy. This deliberately does NOT default to an object of
   * zeroes: a zero fps for a session nobody measured reads as a dead stream,
   * and a zero stall count for the same session reads as a clean one. Both are
   * claims from no evidence, which is exactly the `safeguards_passed`-off-an-
   * empty-array defect above.
   */
  streaming_health: NonNullable<CapabilityReport['streamingHealth']> | null;
}

/**
 * The subset of a stored report that may cross to a CUSTOMER.
 *
 * ⛔ AN EXPLICIT ALLOWLIST, NOT A SPREAD. `GET /v1/agent-sessions/:id` used to
 * assign the whole store record to `capability_report`, so every field added
 * here for internal use silently became part of a public API response. That is
 * leak-by-default: the safe case required remembering, and the unsafe case was
 * the one that happened automatically.
 *
 * It happened immediately — adding `streaming_health` for operator diagnosis
 * put eleven harness counters into a customer payload in the same commit, and
 * only a shape test caught it. Adding a field to this function is now a
 * deliberate act with a reviewer.
 */
export type CustomerSafeCapabilityReport = Omit<
  SessionCapabilityReport,
  'streaming_health' | 'interpose_image_loaded'
> & {
  /**
   * N-2 — the customer-safe subset {os, confidence} of the exit proxy's cached
   * passive TCP/IP OS fingerprint. NOT a harness fact: the CONTROL PLANE measures
   * it (proxy /:id/test) and persists it on the proxy row, and the serve path
   * reads it back here. `null` means NOT OBSERVED — never measured, or the session
   * has no owned proxy to read — and must render as "measuring…", never a
   * placeholder OS (the same absent-until-measured contract as exit_ip). The
   * internal diagnostics (reason / observed_ip / observed_via) are deliberately
   * NOT here.
   */
  os_fingerprint: { os: string; confidence: string } | null;
};

export function customerSafeCapabilityReport(
  report: SessionCapabilityReport,
  osFingerprint?: { os: string; confidence: string } | null,
): CustomerSafeCapabilityReport {
  return {
    timestamp: report.timestamp,
    manual_input_available: report.manual_input_available,
    streaming_state: report.streaming_state,
    egress_state: report.egress_state,
    proxy_kind: report.proxy_kind,
    proxy_udp_supported: report.proxy_udp_supported,
    transport_mode_requested: report.transport_mode_requested,
    transport_mode_active: report.transport_mode_active,
    safeguards_passed: report.safeguards_passed,
    // Deliberate addition to the allowlist: this is the customer's honest answer
    // to "does my proxy actually carry HTTP/3", the same class of fact as
    // transport_mode_active beside it. The internal interpose diagnostic is NOT
    // included.
    h3_connection_observed: report.h3_connection_observed,
    // (o) O2 — a DELIBERATE allowlist addition, beside the flag it makes usable.
    // It is the same fact as `h3_connection_observed` at a finer grain — the
    // customer's own session, their own egress — and it carries the liveness the
    // latched boolean structurally cannot. It names no endpoint, identifies no
    // person, and is a small non-negative integer. `null` stays null: NOT
    // REPORTED, never rendered as zero connections.
    h3_connection_count: report.h3_connection_count,
    // T-26 — the live exit identity + WebRTC candidate IPs are the customer's
    // OWN egress facts (T-26 ledger row: live exit IP + WebRTC IP in the
    // simulator), so they cross to the customer. Added deliberately to the
    // allowlist, not spread — the same rule the header states.
    exit_ip: report.exit_ip,
    exit_country: report.exit_country,
    exit_timezone: report.exit_timezone,
    webrtc_candidate_ips: report.webrtc_candidate_ips,
    observed_at: report.observed_at,
    // N-2 — a DELIBERATE allowlist addition (like exit_ip above), but sourced from
    // the proxy row rather than the harness frame: the {os, confidence} subset of
    // the exit's cached TCP/IP OS fingerprint. `?? null` keeps a miss a miss —
    // NOT OBSERVED, rendered "measuring…", never a placeholder OS. The internal
    // diagnostics (reason / observed_ip / observed_via) are NOT crossed to the
    // customer.
    os_fingerprint: osFingerprint ?? null,
  };
}

export class SessionCapabilityReportStore {
  private readonly map = new Map<string, SessionCapabilityReport>();

  constructor(private readonly maxEntries = 5_000) {}

  set(frame: CapabilityReport): void {
    this.map.delete(frame.sessionId);
    this.map.set(frame.sessionId, {
      timestamp: frame.timestamp,
      manual_input_available: frame.manualInputAvailable ?? null,
      streaming_state: frame.streamingState ?? null,
      egress_state: frame.egressState ?? null,
      proxy_kind: frame.proxyKind,
      proxy_udp_supported: frame.proxyUdpSupported,
      transport_mode_requested: frame.transportModeRequested,
      transport_mode_active: frame.transportModeActive,
      // `?? null` preserves the node's absent-until-observed semantics exactly:
      // the field is reported only once a handshake has completed, so absent
      // stays NOT-OBSERVED and never collapses into a false "no HTTP/3".
      h3_connection_observed: frame.h3ConnectionObserved ?? null,
      // (o) O2 — `?? null` and NEVER `?? 0`: a zero is a MEASUREMENT ("this
      // session has carried no HTTP/3 connection"), and a frame that never
      // carried the key has measured nothing. Coercing absence to 0 would put a
      // confident negative on every older harness's session.
      h3_connection_count: frame.h3ConnectionCount ?? null,
      interpose_image_loaded: frame.interposeImageLoaded ?? null,
      // T-26 — `?? null` preserves the node's absent-until-observed semantics
      // exactly: a key the schema dropped (malformed value) or an older harness
      // never sent stays NOT-OBSERVED and never collapses into a false answer.
      exit_ip: frame.exitIp ?? null,
      exit_country: frame.exitCountry ?? null,
      exit_timezone: frame.exitTimezone ?? null,
      webrtc_candidate_ips: frame.webrtcCandidateIps ?? null,
      observed_at: frame.observedAt ?? null,
      // `every` on an EMPTY array is true, so a frame carrying no safeguard
      // checks previously reported `safeguards_passed: true` — a positive
      // safety claim asserted from no evidence, indistinguishable to a customer
      // from every check having run and passed. The schema permits it:
      // `safeguardChecks` is `.max(16)` with no `.min(1)`, so an older or
      // misbehaving node sending `[]` validates cleanly. At least one check must
      // have run before this asserts anything, and the relay emits
      // `safeguards_unreported` so "we do not know" stays distinguishable from
      // "a check failed".
      safeguards_passed:
        frame.safeguardChecks.length > 0 && frame.safeguardChecks.every((check) => check.passed),
      // `?? null` and never `?? {}` — see the field doc. Absent stays absent.
      streaming_health: frame.streamingHealth ?? null,
    });
    if (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  get(sessionId: string): SessionCapabilityReport | null {
    return this.map.get(sessionId) ?? null;
  }

  delete(sessionId: string): void {
    this.map.delete(sessionId);
  }

  get size(): number {
    return this.map.size;
  }
}
