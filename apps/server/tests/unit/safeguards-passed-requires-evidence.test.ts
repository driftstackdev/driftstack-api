// `safeguards_passed` is a claim about evidence, so it needs some.
//
// A harness sends a capability report carrying `safeguardChecks`. The store
// derived the customer-visible `safeguards_passed` from
// `frame.safeguardChecks.every((check) => check.passed)` — and `every` on an
// EMPTY array is `true`. A frame with no checks at all therefore reported
// `safeguards_passed: true`: a positive safety claim asserted from no evidence,
// and indistinguishable to a customer from every check having run and passed.
//
// The empty frame was reachable, not theoretical. The protocol schema declares
// `safeguardChecks: z.array(...).max(16)` with no `.min(1)`, so `[]` validates
// cleanly — an older node, a fork that skipped its checks, or a harness bug all
// produce it. And the relay's warning loop iterates the same array, so the empty
// case produced ZERO warnings as well. True flag, no warnings: identical to a
// verified healthy session on both channels at once.
//
// `safeguards_passed` is customer-visible. It is `z.boolean()` in `api-types`
// and a typed field on the TypeScript SDK's agent-session response, so this is
// what a customer reads to decide whether a session's safety layers held.
//
// The fix is deliberately conservative in the direction the field is about. With
// no checks the flag is false and the relay emits `safeguards_unreported`, so
// "we do not know" stays distinguishable from `safeguard_failed:<layer>`. False
// alone would read as a failure that did not happen; true alone was a claim that
// was never established. The pair says exactly what is known.
//
// This DOES change what an older node's session reports — from a confident true
// to false plus a warning. That is the point: the true was never earned.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/lib/logger.js';
import type { CapabilityReport } from '../../src/schemas/harness-control-protocol.js';
import { makeSessionCapabilityReportRelay } from '../../src/services/session-capability-report-relay.js';
import { SessionCapabilityReportStore } from '../../src/services/session-capability-report-store.js';

/** A frame healthy in every respect except the checks under test. */
function report(overrides: Partial<CapabilityReport> = {}): CapabilityReport {
  return {
    type: 'capabilityReport',
    sessionId: 'agt_1',
    timestamp: '2026-08-13T00:00:00.000Z',
    egressPhase: 'phase_1_socks5',
    proxyKind: 'socks5',
    proxyUdpSupported: true,
    proxyIpv4Supported: true,
    proxyIpv6Supported: false,
    transportModeRequested: 'h2-only',
    transportModeActive: 'h2-only',
    h3InterposeLoaded: false,
    httpsSkipActive: false,
    safeguardChecks: [{ layer: 'dns', passed: true, timestamp: 't' }],
    archetypeId: 'iphone16pro_ios18_6_safari18_6',
    ...overrides,
  };
}

function logger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

/** Drive the real relay and return the derived warnings it published. */
async function warningsFor(frame: CapabilityReport): Promise<string[]> {
  const store = new SessionCapabilityReportStore();
  const ingest = vi.fn((_args: unknown) => Promise.resolve());
  const relay = makeSessionCapabilityReportRelay(
    {
      get: vi.fn(() =>
        Promise.resolve({
          nodeId: 'node-1',
          driftstackSessionId: 'ses_1',
          status: 'active',
          accountId: 'acc_1',
          proxyId: null,
        }),
      ),
    },
    { ingestEgressCapabilityReport: ingest },
    store,
    logger(),
  );
  relay(frame, 'node-1');
  await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
  const call = ingest.mock.calls[0]?.[0] as { derived: { warnings: string[] } };
  return call.derived.warnings;
}

const CHECK = (layer: string, passed: boolean): CapabilityReport['safeguardChecks'][number] => ({
  layer,
  passed,
  timestamp: 't',
});

describe('safeguards_passed requires evidence', () => {
  it('CRITICAL no checks means NOT passed. `every` on an empty array is true, so the previous derivation reported a safety property verified having verified nothing — and the schema allows an empty array, so any node that skips its checks produced exactly that.', () => {
    const store = new SessionCapabilityReportStore();
    store.set(report({ safeguardChecks: [] }));
    expect(store.get('agt_1')?.safeguards_passed, 'zero checks is not a pass').toBe(false);
  });

  it('CRITICAL a real pass still passes. Fail-closed is only correct if it does not also refuse the honest case — a change that made this field permanently false would be a different lie.', () => {
    const store = new SessionCapabilityReportStore();
    store.set(report({ safeguardChecks: [CHECK('dns', true), CHECK('tls', true)] }));
    expect(store.get('agt_1')?.safeguards_passed, 'checks ran and all passed').toBe(true);
  });

  it('CRITICAL one failed check still fails the set. The fix must not weaken the case the field already handled correctly.', () => {
    const store = new SessionCapabilityReportStore();
    store.set(report({ safeguardChecks: [CHECK('dns', true), CHECK('tls', false)] }));
    expect(store.get('agt_1')?.safeguards_passed, 'any failure fails the set').toBe(false);
  });

  it('CRITICAL an empty list is REPORTED, not merely disbelieved. The relay iterates the same array, so before this the empty case emitted no warning either — a false flag with no explanation reads as a failure that never happened.', async () => {
    const warnings = await warningsFor(report({ safeguardChecks: [] }));
    expect(warnings, 'the unknown state is named').toContain('safeguards_unreported');
    expect(
      warnings.filter((w) => w.startsWith('safeguard_failed:')),
      'and is not reported as a failed check',
    ).toEqual([]);
  });

  it('CRITICAL the two negative cases stay distinguishable. One names the layer that failed; the other says nothing was measured. Collapsing them would make a silent node look like a broken one, or the reverse.', async () => {
    const failed = await warningsFor(report({ safeguardChecks: [CHECK('tls', false)] }));
    expect(failed, 'the failing layer is named').toContain('safeguard_failed:tls');
    expect(failed, 'and this is not the unknown state').not.toContain('safeguards_unreported');

    const passed = await warningsFor(report({ safeguardChecks: [CHECK('tls', true)] }));
    expect(passed, 'a healthy frame reports neither').not.toContain('safeguards_unreported');
    expect(passed.filter((w) => w.startsWith('safeguard_failed:'))).toEqual([]);
  });

  it('CRITICAL the protocol still permits the empty frame this guards against. If the schema ever required a check, the derivation above would be unreachable — and a guard for an impossible input is one nobody maintains.', async () => {
    const mod = (await import('../../src/schemas/harness-control-protocol.js')) as unknown as {
      CapabilityReportSchema: { safeParse: (v: unknown) => { success: boolean } };
    };
    const parsed = mod.CapabilityReportSchema.safeParse(report({ safeguardChecks: [] }));
    expect(parsed.success, 'an empty safeguardChecks array validates').toBe(true);
  });
});
