import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/lib/logger.js';
import type { CapabilityReport } from '../../src/schemas/harness-control-protocol.js';
import { makeSessionCapabilityReportRelay } from '../../src/services/session-capability-report-relay.js';
import { SessionCapabilityReportStore } from '../../src/services/session-capability-report-store.js';

function report(sessionId = 'agt_1', overrides: Partial<CapabilityReport> = {}): CapabilityReport {
  return {
    type: 'capabilityReport',
    sessionId,
    timestamp: '2026-07-13T06:00:00.000Z',
    egressPhase: 'phase_1_socks5',
    proxyKind: 'socks5',
    proxyUdpSupported: false,
    proxyIpv4Supported: true,
    proxyIpv6Supported: false,
    transportModeRequested: 'h2-and-h3',
    transportModeActive: 'h2-only',
    h3InterposeLoaded: false,
    httpsSkipActive: true,
    safeguardChecks: [{ layer: 'dns', passed: false, detail: 'mismatch', timestamp: 't' }],
    archetypeId: 'iphone16pro_ios18_6_safari18_6',
    manualInputAvailable: false,
    streamingState: 'blank',
    egressState: 'dead_proxy',
    ...overrides,
  };
}

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

// T-26 — the stop-on-exit-IP repo methods the relay depends on. Default stubs
// so the existing (no-policy) fakes satisfy the interface without exercising
// enforcement; the T-26 suite below supplies its own.
function stopPolicyStubs() {
  return {
    setFirstExitIpIfUnset: vi.fn(() => Promise.resolve(null)),
    closeWithReasonOutcome: vi.fn(() => Promise.resolve({ kind: 'already_closed' as const })),
    recordErrorEvent: vi.fn(() => Promise.resolve(null)),
  };
}

