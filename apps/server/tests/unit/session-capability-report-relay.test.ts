import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/lib/logger.js';
import type { CapabilityReport } from '../../src/schemas/harness-control-protocol.js';
import { makeSessionCapabilityReportRelay } from '../../src/services/session-capability-report-relay.js';
import { SessionCapabilityReportStore } from '../../src/services/session-capability-report-store.js';
import {
  customerSafeEgressWarnings,
  unmappedEgressWarnings,
} from '../../src/services/customer-safe-egress-warnings.js';

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
        // The fixture's one safeguard check failed, so the tri-state reads
        // `failed` — it takes precedence over `unverified` even though this
        // fixture also declares no `safeguardLayersExpected`.
        safeguards: 'failed',
        warnings: [
          // proxyId null: no proxy of its own, so the UDP gap is the connection
          // Driftstack provides (published as quic_unavailable — see the last
          // describe in this file), not `udp_unsupported_by_proxy`.
          'udp_unsupported_by_default_connection',
          'safeguard_failed:dns',
          // ⛔ This fixture declares no `safeguardLayersExpected`, so the control
          // plane has not been told what a complete set of safeguards looks like
          // and cannot claim completeness. That is a DIFFERENT fact from a layer
          // being absent, and it gets its own code so an operator is not sent
          // looking for a check that was never expected in the first place.
          'safeguards_expectation_unreported',
          'streaming_blank',
          // This fixture's session has proxyId null — no proxy of its own — so
          // the device's `dead_proxy` is the connection Driftstack provides and
          // is warned as ours (see the describe at the end of this file).
          'default_connection_down',
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

// Item 4 — a device-side safeguard layer with no entry in
// PUBLIC_SAFEGUARD_LAYERS is noticed the moment it is DECLARED (expected or
// reported), not the moment it first FAILS. Every layer name in this block is
// unique to these tests, so the recorder's real once-per-process log dedupe
// (shared with the egress-warning map) cannot make one test's assertion
// depend on another test having run first.
describe('makeSessionCapabilityReportRelay — early notice of an unworded safeguard layer', () => {
  function ownedRelay(log: Logger) {
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
      log,
    );
    return { relay, ingest };
  }

  it('CRITICAL a reported layer with no public word is logged once, sanitised, under the distinct safeguard_layer_unworded: form — noticed on report, before it ever fails', async () => {
    const log = logger();
    const { relay } = ownedRelay(log);

    relay(
      report('agt_unworded_1', {
        safeguardChecks: [{ layer: 'zz_test_new_layer_reported', passed: true, timestamp: 't' }],
      }),
      'node-1',
    );

    await vi.waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'safeguard_layer_unworded:zz_test_new_layer_reported' }),
        expect.any(String),
      ),
    );
    expect(
      unmappedEgressWarnings.counts().get('safeguard_layer_unworded:zz_test_new_layer_reported'),
    ).toBeGreaterThan(0);
  });

  it("CRITICAL a layer only DECLARED via safeguardLayersExpected — never checked, never failed — is still noticed. This is the whole point: today's failure-only path would never see a layer that keeps passing or never runs at all.", async () => {
    const log = logger();
    const { relay } = ownedRelay(log);

    relay(
      report('agt_unworded_2', {
        safeguardLayersExpected: ['zz_test_new_layer_expected_only'],
        safeguardChecks: [],
      }),
      'node-1',
    );

    await vi.waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'safeguard_layer_unworded:zz_test_new_layer_expected_only',
        }),
        expect.any(String),
      ),
    );
  });

  it('a layer already published under PUBLIC_SAFEGUARD_LAYERS triggers no notice — VACUITY check for the arms above: this is the same relay, the same call site, and it stays silent for a layer already worded', async () => {
    const log = logger();
    const { relay, ingest } = ownedRelay(log);
    const before = unmappedEgressWarnings.counts().get('safeguard_layer_unworded:network_firewall');

    relay(
      report('agt_unworded_3', {
        safeguardLayersExpected: ['network_firewall'],
        safeguardChecks: [{ layer: 'network_firewall', passed: true, timestamp: 't' }],
      }),
      'node-1',
    );

    // Wait for processing to complete (ingest fires last), then assert silence.
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
    expect(unmappedEgressWarnings.counts().get('safeguard_layer_unworded:network_firewall')).toBe(
      before,
    );
    for (const call of vi.mocked(log.warn).mock.calls as unknown[][]) {
      const arg = call[0] as Record<string, unknown> | undefined;
      expect(arg?.code).not.toBe('safeguard_layer_unworded:network_firewall');
    }
  });

  it('a hostile layer name is sanitised before it is ever logged — the raw device string never reaches the log line', async () => {
    const log = logger();
    const { relay } = ownedRelay(log);
    const hostile = '../../x <script> relay-07.fleet.internal:1080';

    relay(
      report('agt_unworded_4', {
        safeguardChecks: [{ layer: hostile, passed: true, timestamp: 't' }],
      }),
      'node-1',
    );

    await vi.waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'safeguard_layer_unworded:unprintable' }),
        expect.any(String),
      ),
    );
    for (const call of vi.mocked(log.warn).mock.calls as unknown[][]) {
      const arg = call[0] as Record<string, unknown> | undefined;
      expect(JSON.stringify(arg)).not.toContain('fleet.internal');
      expect(JSON.stringify(arg)).not.toContain('<script>');
    }
  });

  it('NEGATIVE CONTROL — deriveWarnings-visible customer output is unchanged by this notice: warnings still carries only safeguard_failed:<published word>, never the unworded prefix', async () => {
    const log = logger();
    const { relay, ingest } = ownedRelay(log);

    relay(
      report('agt_unworded_5', {
        safeguardChecks: [
          { layer: 'zz_test_new_layer_customer_check', passed: false, timestamp: 't' },
        ],
      }),
      'node-1',
    );

    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
    const derived = (ingest.mock.calls[0] as unknown[])[0] as { derived: { warnings: string[] } };
    expect(derived.derived.warnings).toContain('safeguard_failed:zz_test_new_layer_customer_check');
    expect(derived.derived.warnings.some((w) => w.startsWith('safeguard_layer_unworded:'))).toBe(
      false,
    );
  });
});

