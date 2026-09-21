// `egress_capabilities.safeguards` — the tri-state customer answer to "did my
// egress safeguards hold" — is DELIBERATELY STRICTER than the existing
// `safeguards_passed` boolean on the agent-session projection.
//
// `safeguardsPassed()` (session-capability-report-store.ts) returns `true`
// once every REPORTED check has passed, even when the device declared no
// expected set at all — documented there as "the strongest honest claim
// available" for a boolean that has to answer from one report alone. A
// customer tri-state cannot make that claim: an undeclared expected set means
// completeness was never checkable. `deriveSafeguardsTriState`
// (session-capability-report-relay.ts) therefore reads `unverified` for
// exactly the population where the boolean reads `true` — the two fields
// answer different questions ("did every check we heard about pass" vs. "is
// nothing missing") and are allowed to disagree.
//
// This file pins that stricter behaviour end to end, through the REAL relay
// (not a hand-rolled reimplementation of the rule), the same way
// `safeguards-passed-requires-evidence.test.ts` pins the boolean's own rule.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/lib/logger.js';
import type { CapabilityReport } from '../../src/schemas/harness-control-protocol.js';
import { makeSessionCapabilityReportRelay } from '../../src/services/session-capability-report-relay.js';
import { SessionCapabilityReportStore } from '../../src/services/session-capability-report-store.js';
import { customerSafeEgressCapabilities } from '../../src/services/customer-safe-egress-warnings.js';

/** A frame healthy in every respect except the checks under test — same
 *  fixture shape as safeguards-passed-requires-evidence.test.ts. */
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

const CHECK = (layer: string, passed: boolean): CapabilityReport['safeguardChecks'][number] => ({
  layer,
  passed,
  timestamp: 't',
});

/** Drive the real relay and return the whole derived object it published,
 *  plus the boolean the store computed for the SAME frame — so a test can
 *  compare the two fields for the same report in one place. */
async function deriveFor(
  frame: CapabilityReport,
): Promise<{ safeguards: string | undefined; safeguardsPassedBoolean: boolean | undefined }> {
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
      setFirstExitIpIfUnset: vi.fn(() => Promise.resolve(null)),
      closeWithReasonOutcome: vi.fn(() => Promise.resolve({ kind: 'already_closed' as const })),
      recordErrorEvent: vi.fn(() => Promise.resolve(null)),
    },
    { ingestEgressCapabilityReport: ingest },
    store,
    logger(),
  );
  relay(frame, 'node-1');
  await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
  const call = ingest.mock.calls[0]?.[0] as {
    derived: { safeguards?: string };
  };
  return {
    safeguards: call.derived.safeguards,
    safeguardsPassedBoolean: store.get('agt_1')?.safeguards_passed,
  };
}

describe('egress_capabilities.safeguards — the tri-state derivation', () => {
  it('CRITICAL "failed" — any failed check is failed, whatever the expected set says', async () => {
    const { safeguards } = await deriveFor(
      report({
        safeguardLayersExpected: ['dns', 'tls'],
        safeguardChecks: [CHECK('dns', true), CHECK('tls', false)],
      }),
    );
    expect(safeguards).toBe('failed');
  });

  it('CRITICAL "failed" takes precedence over "unverified" — a failure plus an undeclared expected set is still failed, not unverified', async () => {
    const { safeguards } = await deriveFor(
      report({ safeguardLayersExpected: undefined, safeguardChecks: [CHECK('dns', false)] }),
    );
    expect(safeguards).toBe('failed');
  });

  it('CRITICAL "passed" — every check passed, the device declared its expected set, and the reported set covers it', async () => {
    const { safeguards } = await deriveFor(
      report({
        safeguardLayersExpected: ['dns', 'tls'],
        safeguardChecks: [CHECK('dns', true), CHECK('tls', true)],
      }),
    );
    expect(safeguards).toBe('passed');
  });

  it('CRITICAL "unverified" — no checks reported at all', async () => {
    const { safeguards } = await deriveFor(report({ safeguardChecks: [] }));
    expect(safeguards).toBe('unverified');
  });

  it('CRITICAL "unverified" — the device declared an expected layer that never reported back', async () => {
    const { safeguards } = await deriveFor(
      report({
        safeguardLayersExpected: ['dns', 'tls', 'screen_recording'],
        safeguardChecks: [CHECK('dns', true), CHECK('tls', true)],
      }),
    );
    expect(safeguards).toBe('unverified');
  });

  it('CRITICAL THE STRICTER POPULATION — every reported check passed but the device declared NO expected set: the tri-state reads "unverified" while the agent-session boolean for the SAME frame reads true', async () => {
    const frame = report({
      safeguardLayersExpected: undefined,
      safeguardChecks: [CHECK('dns', true), CHECK('tls', true)],
    });
    const { safeguards, safeguardsPassedBoolean } = await deriveFor(frame);
    // The boolean makes the strongest honest claim it can from one report:
    // every check that DID report passed, so it reads true.
    expect(safeguardsPassedBoolean, 'the boolean is the strongest honest claim available').toBe(
      true,
    );
    // The tri-state cannot claim completeness was verified, because nothing
    // told it what "complete" looks like for this session.
    expect(
      safeguards,
      'the tri-state must not read passed for a session whose completeness was never declared',
    ).toBe('unverified');
    // This is the disagreement the design deliberately accepts: same frame,
    // two different — and both correct — answers to two different questions.
    expect(String(safeguardsPassedBoolean)).not.toBe(safeguards);
  });
});

describe('egress_capabilities.safeguards — an absent field is never defaulted', () => {
  it('CRITICAL a stored object with no `safeguards` key produces an output with no `safeguards` key — never `undefined`-but-present, never defaulted to "unverified"', () => {
    // The exact shape an OLD row carries: the key was never written, because
    // the column predates this field.
    const oldRow = {
      udp_associate: true,
      quic_route: 'proxy' as const,
      dns_remote_resolve: true,
      warnings: [] as string[],
    };
    const { capabilities } = customerSafeEgressCapabilities(oldRow);
    expect(capabilities).not.toBeNull();
    expect(Object.prototype.hasOwnProperty.call(capabilities, 'safeguards')).toBe(false);
    expect((capabilities as Record<string, unknown>).safeguards).toBeUndefined();
  });

  it('a stored object WITH a `safeguards` value carries it through verbatim, alongside the other untouched fields', () => {
    const newRow = {
      udp_associate: false,
      quic_route: 'disabled' as const,
      dns_remote_resolve: true,
      safeguards: 'failed' as const,
      warnings: [] as string[],
    };
    const { capabilities } = customerSafeEgressCapabilities(newRow);
    expect(capabilities).toMatchObject({
      udp_associate: false,
      quic_route: 'disabled',
      dns_remote_resolve: true,
      safeguards: 'failed',
    });
  });

  it.each(['passed', 'failed', 'unverified'] as const)(
    'a stored "%s" value rides straight through the mapper untouched',
    (value) => {
      const { capabilities } = customerSafeEgressCapabilities({
        udp_associate: true,
        quic_route: 'proxy',
        dns_remote_resolve: true,
        safeguards: value,
        warnings: [],
      });
      expect((capabilities as Record<string, unknown>).safeguards).toBe(value);
    },
  );
});
