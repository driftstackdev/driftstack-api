// (o) O2 — the QUIC liveness count must reach the customer, or the branch that
// renders it is unreachable code.
//
// ⛔ THE DEFECT. The node has sent `h3ConnectionCount` on every capabilityReport
// since the schema accepted it, and `fleet-control-registry.ts` even logs it by
// value — but `SessionCapabilityReport` had no count field, so the value died at
// the store. The customer-safe projection could not strip what it never held.
// Downstream, `apps/gui-client/src/lib/session-h3-observation.ts` parses
// `h3_connection_count` and the readout renders `· N connections` off it: both
// were written against a field the control plane could never send, so the
// cockpit could only ever show the LATCHED "h3 was reached once" boolean.
//
// That boolean is backed by an insert-only Set on the node and can never return
// to false. It is a sound "ever" claim and an unsound liveness signal — a
// consumer reading it as current refreshes a verdict on a relay that died an hour
// ago, and the timestamp looks fresh BECAUSE nothing is checking. The count is
// monotone, so its RATE carries what the boolean structurally cannot, and a rate
// is unobservable from a boolean however often you read it.
//
// PRODUCTION LINES THIS GUARDS (reverting any one reds a named arm):
//   * `services/session-capability-report-store.ts` — `h3_connection_count:
//     frame.h3ConnectionCount ?? null` in `set()`. Delete it and arm 1 reds
//     (stored null where the frame carried 7). Change `?? null` to `?? 0` and
//     arm 2 reds (0 is a measurement; absence is not).
//   * `services/session-capability-report-store.ts` — `h3_connection_count:
//     report.h3_connection_count` in `customerSafeCapabilityReport`. Delete it
//     and arms 1 and 2 red (the key vanishes from the customer projection, which
//     is the exact state that made the GUI branch dead).
//
// ⚠️ ARM 3 IS THE VACUITY CONTROL AND IT FAILS THE WAY THE REAL FAILURE WOULD.
// The allowlist's whole reason for existing is that a spread leaks every internal
// field the moment one is added (`streaming_health` put eleven harness counters
// into a customer payload in the commit that added it). The cheap wrong fix for
// this item — replace the allowlist with `{...report}` — passes arms 1 and 2 and
// reds arm 3, which asserts the INTERNAL fields are still absent.

import { describe, expect, it } from 'vitest';
import type { CapabilityReport } from '../../src/schemas/harness-control-protocol.js';
import {
  SessionCapabilityReportStore,
  customerSafeCapabilityReport,
} from '../../src/services/session-capability-report-store.js';

function report(sessionId: string, overrides: Partial<CapabilityReport> = {}): CapabilityReport {
  return {
    type: 'capabilityReport',
    sessionId,
    timestamp: '2026-07-13T06:00:00.000Z',
    egressPhase: 'phase_1_socks5',
    proxyKind: 'socks5',
    proxyUdpSupported: true,
    proxyIpv4Supported: true,
    proxyIpv6Supported: false,
    transportModeRequested: 'h2-and-h3',
    transportModeActive: 'h2-and-h3',
    h3InterposeLoaded: true,
    httpsSkipActive: true,
    safeguardChecks: [{ layer: 'dns', passed: true, timestamp: 't' }],
    archetypeId: 'iphone16pro_ios18_6_safari18_6',
    manualInputAvailable: true,
    streamingState: 'live',
    egressState: 'live',
    ...overrides,
  };
}

describe('h3_connection_count reaches the customer projection', () => {
  it('CRITICAL a frame carrying a count projects it — the rate the latched boolean cannot carry', () => {
    const store = new SessionCapabilityReportStore();
    store.set(report('agt_1', { h3ConnectionCount: 7, h3ConnectionObserved: true }));
    const stored = store.get('agt_1');
    expect(stored?.h3_connection_count).toBe(7);
    const safe = customerSafeCapabilityReport(stored!);
    expect(safe.h3_connection_count).toBe(7);
    // The latched flag still rides beside it — the count REPLACES nothing.
    expect(safe.h3_connection_observed).toBe(true);
    // And a later frame with a higher count replaces the stored one, so a
    // consumer comparing two reads can see it MOVE. A count that latched like
    // the boolean would carry no more liveness than the boolean.
    store.set(report('agt_1', { h3ConnectionCount: 9, h3ConnectionObserved: true }));
    expect(customerSafeCapabilityReport(store.get('agt_1')!).h3_connection_count).toBe(9);
  });

  it('CRITICAL a frame WITHOUT a count projects null — and the latched verdict still crosses, so the readout keeps rendering', () => {
    const store = new SessionCapabilityReportStore();
    store.set(report('agt_2', { h3ConnectionObserved: true }));
    const safe = customerSafeCapabilityReport(store.get('agt_2')!);
    // ⛔ null, not 0. A 0 is the measurement "no HTTP/3 connection on this
    // session"; an older harness that never sends the key measured nothing, and
    // `?? 0` would put that confident negative on every one of its sessions.
    expect(safe.h3_connection_count).toBeNull();
    expect(safe.h3_connection_observed).toBe(true);
    // A count of 0 IS a measurement and survives as 0 — the two must stay
    // distinguishable, which is the whole point of the null.
    store.set(report('agt_2', { h3ConnectionCount: 0 }));
    expect(customerSafeCapabilityReport(store.get('agt_2')!).h3_connection_count).toBe(0);
  });

  it('CONTROL the count is the ONLY thing this change crossed — the internal diagnostics stay out of the customer subset', () => {
    const store = new SessionCapabilityReportStore();
    store.set(
      report('agt_3', {
        h3ConnectionCount: 3,
        interposeImageLoaded: true,
        streamingHealth: { subscribers: 1, framesPublished: 10 },
      }),
    );
    const stored = store.get('agt_3');
    // Both internal fields ARE stored — so their absence below is the allowlist
    // doing its job, not the frame having arrived empty. Without this the arm
    // would pass on nothing having happened.
    expect(stored?.interpose_image_loaded).toBe(true);
    expect(stored?.streaming_health).not.toBeNull();
    const safe = customerSafeCapabilityReport(stored!);
    expect(safe.h3_connection_count).toBe(3);
    expect('interpose_image_loaded' in safe).toBe(false);
    expect('streaming_health' in safe).toBe(false);
  });
});