describe('makeSessionCapabilityReportRelay', () => {
  it('requires an exact authenticated node owner, stores live GUI state, and persists derived egress state', async () => {
    const store = new SessionCapabilityReportStore();
    const ingest = vi.fn((_args: unknown) => Promise.resolve());
    const relay = makeSessionCapabilityReportRelay(
      {
        get: vi.fn(() =>
          Promise.resolve({
            nodeId: 'node-1',
            driftstackSessionId: 'ses_driver_1',
            accountId: 'acc_1',
            proxyId: null,
            status: 'active',
          }),
        ),
        ...stopPolicyStubs(),
      },
      { ingestEgressCapabilityReport: ingest },
      store,
      logger(),
    );

    relay(report(), 'node-1');
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
    expect(store.get('agt_1')).toMatchObject({
      manual_input_available: false,
      streaming_state: 'blank',
      egress_state: 'dead_proxy',
    });
    expect(ingest).toHaveBeenCalledWith({
      sessionId: 'ses_driver_1',
      derived: {
        udp_associate: false,
        quic_route: 'disabled',
        dns_remote_resolve: true,
        warnings: [
          'udp_unsupported_by_proxy',
          'safeguard_failed:dns',
          'streaming_blank',
          'dead_proxy',
        ],
      },
      raw: expect.objectContaining({ sessionId: 'agt_1', manualInputAvailable: false }),
    });
    const persisted = ingest.mock.calls[0]?.[0] as { raw: Record<string, unknown> } | undefined;
    expect(persisted?.raw).not.toHaveProperty('type');
  });

  it('drops unknown, unowned, and cross-node reports before either store or persistence', async () => {
    for (const owned of [
      null,
      {
        nodeId: null,
        driftstackSessionId: null,
        accountId: 'acc_1',
        proxyId: null,
        status: 'active',
      },
      {
        nodeId: 'node-2',
        driftstackSessionId: 'ses_2',
        accountId: 'acc_1',
        proxyId: null,
        status: 'active',
      },
      {
        nodeId: 'node-1',
        driftstackSessionId: 'ses_1',
        accountId: 'acc_1',
        proxyId: null,
        status: 'closed',
      },
    ]) {
      const store = new SessionCapabilityReportStore();
      const ingest = vi.fn((_args: unknown) => Promise.resolve());
      const log = logger();
      const relay = makeSessionCapabilityReportRelay(
        { get: vi.fn(() => Promise.resolve(owned)), ...stopPolicyStubs() },
        { ingestEgressCapabilityReport: ingest },
        store,
        log,
      );
      relay(report(), 'node-1');
      await vi.waitFor(() => expect(log.warn).toHaveBeenCalledTimes(1));
      expect(store.size).toBe(0);
      expect(ingest).not.toHaveBeenCalled();
    }
  });

  it('keeps per-session processing ordered and coalesces pending state to the newest report', async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const store = new SessionCapabilityReportStore();
    const ingest = vi.fn((_args: unknown) => Promise.resolve());
    const relay = makeSessionCapabilityReportRelay(
      {
        get: vi.fn(async () => {
          calls += 1;
          if (calls === 1) await first;
          return {
            nodeId: 'node-1',
            driftstackSessionId: 'ses_driver_1',
            accountId: 'acc_1',
            proxyId: null,
            status: 'active',
          };
        }),
        ...stopPolicyStubs(),
      },
      { ingestEgressCapabilityReport: ingest },
      store,
      logger(),
    );
    relay(report('agt_1', { timestamp: 'old', streamingState: 'blank' }), 'node-1');
    relay(report('agt_1', { timestamp: 'superseded', streamingState: 'failed' }), 'node-1');
    relay(report('agt_1', { timestamp: 'new', streamingState: 'live' }), 'node-1');
    await Promise.resolve();
    expect(calls).toBe(1);
    releaseFirst();
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(2));
    expect(calls).toBe(2);
    expect(store.get('agt_1')).toMatchObject({ timestamp: 'new', streaming_state: 'live' });
  });

  it('stores an owned unlinked agent session without inventing driver-session persistence', async () => {
    const store = new SessionCapabilityReportStore();
    const ingest = vi.fn((_args: unknown) => Promise.resolve());
    const relay = makeSessionCapabilityReportRelay(
      {
        get: vi.fn(() =>
          Promise.resolve({
            nodeId: 'node-1',
            driftstackSessionId: null,
            accountId: 'acc_1',
            proxyId: null,
            status: 'active',
          }),
        ),
        ...stopPolicyStubs(),
      },
      { ingestEgressCapabilityReport: ingest },
      store,
      logger(),
    );
    relay(report(), 'node-1');
    await vi.waitFor(() => expect(store.size).toBe(1));
    expect(ingest).not.toHaveBeenCalled();
  });

  // V-1413 — the QUIC-through-proxy half of this relay had never run. Every frame in
  // this file leaves `transportModeActive` at 'h2-only', so `h3InterposeLoaded` was
  // never even EVALUATED (the mode comparison short-circuited it), and the derived
  // `quic_route` was 'disabled' on all six passes — `'proxy'` had never been produced.
  // Per planning 133 QUIC through the egress proxy is the intended live posture, so
  // the branch that reports it working is the one nothing exercised.
  function relayWith(
    ingest: ReturnType<typeof vi.fn>,
  ): ReturnType<typeof makeSessionCapabilityReportRelay> {
    return makeSessionCapabilityReportRelay(
      {
        get: vi.fn(() =>
          Promise.resolve({
            nodeId: 'node-1',
            driftstackSessionId: 'ses_driver_1',
            accountId: 'acc_1',
            proxyId: null,
            status: 'active',
          }),
        ),
        ...stopPolicyStubs(),
      },
      { ingestEgressCapabilityReport: ingest as unknown as (a: unknown) => Promise<unknown> },
      new SessionCapabilityReportStore(),
      logger(),
    );
  }

  it("CRITICAL an active h2-and-h3 transport WITH the interpose loaded derives quic_route 'proxy'. Every frame here had left the mode at h2-only, so this value had never been produced — the success path of QUIC through the egress proxy was reported by nothing.", async () => {
    const ingest = vi.fn((_args: unknown) => Promise.resolve());
    relayWith(ingest)(
      report('agt_1', {
        transportModeActive: 'h2-and-h3',
        h3InterposeLoaded: true,
        safeguardChecks: [{ layer: 'dns', passed: true, detail: 'ok', timestamp: 't' }],
        streamingState: 'live',
        egressState: 'live',
      }),
      'node-1',
    );

    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
    const derived = (
      ingest.mock.calls[0]?.[0] as { derived: { quic_route: string; warnings: string[] } }
    ).derived;
    expect(derived.quic_route).toBe('proxy');
    expect(
      derived.warnings,
      'a working h3 interpose must not also raise the unavailable warning',
    ).not.toContain('h3_interpose_unavailable');
    expect(
      derived.warnings,
      'the requested mode was granted, so nothing is unsupported by the proxy',
    ).not.toContain('udp_unsupported_by_proxy');
  });

  it("CRITICAL an active h2-and-h3 transport WITHOUT the interpose warns h3_interpose_unavailable and still reports quic_route 'disabled'. The mode is negotiated but the interpose is what carries the traffic, so agreeing to h3 and failing to load it is the case a customer would otherwise see as a silent downgrade.", async () => {
    const ingest = vi.fn((_args: unknown) => Promise.resolve());
    relayWith(ingest)(
      report('agt_1', {
        transportModeActive: 'h2-and-h3',
        h3InterposeLoaded: false,
        safeguardChecks: [{ layer: 'dns', passed: true, detail: 'ok', timestamp: 't' }],
        streamingState: 'live',
        egressState: 'live',
      }),
      'node-1',
    );

    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
    const derived = (
      ingest.mock.calls[0]?.[0] as { derived: { quic_route: string; warnings: string[] } }
    ).derived;
    expect(derived.warnings).toContain('h3_interpose_unavailable');
    expect(
      derived.quic_route,
      'a negotiated mode without its interpose is not a working route',
    ).toBe('disabled');
  });

  it("CRITICAL a failed streaming state raises streaming_failed. Its sibling 'blank' was covered and this one never fired, which is the shape this sweep keeps finding — one arm of a pair exercised and the other left to a reader's assumption.", async () => {
    const ingest = vi.fn((_args: unknown) => Promise.resolve());
    relayWith(ingest)(
      report('agt_1', {
        safeguardChecks: [{ layer: 'dns', passed: true, detail: 'ok', timestamp: 't' }],
        streamingState: 'failed',
        egressState: 'live',
      }),
      'node-1',
    );

    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
    const derived = (ingest.mock.calls[0]?.[0] as { derived: { warnings: string[] } }).derived;
    expect(derived.warnings).toContain('streaming_failed');
    expect(derived.warnings, 'blank and failed are distinct states').not.toContain(
      'streaming_blank',
    );
  });
});

