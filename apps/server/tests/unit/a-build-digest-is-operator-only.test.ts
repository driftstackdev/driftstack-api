// A3 2026-09-19 ~19:10Z — `webkitFrameworkSha256` is an OPERATOR fact: it
// identifies the digests of OUR fork's frameworks on OUR fleet. It tells a
// customer nothing about their own session, and it must not appear on any
// customer-visible surface.
//
// ⛔ THERE ARE TWO WAYS OUT OF THIS FRAME, AND BOTH NOW HAVE AN ALLOWLIST.
//   1. `SessionCapabilityReportStore` → `customerSafeCapabilityReport()` → the
//      agent-session read. That path has an explicit allowlist, and its header
//      says why: assigning the whole record used to make every internal field
//      public in the same commit that added it.
//   2. The relay's `const { type, ...raw } = frame` spread →
//      `sessions.egress_capability_report` → `publicSession()` on the public
//      sessions API. That path had NO allowlist: it was an opaque passthrough,
//      so declaring a key in the schema was by itself enough to publish it.
//
// ⚠️ UPDATED 2026-09-21 — PATH 2 IS NOW FILTERED AT THE EDGE, AND THAT MOVED
// WHAT THIS FILE ASSERTS. The relay used to destructure `webkitFrameworkSha256`
// out of `raw` by name. That was a denylist of one: it stopped the single key
// somebody had already thought of, left `webkitForkBuild` beside it on the
// customer API, and cost the stored row the measured digest AT REST — the only
// copy that outlives the process. (NOT the fleet drift report, which reads
// `capabilityReportStore.entries()` and was handed the whole frame all along;
// saying otherwise invites a reader to check the drift report, find the claim
// false, and throw out the real reason with it.)
// So the relay now stores the WHOLE frame and
// `customerSafeEgressCapabilityReport` allowlists the four public responses.
// The arms below assert the new shape: stored in full, absent from the public
// echo. Both paths are still covered, because a field kept out of one and not
// the other is still public.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/lib/logger.js';
import type { CapabilityReport } from '../../src/schemas/harness-control-protocol.js';
import { makeSessionCapabilityReportRelay } from '../../src/services/session-capability-report-relay.js';
import {
  SessionCapabilityReportStore,
  customerSafeCapabilityReport,
} from '../../src/services/session-capability-report-store.js';
import { customerSafeEgressCapabilityReport } from '../../src/services/customer-safe-egress-capability-report.js';

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
  it('CRITICAL the blob PERSISTED for operators keeps both build strings — filter at the edge, not at rest', async () => {
    // ⛔ THE INVERSION. This arm used to assert the OPPOSITE: that the relay
    // deleted `webkitFrameworkSha256` by name before storage. It is asserted the
    // other way now because filtering at rest was the wrong place — the fleet
    // drift report reads the measured digest off the stored row, and a row
    // filtered on the way in is a worse forensic record than the frame we
    // received, with no way to get it back. Only `type` is dropped: it names the
    // wire envelope, not the session.
    const store = new SessionCapabilityReportStore();
    const ingest = vi.fn((_args: unknown) => Promise.resolve());
    relayWith(store, ingest)(report(), 'mac-macstadium-us-001');
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));

    const persisted = ingest.mock.calls[0]?.[0] as { raw: Record<string, unknown> };
    expect(persisted.raw).toHaveProperty('webkitFrameworkSha256', FRAMEWORKS);
    expect(persisted.raw).toHaveProperty('webkitForkBuild', '4410edcd9');
    expect(persisted.raw).toHaveProperty('archetypeId');
    expect(persisted.raw).toHaveProperty('sessionId', 'agt_1');
    expect(persisted.raw).not.toHaveProperty('type');
  });

  it('CRITICAL neither build string survives the PUBLIC echo of that same stored blob', async () => {
    // The guarantee moved from the relay to the edge, so this is where it is
    // now proved: the exact bytes the relay persists, run through the one filter
    // every public session response uses.
    const store = new SessionCapabilityReportStore();
    const ingest = vi.fn((_args: unknown) => Promise.resolve());
    relayWith(store, ingest)(report(), 'mac-macstadium-us-001');
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
    const persisted = ingest.mock.calls[0]?.[0] as { raw: Record<string, unknown> };

    const published = customerSafeEgressCapabilityReport(persisted.raw);
    expect(published).not.toHaveProperty('webkitFrameworkSha256');
    // ⭐ AND `webkitForkBuild` GOES TOO. It rode this blob for months because
    // removing it was treated as a breaking change to a published response —
    // but the field is declared OPAQUE (`additionalProperties: {}`) in the
    // OpenAPI document, and the route's own comment tells consumers to prefer
    // the typed `egress_capabilities`, so narrowing what is inside it is not a
    // schema break. It names one of our checkouts; nothing customer-visible
    // says HOW.
    expect(published).not.toHaveProperty('webkitForkBuild');
    // VACUITY CONTROL — the filter still publishes. Without this the two arms
    // above pass against a function that returns an empty object.
    expect(published).toHaveProperty('proxyKind', 'socks5');
    expect(published).toHaveProperty('archetypeId');
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
