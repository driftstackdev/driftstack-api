// Owner item T-6: "Proxy test, after checking correctly says if we have UDP and
// HTTP/2, but NOT QUIC, even though the proxy supports it. This test needs to be
// more reliable!"
//
// MEASURED mechanism: the ONLY real QUIC observation is `h3ConnectionObserved` on
// a live session's capabilityReport — present-and-true once a QUIC handshake has
// actually completed this session (a fork marker), never a restatement of the
// requested mode. (h3InterposeLoaded, by contrast, is exactly activeMode ===
// 'h2-and-h3' — a config echo — so it drives quic_route but NEVER the measured
// verdict.) This guard pins the back-fill: a real observation persists 'h3' onto
// the owned proxy; the absence of one writes NOTHING (null, chip stays inferred),
// because "not observed yet" is not "this proxy cannot do QUIC".
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

// A frame whose QUIC really carried: a completed handshake was observed
// (h3ConnectionObserved true). Overrides flip the field that decides the verdict.
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
    h3ConnectionObserved: true,
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
  driftstackSessionId: string | null = 'ses_driver_1',
): ReturnType<typeof makeSessionCapabilityReportRelay> {
  return makeSessionCapabilityReportRelay(
    {
      get: vi.fn(() =>
        Promise.resolve({
          nodeId: 'node-1',
          driftstackSessionId,
          accountId: 'acc_owner',
          proxyId,
          status: 'active',
        }),
      ),
      // T-26 — not exercised here (no stop-on-exit-IP policy on these sessions).
      setFirstExitIpIfUnset: vi.fn(() => Promise.resolve(null)),
      closeWithReasonOutcome: vi.fn(() => Promise.resolve({ kind: 'already_closed' as const })),
      recordErrorEvent: vi.fn(() => Promise.resolve(null)),
    },
    { ingestEgressCapabilityReport: vi.fn(() => Promise.resolve()) },
    new SessionCapabilityReportStore(),
    logger(),
    accountProxies,
    () => MEASURED_AT,
  );
}

