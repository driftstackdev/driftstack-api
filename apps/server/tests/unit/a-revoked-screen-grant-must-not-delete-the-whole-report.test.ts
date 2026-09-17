// A node whose macOS Screen-Recording grant has been revoked reports
// `streamingState: "permission_denied"` — a value the device emits deliberately
// and distinctly, "a real TCC denial, distinct from transient failed".
//
// ⛔ THE CONTROL PLANE'S ENUM DID NOT CARRY IT, AND — UNIQUELY AMONG ITS
// NEIGHBOURS — THE FIELD HAD NO `.catch`. So the value failed the enum and zod
// rejected the ENVELOPE rather than the field. On the one failure where the video
// is guaranteed black, the control plane lost the ENTIRE capability report:
// `egressState` (including the dead-proxy signal), `exitIp`, `manualInputAvailable`,
// the safeguard checks and the h3 observations all rode the same frame.
//
// The schema's own comment, three lines above the enum, says of those exact
// fields: "never strip them: the registry relay drives the installed GUI and
// persistence from this data". A revoked grant stripped all of them, silently.
//
// ⚠️ THE `.catch` IS THE LOAD-BEARING HALF. Adding the member fixes the state we
// know about; the catch fixes the next one the device invents. Every sibling field
// already degrades a bad value to "not reported" and says why — "the bad field
// alone is discarded rather than the whole capability report" — and this field was
// the exception.

import { describe, expect, it } from 'vitest';
import { CapabilityReportSchema } from '../../src/schemas/harness-control-protocol.js';

function frame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'capabilityReport',
    sessionId: 'agt_x',
    timestamp: '2026-09-17T00:00:00.000Z',
    egressPhase: 'phase_1_socks5',
    proxyKind: 'socks5',
    proxyUdpSupported: true,
    proxyIpv4Supported: true,
    proxyIpv6Supported: false,
    transportModeRequested: 'h2-and-h3',
    transportModeActive: 'h2-and-h3',
    h3InterposeLoaded: true,
    httpsSkipActive: true,
    safeguardChecks: [{ layer: 'network_firewall', passed: true, timestamp: 't' }],
    archetypeId: 'iphone16pro_ios18_6_safari18_6',
    manualInputAvailable: true,
    egressState: 'dead_proxy',
    ...overrides,
  };
}

describe('a revoked screen-capture grant must not delete the whole capability report', () => {
  it('CRITICAL the frame PARSES and every sibling field survives', () => {
    const parsed = CapabilityReportSchema.safeParse(frame({ streamingState: 'permission_denied' }));
    expect(parsed.success, 'the envelope must not be rejected for one enum value').toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.streamingState).toBe('permission_denied');
    // ⛔ The point of the arm is the NEIGHBOURS, not the field itself. These are
    // what a revoked grant used to take down with it, and `dead_proxy` in
    // particular is a signal the operator needs on exactly this session.
    expect(parsed.data.egressState, 'the dead-proxy signal rode the same frame').toBe('dead_proxy');
    expect(parsed.data.manualInputAvailable).toBe(true);
    expect(parsed.data.safeguardChecks).toHaveLength(1);
  });

  it('CRITICAL an UNKNOWN future streaming state drops the FIELD, never the frame', () => {
    // The member fixes today; the catch fixes the next state the device invents.
    // A value nobody here has heard of must degrade to "not reported" — the same
    // leniency every sibling field already has.
    const parsed = CapabilityReportSchema.safeParse(
      frame({ streamingState: 'some_state_invented_later' }),
    );
    expect(parsed.success, 'an unknown value must not reject the envelope').toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.streamingState, 'unknown degrades to not-reported').toBeUndefined();
    expect(parsed.data.egressState).toBe('dead_proxy');
  });

  it('VACUITY CONTROL — a genuinely malformed frame is still rejected', () => {
    // Without this, both arms above would pass against a schema that had been
    // loosened into accepting anything, which would be a far worse defect than
    // the one being fixed: the leniency is per-FIELD and deliberate, not blanket.
    expect(CapabilityReportSchema.safeParse(frame({ sessionId: 123 })).success).toBe(false);
    expect(CapabilityReportSchema.safeParse({ type: 'capabilityReport' }).success).toBe(false);
  });

  it('the four pre-existing states still parse, so widening broke nothing', () => {
    for (const state of ['provisioning', 'live', 'blank', 'failed'] as const) {
      const parsed = CapabilityReportSchema.safeParse(frame({ streamingState: state }));
      expect(parsed.success, `${state} must still parse`).toBe(true);
      if (parsed.success) expect(parsed.data.streamingState).toBe(state);
    }
  });
});
