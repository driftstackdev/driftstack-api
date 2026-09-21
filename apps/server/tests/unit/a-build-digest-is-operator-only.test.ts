// A3 2026-09-19 ~19:10Z — `webkitFrameworkSha256` is an OPERATOR fact: it
// identifies the digests of OUR fork's frameworks on OUR fleet. It tells a
// customer nothing about their own session, and it must not appear on any
// customer-visible surface.
//
// ⛔ THERE ARE TWO WAYS OUT OF THIS FRAME AND ONLY ONE OF THEM HAS AN ALLOWLIST.
//   1. `SessionCapabilityReportStore` → `customerSafeCapabilityReport()` → the
//      agent-session read. That path has an explicit allowlist, and its header
//      says why: assigning the whole record used to make every internal field
//      public in the same commit that added it.
//   2. The relay's `const { type, ...raw } = frame` spread →
//      `sessions.egress_capability_report` → echoed VERBATIM by `publicSession()`
//      on the public GET /v1/sessions/:id. That path has NO allowlist at all: it
//      is an opaque passthrough, so declaring a key in the schema is by itself
//      enough to publish it.
//
// Path 2 is the one that is not obvious from either file, so it is the one these
// arms exist for. Both are covered, because a field kept out of one and not the
// other is still public.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/lib/logger.js';
import type { CapabilityReport } from '../../src/schemas/harness-control-protocol.js';
import { makeSessionCapabilityReportRelay } from '../../src/services/session-capability-report-relay.js';
import {
  SessionCapabilityReportStore,
  customerSafeCapabilityReport,
} from '../../src/services/session-capability-report-store.js';

const FRAMEWORKS = 'wc:4410edcd9abc,wk:1122334455aa,jsc:99887766ddee';

function report(overrides: Partial<CapabilityReport> = {}): CapabilityReport {
  return {
    type: 'capabilityReport',
    sessionId: 'agt_1',
    timestamp: '2026-09-19T19:10:00.000Z',
    egressPhase: 'phase_1_socks5',
    proxyKind: 'socks5',
    proxyUdpSupported: false,
    proxyIpv4Supported: true,
    proxyIpv6Supported: false,
    transportModeRequested: 'h2-only',
    transportModeActive: 'h2-only',
    h3InterposeLoaded: false,
    httpsSkipActive: true,
    safeguardChecks: [{ layer: 'dns', passed: true, timestamp: 't' }],
    archetypeId: 'iphone16pro_ios18_6_safari18_6',
    webkitForkBuild: '4410edcd9',
    webkitFrameworkSha256: FRAMEWORKS,
    ...overrides,
  };
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function relayWith(store: SessionCapabilityReportStore, ingest: (args: unknown) => Promise<void>) {
  return makeSessionCapabilityReportRelay(
    {
      get: vi.fn(() =>
        Promise.resolve({
          nodeId: 'mac-macstadium-us-001',
          driftstackSessionId: 'ses_driver_1',
          accountId: 'acc_1',
          proxyId: null,
          status: 'active',
        }),
      ),
      setFirstExitIpIfUnset: vi.fn(() => Promise.resolve(null)),
      closeWithReasonOutcome: vi.fn(() => Promise.resolve({ kind: 'already_closed' as const })),
      recordErrorEvent: vi.fn(() => Promise.resolve(null)),
    },
    { ingestEgressCapabilityReport: ingest },
    store,
    logger(),
  );
}

describe('a measured framework digest never reaches a customer', () => {
  it('CRITICAL it is stripped from the raw blob the PUBLIC sessions API echoes', async () => {
    // Fails without the destructure in the relay: declaring the key on the schema
    // is enough, on its own, to add a field to GET /v1/sessions/:id.
    const store = new SessionCapabilityReportStore();
    const ingest = vi.fn((_args: unknown) => Promise.resolve());
    relayWith(store, ingest)(report(), 'mac-macstadium-us-001');
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));

    const persisted = ingest.mock.calls[0]?.[0] as { raw: Record<string, unknown> };
    expect(persisted.raw).not.toHaveProperty('webkitFrameworkSha256');
    // The rest of the blob is untouched — this is a removal of ONE key, not a
    // new filter that quietly narrows a published payload.
    expect(persisted.raw).toHaveProperty('webkitForkBuild', '4410edcd9');
    expect(persisted.raw).toHaveProperty('archetypeId');
    expect(persisted.raw).toHaveProperty('sessionId', 'agt_1');
    expect(persisted.raw).not.toHaveProperty('type');
  });

  it('CRITICAL the customer-safe projection carries none of the three build fields', () => {
    const store = new SessionCapabilityReportStore();
    store.set(report(), 'mac-macstadium-us-001');
    const stored = store.get('agt_1');
    expect(stored).not.toBeNull();
    if (stored === null) return;

    const projected = customerSafeCapabilityReport(stored) as Record<string, unknown>;
    expect(projected).not.toHaveProperty('webkit_framework_sha256');
    expect(projected).not.toHaveProperty('webkit_fork_build');
    expect(projected).not.toHaveProperty('reporting_node_id');
    // VACUITY CONTROL — the projection still projects. Without this the arm above
    // would pass against a function that returned an empty object.
    expect(projected).toHaveProperty('proxy_kind', 'socks5');
    expect(projected).toHaveProperty('safeguards_passed');
  });
});

describe('the store keeps the operator half', () => {
  it('CRITICAL it records the measured frameworks, the declared fork build and the reporting device', async () => {
    // The frame carries no node id: the ownership gate in the relay is the only
    // place that knows which device a session belongs to, and the drift report
    // cannot compare a session against its device without it.
    const store = new SessionCapabilityReportStore();
    relayWith(
      store,
      vi.fn(() => Promise.resolve()),
    )(report(), 'mac-macstadium-us-001');
    await vi.waitFor(() => expect(store.get('agt_1')).not.toBeNull());

    expect(store.get('agt_1')).toMatchObject({
      webkit_framework_sha256: FRAMEWORKS,
      webkit_fork_build: '4410edcd9',
      reporting_node_id: 'mac-macstadium-us-001',
    });
    expect(store.entries()).toEqual([
      {
        sessionId: 'agt_1',
        report: expect.objectContaining({ reporting_node_id: 'mac-macstadium-us-001' }),
      },
    ]);
  });

  it('CRITICAL absent stays absent — never a placeholder digest', () => {
    const store = new SessionCapabilityReportStore();
    store.set(report({ webkitFrameworkSha256: undefined, webkitForkBuild: undefined }));
    expect(store.get('agt_1')).toMatchObject({
      webkit_framework_sha256: null,
      webkit_fork_build: null,
      // No reporting node was supplied, so the session is unattributable rather
      // than attributed to a guess.
      reporting_node_id: null,
    });
  });

  it('NEGATIVE CONTROL — a dropped (non-owner) frame stores nothing at all', async () => {
    const store = new SessionCapabilityReportStore();
    const ingest = vi.fn((_args: unknown) => Promise.resolve());
    relayWith(store, ingest)(report(), 'some-other-node');
    await vi.waitFor(() => expect(store.get('agt_1')).toBeNull());
    expect(ingest).not.toHaveBeenCalled();
  });
});