describe('T-26 stop-on-exit-IP-change enforcement', () => {
  // A relay whose owned, driver-linked session carries a configurable
  // stop-on-exit-IP policy + remembered first exit IP, with spies for the three
  // repo methods the enforcement drives.
  function make(overrides: { stopOnExitIpChange?: boolean; firstExitIp?: string | null }) {
    const store = new SessionCapabilityReportStore();
    const ingest = vi.fn((_a: unknown) => Promise.resolve());
    const setFirstExitIpIfUnset = vi.fn(() => Promise.resolve(null));
    const closeWithReasonOutcome = vi.fn(() => Promise.resolve({ kind: 'closed' as const }));
    const recordErrorEvent = vi.fn(() => Promise.resolve(null));
    const relay = makeSessionCapabilityReportRelay(
      {
        get: vi.fn(() =>
          Promise.resolve({
            nodeId: 'node-1',
            driftstackSessionId: 'ses_driver_1',
            accountId: 'acc_1',
            proxyId: null,
            status: 'active',
            stopOnExitIpChange: overrides.stopOnExitIpChange ?? false,
            firstExitIp: overrides.firstExitIp ?? null,
          }),
        ),
        setFirstExitIpIfUnset,
        closeWithReasonOutcome,
        recordErrorEvent,
      },
      { ingestEgressCapabilityReport: ingest },
      store,
      logger(),
    );
    return {
      relay,
      store,
      ingest,
      setFirstExitIpIfUnset,
      closeWithReasonOutcome,
      recordErrorEvent,
    };
  }

  it('CRITICAL flag ON + first observation records the baseline exit IP and does NOT end the session', async () => {
    const h = make({ stopOnExitIpChange: true, firstExitIp: null });
    h.relay(report('agt_1', { exitIp: '203.0.113.7' }), 'node-1');
    await vi.waitFor(() =>
      expect(h.setFirstExitIpIfUnset).toHaveBeenCalledWith('agt_1', '203.0.113.7'),
    );
    expect(h.closeWithReasonOutcome).not.toHaveBeenCalled();
    // Still live: the egress-persistence path still ran (driftstackSessionId set).
    await vi.waitFor(() => expect(h.ingest).toHaveBeenCalledTimes(1));
  });

  it('CRITICAL flag ON + a DIFFERENT exit IP ends the session (reason exit_ip_changed) and records the customer-visible from/to', async () => {
    const h = make({ stopOnExitIpChange: true, firstExitIp: '203.0.113.7' });
    h.relay(report('agt_1', { exitIp: '198.51.100.9' }), 'node-1');
    await vi.waitFor(() =>
      expect(h.closeWithReasonOutcome).toHaveBeenCalledWith('agt_1', 'exit_ip_changed'),
    );
    await vi.waitFor(() => expect(h.recordErrorEvent).toHaveBeenCalledTimes(1));
    const event = (h.recordErrorEvent.mock.calls[0] as unknown[] | undefined)?.[2] as
      | { code: string; summary: string; customerActionable: boolean }
      | undefined;
    expect(event?.code).toBe('exit_ip_changed');
    // The from/to the GUI renders: both the old and new exit IP appear.
    expect(event?.summary).toContain('203.0.113.7');
    expect(event?.summary).toContain('198.51.100.9');
    expect(event?.customerActionable).toBe(true);
    // The session ended: the egress-persistence path is skipped and the live
    // capability state is evicted for the now-terminal session.
    expect(h.ingest).not.toHaveBeenCalled();
    expect(h.store.get('agt_1')).toBeNull();
    // The baseline is never re-stamped once it already differs.
    expect(h.setFirstExitIpIfUnset).not.toHaveBeenCalled();
  });

  it('VACUITY flag OFF + a different exit IP does NOT end the session. This is the arm the planted mutation reddens: inverting the relay flag check (`stopOnExitIpChange === true` → `!== true`) makes a flag-off session close on a change, so this expectation fails.', async () => {
    const h = make({ stopOnExitIpChange: false, firstExitIp: '203.0.113.7' });
    h.relay(report('agt_1', { exitIp: '198.51.100.9' }), 'node-1');
    await vi.waitFor(() => expect(h.ingest).toHaveBeenCalledTimes(1));
    expect(h.closeWithReasonOutcome).not.toHaveBeenCalled();
    expect(h.recordErrorEvent).not.toHaveBeenCalled();
    expect(h.setFirstExitIpIfUnset).not.toHaveBeenCalled();
  });

  it('VACUITY flag ON + the SAME exit IP repeated continues the session (no baseline rewrite, no close)', async () => {
    const h = make({ stopOnExitIpChange: true, firstExitIp: '203.0.113.7' });
    h.relay(report('agt_1', { exitIp: '203.0.113.7' }), 'node-1');
    await vi.waitFor(() => expect(h.ingest).toHaveBeenCalledTimes(1));
    expect(h.closeWithReasonOutcome).not.toHaveBeenCalled();
    expect(h.setFirstExitIpIfUnset).not.toHaveBeenCalled();
  });
});
