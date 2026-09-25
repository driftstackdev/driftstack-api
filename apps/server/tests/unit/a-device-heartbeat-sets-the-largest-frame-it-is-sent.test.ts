// A device's heartbeat sets the largest frame it is sent.
//
// Each device advertises `maxInboundFrameBytes` (an integer, bytes) on its
// heartbeat: the first beat goes out as soon as it connects or reconnects, and
// every beat after repeats it. The server keeps the value per connected device,
// replaces it on every beat, and falls back to the 4 MiB default that every
// device before the field used when it is absent — or when it is anything other
// than a positive integer. A heartbeat must never be DROPPED over this field:
// liveness, drain state and the session map ride the same frame.
//
// ⛔ Imports nothing the fix added: an unfixed tree fails on behaviour (the key
// stripped by the schema, the limit never read), not on a missing module.

import { describe, expect, it } from 'vitest';
import {
  FleetControlConnection,
  FleetControlRegistry,
} from '../../src/services/fleet-control-registry.js';
import { HeartbeatSchema } from '../../src/schemas/harness-control-protocol.js';

const NODE = 'node-heartbeat-limit-1';
const MIB = 1024 * 1024;
const MARGIN = 64 * 1024;
/** 4 MiB, the device default, minus the 64 KiB framing margin. */
const DEFAULT_LIMIT = 4 * MIB - MARGIN;
/** Advertised values are clamped to 256 MiB before the margin comes off. */
const CLAMPED_LIMIT = 256 * MIB - MARGIN;

function beat(extra: Record<string, unknown> = {}, macNodeId = NODE): Record<string, unknown> {
  return {
    type: 'heartbeat',
    macNodeId,
    timestamp: '2026-09-24T00:00:00Z',
    cpuPercent: 1,
    memoryPercent: 1,
    activeSessionCount: 0,
    ...extra,
  };
}

interface Limited {
  deviceFrameLimitBytes(): number;
}

function limitOf(conn: FleetControlConnection): number {
  return (conn as unknown as Limited).deviceFrameLimitBytes();
}

const INVALID: ReadonlyArray<[string, unknown]> = [
  ['zero', 0],
  ['negative', -4_194_304],
  ['a numeric string', '8388608'],
  ['a non-integer', 4_194_304.5],
  ['null', null],
  ['a boolean', true],
  ['an object', { bytes: 8_388_608 }],
];

describe('the heartbeat schema reads maxInboundFrameBytes', () => {
  it('CRITICAL keeps a positive integer', () => {
    const parsed = HeartbeatSchema.safeParse(beat({ maxInboundFrameBytes: 100_663_296 }));
    expect(parsed.success).toBe(true);
    expect((parsed.data as { maxInboundFrameBytes?: unknown }).maxInboundFrameBytes).toBe(
      100_663_296,
    );
  });

  for (const [label, value] of INVALID) {
    it(`CRITICAL ${label} is dropped as if absent — the heartbeat itself still parses`, () => {
      const parsed = HeartbeatSchema.safeParse(beat({ maxInboundFrameBytes: value }));
      expect(parsed.success, `a heartbeat carrying ${label} was refused whole`).toBe(true);
      expect(
        (parsed.data as { maxInboundFrameBytes?: unknown }).maxInboundFrameBytes,
      ).toBeUndefined();
    });
  }
});

describe('the connection keeps the latest advertised limit for its device', () => {
  it('CRITICAL before any heartbeat a device gets the 4 MiB default minus the margin', () => {
    const conn = new FleetControlConnection(NODE, () => {});
    expect(limitOf(conn)).toBe(DEFAULT_LIMIT);
  });

  for (const [label, value] of INVALID) {
    it(`CRITICAL a heartbeat advertising ${label} leaves the default in force`, () => {
      const conn = new FleetControlConnection(NODE, () => {});
      conn.handleInbound(JSON.stringify(beat({ maxInboundFrameBytes: 100_663_296 })));
      conn.handleInbound(JSON.stringify(beat({ maxInboundFrameBytes: value })));
      expect(limitOf(conn)).toBe(DEFAULT_LIMIT);
    });
  }

  it('CRITICAL the advertised value follows the latest heartbeat — up, down, and back to the default when a beat omits it', () => {
    const conn = new FleetControlConnection(NODE, () => {});
    conn.handleInbound(JSON.stringify(beat({ maxInboundFrameBytes: 100_663_296 })));
    expect(limitOf(conn)).toBe(100_663_296 - MARGIN);
    conn.handleInbound(JSON.stringify(beat({ maxInboundFrameBytes: 8 * MIB })));
    expect(limitOf(conn)).toBe(8 * MIB - MARGIN);
    // A beat without the field is a device that does not say — a rolled-back
    // build — so it gets what a device that does not say gets.
    conn.handleInbound(JSON.stringify(beat()));
    expect(limitOf(conn)).toBe(DEFAULT_LIMIT);
  });

  it('CRITICAL an absurd advertised value is clamped to 256 MiB before the margin', () => {
    const conn = new FleetControlConnection(NODE, () => {});
    conn.handleInbound(JSON.stringify(beat({ maxInboundFrameBytes: 2 ** 40 })));
    expect(limitOf(conn)).toBe(CLAMPED_LIMIT);
    conn.handleInbound(JSON.stringify(beat({ maxInboundFrameBytes: Number.MAX_SAFE_INTEGER })));
    expect(limitOf(conn)).toBe(CLAMPED_LIMIT);
  });

  it('CRITICAL a value at or under the margin leaves room for no frame at all, never a negative limit', () => {
    const conn = new FleetControlConnection(NODE, () => {});
    conn.handleInbound(JSON.stringify(beat({ maxInboundFrameBytes: 1 })));
    expect(limitOf(conn)).toBe(0);
  });

  it('CRITICAL a heartbeat naming ANOTHER device does not move this device’s limit', () => {
    const conn = new FleetControlConnection(NODE, () => {});
    conn.handleInbound(
      JSON.stringify(beat({ maxInboundFrameBytes: 100_663_296 }, 'some-other-node')),
    );
    expect(limitOf(conn)).toBe(DEFAULT_LIMIT);
  });

  it('CRITICAL the limit is per device, and a reconnect starts again from the default until its first beat', () => {
    const registry = new FleetControlRegistry();
    const a = registry.register('node-a', () => {});
    const b = registry.register('node-b', () => {});
    a.handleInbound(JSON.stringify(beat({ maxInboundFrameBytes: 100_663_296 }, 'node-a')));
    expect(limitOf(a)).toBe(100_663_296 - MARGIN);
    expect(limitOf(b)).toBe(DEFAULT_LIMIT);

    const a2 = registry.register('node-a', () => {});
    expect(limitOf(a2)).toBe(DEFAULT_LIMIT);
    a2.handleInbound(JSON.stringify(beat({ maxInboundFrameBytes: 16 * MIB }, 'node-a')));
    expect(limitOf(a2)).toBe(16 * MIB - MARGIN);
  });
});
