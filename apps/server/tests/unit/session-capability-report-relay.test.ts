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
            status: 'active',
          }),
        ),
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
      { nodeId: null, driftstackSessionId: null, status: 'active' },
      { nodeId: 'node-2', driftstackSessionId: 'ses_2', status: 'active' },
      { nodeId: 'node-1', driftstackSessionId: 'ses_1', status: 'closed' },
    ]) {
      const store = new SessionCapabilityReportStore();
      const ingest = vi.fn((_args: unknown) => Promise.resolve());
      const log = logger();
      const relay = makeSessionCapabilityReportRelay(
        { get: vi.fn(() => Promise.resolve(owned)) },
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

  it('keeps per-session processing ordered when the older ownership lookup resolves later', async () => {
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
            status: 'active',
          };
        }),
      },
      { ingestEgressCapabilityReport: ingest },
      store,
      logger(),
    );
    relay(report('agt_1', { timestamp: 'old', streamingState: 'blank' }), 'node-1');
    relay(report('agt_1', { timestamp: 'new', streamingState: 'live' }), 'node-1');
    await Promise.resolve();
    expect(calls).toBe(1);
    releaseFirst();
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(2));
    expect(store.get('agt_1')).toMatchObject({ timestamp: 'new', streaming_state: 'live' });
  });

  it('stores an owned unlinked agent session without inventing driver-session persistence', async () => {
    const store = new SessionCapabilityReportStore();
    const ingest = vi.fn((_args: unknown) => Promise.resolve());
    const relay = makeSessionCapabilityReportRelay(
      {
        get: vi.fn(() =>
          Promise.resolve({ nodeId: 'node-1', driftstackSessionId: null, status: 'active' }),
        ),
      },
      { ingestEgressCapabilityReport: ingest },
      store,
      logger(),
    );
    relay(report(), 'node-1');
    await vi.waitFor(() => expect(store.size).toBe(1));
    expect(ingest).not.toHaveBeenCalled();
  });
});
