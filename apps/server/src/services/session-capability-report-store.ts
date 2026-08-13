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