// A /v1/sessions driver session linked to an agent session on the connection
// Driftstack provides (the agent session's proxyId is NULL). When that
// connection stops carrying traffic the device reports `egressState:
// 'dead_proxy'` — it cannot tell our connection from a customer's proxy — and
// this relay passed `dead_proxy` into the driver session's warnings and the
// `session.egress_capability_changed` webhook, which the docs render as "Your
// proxy stopped answering" — for a customer who chose no proxy. The same
// proxyId-null projection the agent-session read makes, applied where the
// warning is derived. The raw frame is still stored as the device sent it; the
// public edge projects its egressState from this warning.
describe('a dead connection on a session with no proxy of its own is warned as ours on /v1/sessions', () => {
  function relayFor(proxyId: string | null | undefined) {
    const ingest = vi.fn((_args: unknown) => Promise.resolve());
    const owned: Record<string, unknown> = {
      nodeId: 'node-1',
      driftstackSessionId: 'ses_driver_1',
      accountId: 'acc_1',
      status: 'active',
    };
    // `undefined` = a caller whose record does not carry the field at all.
    if (proxyId !== undefined) owned.proxyId = proxyId;
    const relay = makeSessionCapabilityReportRelay(
      {
        get: vi.fn(() => Promise.resolve(owned as never)),
        ...stopPolicyStubs(),
      },
      { ingestEgressCapabilityReport: ingest },
      new SessionCapabilityReportStore(),
      logger(),
    );
    return { relay, ingest };
  }

  async function ingested(
    proxyId: string | null | undefined,
    egressState: CapabilityReport['egressState'],
  ): Promise<{ warnings: string[]; raw: Record<string, unknown> }> {
    const { relay, ingest } = relayFor(proxyId);
    relay(report('agt_1', { egressState }), 'node-1');
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
    const args = ingest.mock.calls[0]?.[0] as {
      derived: { warnings: string[] };
      raw: Record<string, unknown>;
    };
    return { warnings: args.derived.warnings, raw: args.raw };
  }

  it('CRITICAL proxyId null + dead_proxy → default_connection_down, and never dead_proxy', async () => {
    const { warnings, raw } = await ingested(null, 'dead_proxy');
    expect(warnings).toContain('default_connection_down');
    expect(warnings).not.toContain('dead_proxy');
    // The stored frame keeps the device's word; the public edge projects it.
    expect(raw.egressState).toBe('dead_proxy');
  });

  it("CRITICAL proxyId set + dead_proxy stays dead_proxy: that is the customer's own proxy", async () => {
    const { warnings } = await ingested('prx_customer_own', 'dead_proxy');
    expect(warnings).toContain('dead_proxy');
    expect(warnings).not.toContain('default_connection_down');
  });

  it('a record with no proxyId at all is NOT read as no proxy — the device word stands', async () => {
    const { warnings } = await ingested(undefined, 'dead_proxy');
    expect(warnings).toContain('dead_proxy');
    expect(warnings).not.toContain('default_connection_down');
  });

  it('a live connection warns nothing either way', async () => {
    for (const proxyId of [null, 'prx_customer_own']) {
      const { warnings } = await ingested(proxyId, 'live');
      expect(warnings).not.toContain('dead_proxy');
      expect(warnings).not.toContain('default_connection_down');
    }
  });
});

