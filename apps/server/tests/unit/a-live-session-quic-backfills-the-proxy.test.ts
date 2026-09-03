// Owner item T-6: "Proxy test, after checking correctly says if we have UDP and
// HTTP/2, but NOT QUIC, even though the proxy supports it. This test needs to be
// more reliable!"
//
// MEASURED mechanism: the ONLY real QUIC observation in the system is a live
// session's capabilityReport — transportModeActive === 'h2-and-h3' AND
// h3InterposeLoaded (session-capability-report-relay.ts, the same `quicViaProxy`
// that derives quic_route). Before T-6 that verdict was dropped: a session never
// recorded which proxy it ran through, so it could not be attributed. This guard
// pins the back-fill the relay now performs — persisting that measured verdict
// onto the owned proxy so the test/chip can show a REAL 'h3' instead of a guess
// inferred from UDP association.
//
// One property per assertion; a VACUITY CONTROL arm (an unattributed session must
// write NOTHING); real assertions, no fallback branches.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/lib/logger.js';
import type { CapabilityReport } from '../../src/schemas/harness-control-protocol.js';
import { makeSessionCapabilityReportRelay } from '../../src/services/session-capability-report-relay.js';
import { SessionCapabilityReportStore } from '../../src/services/session-capability-report-store.js';
import { InMemoryAccountProxiesRepo } from '../../src/db/account-proxies-repo.js';

const MEASURED_AT = new Date('2026-09-03T12:00:00.000Z');

function logger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

// A frame whose QUIC really carried (h2-and-h3 negotiated AND the HTTP/3
// interpose loaded). Overrides flip the two fields that decide the verdict.
function report(overrides: Partial<CapabilityReport> = {}): CapabilityReport {
  return {
    type: 'capabilityReport',
    sessionId: 'agt_1',
    timestamp: '2026-09-03T06:00:00.000Z',
    egressPhase: 'phase_1_socks5',
    proxyKind: 'socks5',
    proxyUdpSupported: true,
    proxyIpv4Supported: true,
    proxyIpv6Supported: false,
    transportModeRequested: 'h2-and-h3',
    transportModeActive: 'h2-and-h3',
    h3InterposeLoaded: true,
    httpsSkipActive: true,
    safeguardChecks: [{ layer: 'dns', passed: true, detail: 'ok', timestamp: 't' }],
    archetypeId: 'iphone16pro_ios18_6_safari18_6',
    manualInputAvailable: false,
    streamingState: 'live',
    egressState: 'live',
    ...overrides,
  };
}

// A relay whose owned session carries the given proxyId/accountId, wired to the
// given account_proxies repo and a FIXED clock so quic_measured_at is exact.
function relayWith(
  proxyId: string | null,
  accountProxies: Parameters<typeof makeSessionCapabilityReportRelay>[4],
): ReturnType<typeof makeSessionCapabilityReportRelay> {
  return makeSessionCapabilityReportRelay(
    {
      get: vi.fn(() =>
        Promise.resolve({
          nodeId: 'node-1',
          driftstackSessionId: 'ses_driver_1',
          accountId: 'acc_owner',
          proxyId,
          status: 'active',
        }),
      ),
    },
    { ingestEgressCapabilityReport: vi.fn(() => Promise.resolve()) },
    new SessionCapabilityReportStore(),
    logger(),
    accountProxies,
    () => MEASURED_AT,
  );
}

