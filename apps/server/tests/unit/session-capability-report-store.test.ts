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
      // (o) O2 — ⛔ null, not 0, for exactly the reason above: a 0 is the
      // measurement "this session has carried no HTTP/3 connection", and this
      // frame measured nothing.
      h3_connection_count: null,
      interpose_image_loaded: null,
      // T-26 — ⛔ null, not empty: absent means NOT OBSERVED (this frame carries
      // no exit identity), never "no exit". Same absent-until-measured contract.
      exit_ip: null,
      exit_country: null,
      exit_timezone: null,
      webrtc_candidate_ips: null,
      observed_at: null,
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

  it('T-26 surfaces the live exit identity + WebRTC IPs and includes them in the customer-safe subset; absence stays null', () => {
    const store = new SessionCapabilityReportStore();
    store.set(
      report('agt_1', {
        exitIp: '203.0.113.7',
        exitCountry: 'US',
        exitTimezone: 'America/New_York',
        webrtcCandidateIps: ['203.0.113.7'],
        observedAt: '2026-09-07T00:00:00.000Z',
      }),
    );
    const stored = store.get('agt_1');
    expect(stored).not.toBeNull();
    expect(stored?.exit_ip).toBe('203.0.113.7');
    expect(stored?.exit_country).toBe('US');
    expect(stored?.exit_timezone).toBe('America/New_York');
    expect(stored?.webrtc_candidate_ips).toEqual(['203.0.113.7']);
    expect(stored?.observed_at).toBe('2026-09-07T00:00:00.000Z');
    // The GUI-facing subset carries them — they are the customer's OWN egress.
    const safe = customerSafeCapabilityReport(stored!);
    expect(safe.exit_ip).toBe('203.0.113.7');
    expect(safe.exit_country).toBe('US');
    expect(safe.webrtc_candidate_ips).toEqual(['203.0.113.7']);
    expect(safe.observed_at).toBe('2026-09-07T00:00:00.000Z');
    // ⛔ Vacuity: a frame WITHOUT the exit fields stores null, never a
    // fabricated value — the same absent-until-measured contract as h3.
    store.set(report('agt_2'));
    expect(store.get('agt_2')?.exit_ip).toBeNull();
    expect(store.get('agt_2')?.webrtc_candidate_ips).toBeNull();
    expect(store.get('agt_2')?.observed_at).toBeNull();
  });

  it('N-2 the customer-safe subset carries the {os, confidence} OS-fingerprint arg, and is null without it — never a placeholder OS', () => {
    const store = new SessionCapabilityReportStore();
    store.set(report('agt_1'));
    const stored = store.get('agt_1');
    expect(stored).not.toBeNull();

    // With the arg the control plane read from the proxy row, ONLY the {os,
    // confidence} subset crosses — the internal reason/observed_ip/observed_via
    // (which the arg deliberately does not carry) never appear.
    const safe = customerSafeCapabilityReport(stored!, { os: 'windows', confidence: 'medium' });
    expect(safe.os_fingerprint).toEqual({ os: 'windows', confidence: 'medium' });

    // ⛔ Absent-is-not-a-negative: with NO arg (never measured, or no owned proxy)
    // the field is null — NOT OBSERVED, rendered "measuring…" — never coerced to a
    // placeholder OS. The key is always present so the wire shape is stable.
    const safeNone = customerSafeCapabilityReport(stored!);
    expect(safeNone.os_fingerprint).toBeNull();
    // A null arg is treated the same as absent.
    expect(customerSafeCapabilityReport(stored!, null).os_fingerprint).toBeNull();
  });
});
