import { describe, expect, it } from 'vitest';
import type { CapabilityReport } from '../../src/schemas/harness-control-protocol.js';
import { SessionCapabilityReportStore } from '../../src/services/session-capability-report-store.js';

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

describe('SessionCapabilityReportStore', () => {
  it('projects the customer-safe live state and replaces it for the same session', () => {
    const store = new SessionCapabilityReportStore();
    store.set(report('agt_1'));
    expect(store.get('agt_1')).toEqual({
      timestamp: '2026-07-13T06:00:00.000Z',
      manual_input_available: true,
      streaming_state: 'live',
      egress_state: 'live',
      proxy_kind: 'socks5',
      proxy_udp_supported: true,
      transport_mode_requested: 'h2-and-h3',
      transport_mode_active: 'h2-and-h3',
      safeguards_passed: true,
      // T-6 — ⛔ null, not false: the node reports these only once it has
      // OBSERVED the fact, so absent means NOT OBSERVED. Reading either as a
      // negative would assert "this session carried no HTTP/3" from no evidence,
      // the same defect shape as the streaming_health zeroes below.
      h3_connection_observed: null,
      interpose_image_loaded: null,
      // ⛔ null, not an object of zeroes: absent means the node never reported,
      // which must never render as a healthy stream (V-2188).
      streaming_health: null,
    });

    store.set(
      report('agt_1', {
        timestamp: '2026-07-13T06:01:00.000Z',
        manualInputAvailable: false,
        streamingState: 'blank',
        egressState: 'dead_proxy',
        safeguardChecks: [{ layer: 'dns', passed: false, timestamp: 't' }],
      }),
    );
    expect(store.get('agt_1')).toMatchObject({
      timestamp: '2026-07-13T06:01:00.000Z',
      manual_input_available: false,
      streaming_state: 'blank',
      egress_state: 'dead_proxy',
      safeguards_passed: false,
    });
    expect(store.size).toBe(1);
  });

  it('uses null for optional legacy signals, evicts the oldest entry at its cap, and deletes', () => {
    const store = new SessionCapabilityReportStore(2);
    store.set(
      report('agt_1', {
        manualInputAvailable: undefined,
        streamingState: undefined,
        egressState: undefined,
      }),
    );
    expect(store.get('agt_1')).toMatchObject({
      manual_input_available: null,
      streaming_state: null,
      egress_state: null,
    });
    store.set(report('agt_2'));
    store.set(report('agt_3'));
    expect(store.get('agt_1')).toBeNull();
    expect(store.size).toBe(2);
    store.delete('agt_2');
    expect(store.get('agt_2')).toBeNull();
  });
});
