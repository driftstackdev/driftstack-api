// A3 2026-09-19 ~18:45Z / ~19:10Z — two additive MEASURED keys from the device:
// `harnessBinarySha256` on the heartbeat, and `webkitFrameworkSha256` on BOTH the
// heartbeat and every capability report.
//
// ⛔ THE FIRST QUESTION WAS WHETHER THIS REPO HAD BEEN SILENTLY DROPPING FRAMES
// SINCE 19:10Z. It had not, and this file pins why: neither payload schema calls
// `.strict()`, so an undeclared device key is STRIPPED, not rejected. That is the
// quieter failure of the two — the frame arrives, parses green, and the key is in
// the bin at the receiver — and it is what both keys were doing until this change.
//
// The leniency is pinned here as a FIRST-CLASS assertion because it is load-bearing
// for the device team's whole additive protocol: the day someone adds `.strict()`
// to either frame for tidiness, every node running ahead of the control plane loses
// its entire heartbeat or capability report, and the tell would be silence.

import { describe, expect, it } from 'vitest';
import {
  CapabilityReportSchema,
  HeartbeatSchema,
} from '../../src/schemas/harness-control-protocol.js';

const MEASURED = '88d2d0da2f01';
const FRAMEWORKS = 'wc:4410edcd9abc,wk:1122334455aa,jsc:99887766ddee';

function heartbeat(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'heartbeat',
    macNodeId: 'mac-macstadium-us-001',
    timestamp: '2026-09-19T18:45:00.000Z',
    cpuPercent: 11,
    memoryPercent: 42,
    activeSessionCount: 1,
    harnessVersion: '88d2d0da2',
    ...overrides,
  };
}

function capabilityReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'capabilityReport',
    sessionId: 'agt_x',
    timestamp: '2026-09-19T19:10:00.000Z',
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
    webkitForkBuild: '4410edcd9',
    ...overrides,
  };
}

describe('the measured build digests survive decode', () => {
  it('CRITICAL the heartbeat carries BOTH measured digests through', () => {
    // Fails against the pre-change schema: zod's default object stripped both,
    // so the values reached the fleet registry as `undefined` and the panel could
    // only ever show the declared string that was already known to be wrong.
    const parsed = HeartbeatSchema.safeParse(
      heartbeat({ harnessBinarySha256: MEASURED, webkitFrameworkSha256: FRAMEWORKS }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.harnessBinarySha256).toBe(MEASURED);
    expect(parsed.data.webkitFrameworkSha256).toBe(FRAMEWORKS);
    expect(parsed.data.harnessVersion, 'the declared value is untouched').toBe('88d2d0da2');
  });

  it('CRITICAL the capability report carries the session’s measured frameworks through', () => {
    const parsed = CapabilityReportSchema.safeParse(
      capabilityReport({ webkitFrameworkSha256: FRAMEWORKS }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.webkitFrameworkSha256).toBe(FRAMEWORKS);
    expect(parsed.data.webkitForkBuild, 'the declared value is untouched').toBe('4410edcd9');
  });

  it('CRITICAL an older node that sends neither key still decodes, unchanged', () => {
    // Omit-when-nil on the producer. A beat from a harness that predates both keys
    // must be byte-identical in effect to what it was before this change.
    const beat = HeartbeatSchema.safeParse(heartbeat());
    expect(beat.success).toBe(true);
    if (!beat.success) return;
    expect(beat.data.harnessBinarySha256).toBeUndefined();
    expect(beat.data.webkitFrameworkSha256).toBeUndefined();

    const report = CapabilityReportSchema.safeParse(capabilityReport());
    expect(report.success).toBe(true);
    if (!report.success) return;
    expect(report.data.webkitFrameworkSha256).toBeUndefined();
  });

  it('CRITICAL a malformed digest is carried, never fatal — the frame must survive', () => {
    // A value that is not a digest is the decoder's problem, not the socket's.
    // Rejecting here would delete the cpu/memory/session counts of a device whose
    // only fault is that it could not read one file properly.
    const beat = HeartbeatSchema.safeParse(
      heartbeat({ harnessBinarySha256: 'NOT-A-DIGEST', webkitFrameworkSha256: 'wc:x' }),
    );
    expect(beat.success, 'a bad digest must not delete the beat').toBe(true);
    if (!beat.success) return;
    expect(beat.data.cpuPercent).toBe(11);
    expect(beat.data.harnessBinarySha256).toBe('NOT-A-DIGEST');
    expect(beat.data.webkitFrameworkSha256).toBe('wc:x');
  });

  it('CRITICAL a value that is not even a bounded string degrades to ABSENT, not fatal', () => {
    const beat = HeartbeatSchema.safeParse(
      heartbeat({ harnessBinarySha256: 12345, webkitFrameworkSha256: 'w'.repeat(5000) }),
    );
    expect(beat.success).toBe(true);
    if (!beat.success) return;
    expect(beat.data.harnessBinarySha256).toBeUndefined();
    expect(beat.data.webkitFrameworkSha256).toBeUndefined();
    expect(beat.data.activeSessionCount, 'the rest of the beat is intact').toBe(1);
  });
});

describe('the unknown-key policy these frames depend on', () => {
  it('CRITICAL the heartbeat STRIPS an undeclared device key — it does not reject the frame', () => {
    // The device team ships keys ahead of this repo by design ("your HeartbeatSchema
    // strips unknown keys, so nothing breaks until you declare it"). If this ever
    // reds, the fleet has been losing whole beats from every node running ahead.
    const parsed = HeartbeatSchema.safeParse(
      heartbeat({ someKeyTheDeviceShipsNext: 'x', anotherOne: { nested: true } }),
    );
    expect(parsed.success, 'an additive device key must never delete a heartbeat').toBe(true);
    if (!parsed.success) return;
    expect(Object.keys(parsed.data)).not.toContain('someKeyTheDeviceShipsNext');
  });

  it('CRITICAL the capability report STRIPS an undeclared device key too', () => {
    const parsed = CapabilityReportSchema.safeParse(
      capabilityReport({ someKeyTheDeviceShipsNext: 'x' }),
    );
    expect(parsed.success, 'an additive device key must never delete a capability report').toBe(
      true,
    );
    if (!parsed.success) return;
    expect(Object.keys(parsed.data)).not.toContain('someKeyTheDeviceShipsNext');
  });

  it('VACUITY CONTROL — a genuinely malformed frame is still rejected', () => {
    // Without this, the leniency arms above would pass against a schema loosened
    // into accepting anything, which is a far worse defect than the one they guard.
    expect(HeartbeatSchema.safeParse(heartbeat({ cpuPercent: 'hot' })).success).toBe(false);
    expect(CapabilityReportSchema.safeParse(capabilityReport({ sessionId: 123 })).success).toBe(
      false,
    );
  });
});