describe('a live session back-fills the measured QUIC verdict onto its proxy', () => {
  it("CRITICAL a session whose QUIC handshake was OBSERVED writes quic_measured 'h3', owner-scoped, stamped with the injected clock — the confirmed verdict the inferred chip could never show", async () => {
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

  it('CRITICAL a report with the CONFIGURED mode fully set (h2-and-h3 active, interpose flag true) but NO observed handshake writes NOTHING — the config echo is not a measurement, and a proxy that has not been seen to carry h3 stays null (chip: inferred), never a false green', async () => {
    const update = vi.fn(
      (_args: {
        id: string;
        accountId: string;
        expectedScheme?: string;
        updates: { quicMeasured?: string | null; quicMeasuredAt?: Date | null };
      }) => Promise.resolve(null),
    );
    // The default report already has transportModeActive 'h2-and-h3' AND
    // h3InterposeLoaded true — the exact config echo the OLD relay wrote 'h3'
    // from. Here the real observation is absent (as it is on every harness that
    // has not yet observed a handshake — the old fleet, and the new fleet before
    // the fork build). A relay keyed on the config echo would falsely write 'h3';
    // a relay keyed on the observation writes nothing at all.
    relayWith('prx_owned', { update })(report({ h3ConnectionObserved: undefined }), 'node-1');

    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(update).not.toHaveBeenCalled();
  });

  it('CRITICAL a session with NO driver-session link still back-fills — the verdict is about the PROXY, and the guard below it belongs to the egress ingest, not here. Every session created without a customer-supplied driftstack_session_id (the normal shape, including every one the desktop app creates) was silently unable to record a measured verdict while this ran under that return.', async () => {
    const update = vi.fn(
      (_args: {
        id: string;
        accountId: string;
        expectedScheme?: string;
        updates: { quicMeasured?: string | null; quicMeasuredAt?: Date | null };
      }) => Promise.resolve(null),
    );
    // driftstackSessionId null — no driver session was ever linked, which is not
    // a statement about the proxy and must not suppress the observation.
    relayWith('prx_owned', { update }, null)(report(), 'node-1');

    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![0].updates.quicMeasured).toBe('h3');
    expect(update.mock.calls[0]![0].id).toBe('prx_owned');
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

describe('VPN parity — a live session back-fills the EXIT IDENTITY the box observed onto its proxy', () => {
  // The relay's widened update shape (quic OR exit fields).
  type ExitUpdate = {
    id: string;
    accountId: string;
    updates: {
      quicMeasured?: string;
      quicMeasuredAt?: Date;
      exitObserved?: {
        ip: string;
        country: string | null;
        timezone: string | null;
        observed_via: 'session';
      };
      exitObservedAt?: Date;
    };
  };
  // No observed handshake, so ONLY the exit back-fill fires and the single call is
  // unambiguous.
  const exitFrame = (over: Partial<CapabilityReport> = {}): CapabilityReport =>
    report({
      h3ConnectionObserved: undefined,
      exitIp: '203.0.113.9',
      exitCountry: 'NL',
      exitTimezone: 'Europe/Amsterdam',
      ...over,
    });

  it('CRITICAL a report carrying the observed exit writes exit_observed {ip, country, timezone, observed_via: session}, owner-scoped, stamped with the injected clock — the ONLY way an OpenVPN/WireGuard proxy ever gets a location or a timezone, because the Mac cannot probe through a tunnel', async () => {
    const update = vi.fn((_a: ExitUpdate) => Promise.resolve(undefined));
    relayWith('prx_owned', { update })(exitFrame(), 'node-1');
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const arg = update.mock.calls[0]![0];
    expect(arg.id).toBe('prx_owned');
    expect(arg.accountId).toBe('acc_owner');
    expect(arg.updates.exitObserved).toEqual({
      ip: '203.0.113.9',
      country: 'NL',
      timezone: 'Europe/Amsterdam',
      observed_via: 'session',
    });
    // The timestamp is the injected clock, not the frame's own time.
    expect(arg.updates.exitObservedAt).toBe(MEASURED_AT);
  });

  it('a report with an exit IP but no country/timezone (the geo lookup missed) still records the IP with nulls — an unknown zone is null, never a placeholder', async () => {
    const update = vi.fn((_a: ExitUpdate) => Promise.resolve(undefined));
    relayWith('prx_owned', { update })(
      exitFrame({ exitCountry: undefined, exitTimezone: undefined }),
      'node-1',
    );
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![0].updates.exitObserved).toEqual({
      ip: '203.0.113.9',
      country: null,
      timezone: null,
      observed_via: 'session',
    });
  });

  it('VACUITY CONTROL a report with NO exit identity writes nothing — an absent exit is "not observed", not an exit', async () => {
    const update = vi.fn((_a: ExitUpdate) => Promise.resolve(undefined));
    relayWith('prx_owned', { update })(report({ h3ConnectionObserved: undefined }), 'node-1');
    await new Promise((r) => setTimeout(r, 20));
    expect(update).not.toHaveBeenCalled();
  });

  it('VACUITY CONTROL a session that names no proxy (operator-default egress) back-fills nothing', async () => {
    const update = vi.fn((_a: ExitUpdate) => Promise.resolve(undefined));
    relayWith(null, { update })(exitFrame(), 'node-1');
    await new Promise((r) => setTimeout(r, 20));
    expect(update).not.toHaveBeenCalled();
  });

  // (i) I7 — a fleet-vantage Test that found the tunnel DOWN stamps
  // exit_superseded_at on the row (the stored exit was contradicted). A session
  // that then reports its exit is the tunnel seen UP, so the same write that
  // records the exit must clear the stamp: a list consumer refuses to adopt an
  // observation dated at or before the stamp, so a clear that never happened
  // would keep a live proxy reading as contradicted. Seeded through the real
  // in-memory repo so the assertion is on the ROW, not on a mock's argument.
  const SUPERSEDED_AT = new Date('2026-09-03T11:00:00.000Z');
  const seedStampedRow = async (): Promise<InMemoryAccountProxiesRepo> => {
    const proxies = new InMemoryAccountProxiesRepo();
    await proxies.create('acc_owner', {
      id: 'prx_owned',
      label: 'mine',
      scheme: 'openvpn',
      host: 'vpn.example',
      port: 1194,
      username: null,
      wrappedPassword: null,
    });
    await proxies.update({
      id: 'prx_owned',
      accountId: 'acc_owner',
      updates: {
        exitObserved: {
          ip: '198.51.100.1',
          country: 'DE',
          timezone: 'Europe/Berlin',
          observed_via: 'probe',
        },
        exitObservedAt: new Date('2026-09-03T10:00:00.000Z'),
        exitSupersededAt: SUPERSEDED_AT,
      },
    });
    const seeded = await proxies.findById({ id: 'prx_owned', accountId: 'acc_owner' });
    // The seed is real: a stamp that was never there would make the clear vacuous.
    expect(seeded?.exitSupersededAt).toStrictEqual(SUPERSEDED_AT);
    return proxies;
  };

  it("CRITICAL (i) I7 a session report carrying an exit CLEARS a fleet failure's exit_superseded_at stamp on the row (null) in the same write that records the new exit — the tunnel is up, the contradiction no longer describes it", async () => {
    const proxies = await seedStampedRow();

    relayWith('prx_owned', proxies)(exitFrame(), 'node-1');
    await vi.waitFor(async () => {
      const row = await proxies.findById({ id: 'prx_owned', accountId: 'acc_owner' });
      expect(row?.exitObservedAt).toStrictEqual(MEASURED_AT);
    });
    const row = await proxies.findById({ id: 'prx_owned', accountId: 'acc_owner' });
    // Property: the stamp is CLEARED — null, not left as the seeded date and not
    // merely dropped from the update (an absent key leaves the in-memory spread
    // untouched, an `undefined` value is not null; only an explicit null passes).
    expect(row?.exitSupersededAt).toBeNull();
    // Property: the same write recorded the session's exit (latest wins over the
    // probe's), so the clear rides the exit write rather than a separate one.
    expect(row?.exitObserved).toEqual({
      ip: '203.0.113.9',
      country: 'NL',
      timezone: 'Europe/Amsterdam',
      observed_via: 'session',
    });
  });

  it('(i) I7 the clear is carried on the update itself as an explicit `exitSupersededAt: null` — the real repo writes only the keys it is handed, so an omitted key would leave the stamp standing', async () => {
    const update = vi.fn((_a: ExitUpdate & { updates: { exitSupersededAt?: Date | null } }) =>
      Promise.resolve(undefined),
    );
    relayWith('prx_owned', { update })(exitFrame(), 'node-1');
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const updates = update.mock.calls[0]![0].updates;
    expect(Object.hasOwn(updates, 'exitSupersededAt')).toBe(true);
    expect(updates.exitSupersededAt).toBeNull();
  });

  it('CONTROL (i) I7 a report with NO exit identity (a QUIC-only observation) leaves the stamp standing — only an exit write clears it, because only an exit says the tunnel carried traffic', async () => {
    const proxies = await seedStampedRow();

    // h3ConnectionObserved true, no exitIp: the QUIC back-fill fires, the exit
    // back-fill does not.
    relayWith('prx_owned', proxies)(report(), 'node-1');
    await vi.waitFor(async () => {
      const row = await proxies.findById({ id: 'prx_owned', accountId: 'acc_owner' });
      expect(row?.quicMeasured).toBe('h3');
    });
    const row = await proxies.findById({ id: 'prx_owned', accountId: 'acc_owner' });
    expect(row?.exitSupersededAt, 'not cleared by a non-exit write').toStrictEqual(SUPERSEDED_AT);
    expect(row?.exitObserved?.observed_via).toBe('probe');
  });
});