describe('a live session back-fills the measured QUIC verdict onto its proxy', () => {
  it("CRITICAL a session whose HTTP/3 interpose really carried writes quic_measured 'h3', owner-scoped, stamped with the injected clock — the confirmed verdict the inferred chip could never show", async () => {
    const update = vi.fn(
      (_args: {
        id: string;
        accountId: string;
        expectedScheme?: string;
        updates: { quicMeasured?: string | null; quicMeasuredAt?: Date | null };
      }) => Promise.resolve(null),
    );
    relayWith('prx_owned', { update })(report(), 'node-1');

    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const arg = update.mock.calls[0]![0] as {
      id: string;
      accountId: string;
      updates: { quicMeasured: string; quicMeasuredAt: Date };
    };
    // Property: a real h3 observation persists 'h3'.
    expect(arg.updates.quicMeasured).toBe('h3');
    // Property: the write is scoped to the owning account + the attributed proxy.
    expect(arg.id).toBe('prx_owned');
    expect(arg.accountId).toBe('acc_owner');
    // Property: the timestamp is the injected clock, not the frame's own time.
    expect(arg.updates.quicMeasuredAt).toBe(MEASURED_AT);
  });

  it("CRITICAL a session that ran WITHOUT the HTTP/3 interpose writes quic_measured 'h2-only', not 'h3' — a measured absence is distinct from a confirmed QUIC route", async () => {
    const update = vi.fn(
      (_args: {
        id: string;
        accountId: string;
        expectedScheme?: string;
        updates: { quicMeasured?: string | null; quicMeasuredAt?: Date | null };
      }) => Promise.resolve(null),
    );
    // Interpose absent → quicViaProxy is false even though the mode negotiated.
    relayWith('prx_owned', { update })(report({ h3InterposeLoaded: false }), 'node-1');

    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const updates = update.mock.calls[0]![0].updates;
    expect(updates.quicMeasured).toBe('h2-only');
  });

  it('VACUITY CONTROL a session that names no proxy (operator-default egress) back-fills NOTHING — an unattributed measurement has no proxy to mark', async () => {
    const update = vi.fn(
      (_args: {
        id: string;
        accountId: string;
        expectedScheme?: string;
        updates: { quicMeasured?: string | null; quicMeasuredAt?: Date | null };
      }) => Promise.resolve(null),
    );
    relayWith(null, { update })(report(), 'node-1');

    // Give the async pipeline a turn to run to completion before asserting the
    // negative: the report is still consumed, only the back-fill is skipped.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(update).not.toHaveBeenCalled();
  });

  it("owner-scoped: a session pointing at a proxy owned by ANOTHER account leaves that proxy's verdict null — the update matches no owned row", async () => {
    const proxies = new InMemoryAccountProxiesRepo();
    // The proxy belongs to a DIFFERENT account than the reporting session.
    const foreign = await proxies.create('acc_stranger', {
      id: 'prx_foreign',
      label: 'theirs',
      scheme: 'socks5',
      host: 'proxy.example',
      port: 1080,
      username: null,
      wrappedPassword: null,
    });
    expect(foreign.quicMeasured).toBeNull();

    relayWith('prx_foreign', proxies)(report(), 'node-1');
    await new Promise((r) => setTimeout(r, 10));

    // The session's account (acc_owner) does not own prx_foreign, so the
    // owner-scoped update touched no row: the stranger's verdict stays unmeasured.
    const after = await proxies.findById({ id: 'prx_foreign', accountId: 'acc_stranger' });
    expect(after?.quicMeasured).toBeNull();
  });

  it('end-to-end through the real repo: the owning session stamps its own proxy with the measured verdict', async () => {
    const proxies = new InMemoryAccountProxiesRepo();
    await proxies.create('acc_owner', {
      id: 'prx_owned',
      label: 'mine',
      scheme: 'socks5',
      host: 'proxy.example',
      port: 1080,
      username: null,
      wrappedPassword: null,
    });

    relayWith('prx_owned', proxies)(report(), 'node-1');
    await vi.waitFor(async () => {
      const row = await proxies.findById({ id: 'prx_owned', accountId: 'acc_owner' });
      expect(row?.quicMeasured).toBe('h3');
    });
    const row = await proxies.findById({ id: 'prx_owned', accountId: 'acc_owner' });
    expect(row?.quicMeasuredAt).toStrictEqual(MEASURED_AT);
  });
});