// The same defect one layer over. On a session with no proxy of its own,
// `udp_unsupported_by_proxy` (documented as "Your proxy refused the SOCKS5 UDP
// ASSOCIATE command … Use a proxy that carries UDP") and
// `safeguard_failed:per_spawn_verification` (published as
// `safeguard_failed:proxy_egress_verification`, "confirm your proxy") still
// blamed a proxy the customer does not have, on /v1/sessions and the webhook.
// The UDP gap is the connection Driftstack provides: published as
// `quic_unavailable` (what the customer can see — QUIC was not used). The route
// check is published as the bare `safeguard_failed` (a safeguard did not pass —
// contact support). Both are members of the published vocabulary already, so no
// new public code ships; operators keep a distinct internal code for each.
describe('a UDP gap or a failed route check on a session with no proxy of its own does not blame a proxy', () => {
  async function derivedFor(proxyId: string | null | undefined): Promise<{
    internal: string[];
    safeguards: string | undefined;
    published: string[];
    unmapped: string[];
  }> {
    const ingest = vi.fn((_args: unknown) => Promise.resolve());
    const owned: Record<string, unknown> = {
      nodeId: 'node-1',
      driftstackSessionId: 'ses_driver_1',
      accountId: 'acc_1',
      status: 'active',
    };
    // `undefined` = a caller whose record does not carry the field at all.
    if (proxyId !== undefined) owned.proxyId = proxyId;
    const relay = makeSessionCapabilityReportRelay(
      { get: vi.fn(() => Promise.resolve(owned as never)), ...stopPolicyStubs() },
      { ingestEgressCapabilityReport: ingest },
      new SessionCapabilityReportStore(),
      logger(),
    );
    relay(
      report('agt_1', {
        transportModeRequested: 'h2-and-h3',
        transportModeActive: 'h2-only',
        safeguardChecks: [
          { layer: 'per_spawn_verification', passed: false, detail: 'x', timestamp: 't' },
          { layer: 'webkit_gate', passed: false, detail: 'x', timestamp: 't' },
          { layer: 'network_firewall', passed: true, detail: 'ok', timestamp: 't' },
        ],
        streamingState: 'live',
        egressState: 'live',
      }),
      'node-1',
    );
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
    const derived = (
      ingest.mock.calls[0]?.[0] as { derived: { warnings: string[]; safeguards?: string } }
    ).derived;
    const { warnings: published, unmapped } = customerSafeEgressWarnings(derived.warnings);
    return { internal: derived.warnings, safeguards: derived.safeguards, published, unmapped };
  }

  it('CRITICAL proxyId null → quic_unavailable and the bare safeguard_failed, never a proxy form', async () => {
    const { internal, safeguards, published, unmapped } = await derivedFor(null);
    expect(internal).toContain('udp_unsupported_by_default_connection');
    expect(internal).toContain('default_connection_verification_failed');
    expect(internal).not.toContain('udp_unsupported_by_proxy');
    expect(internal).not.toContain('safeguard_failed:per_spawn_verification');
    // Every other failing layer is named exactly as before.
    expect(internal).toContain('safeguard_failed:webkit_gate');
    // The failed check still fails the session's safeguards.
    expect(safeguards).toBe('failed');
    expect(unmapped, 'both new internal codes are classified').toEqual([]);
    expect(published).toContain('quic_unavailable');
    expect(published).toContain('safeguard_failed');
    expect(published).toContain('safeguard_failed:browser_integrity');
    expect(published).not.toContain('udp_unsupported_by_proxy');
    expect(published).not.toContain('safeguard_failed:proxy_egress_verification');
  });

  it("proxyId set: the customer's own proxy keeps both proxy forms", async () => {
    const { internal, published } = await derivedFor('prx_customer_own');
    expect(internal).toContain('udp_unsupported_by_proxy');
    expect(internal).toContain('safeguard_failed:per_spawn_verification');
    expect(internal).not.toContain('udp_unsupported_by_default_connection');
    expect(internal).not.toContain('default_connection_verification_failed');
    expect(published).toContain('udp_unsupported_by_proxy');
    expect(published).toContain('safeguard_failed:proxy_egress_verification');
  });

  it('a record with no proxyId at all is NOT read as no proxy — the proxy forms stand', async () => {
    const { internal } = await derivedFor(undefined);
    expect(internal).toContain('udp_unsupported_by_proxy');
    expect(internal).toContain('safeguard_failed:per_spawn_verification');
  });
});
