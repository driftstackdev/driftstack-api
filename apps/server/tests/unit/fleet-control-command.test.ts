// Fleet-admin (§A5) node-level control command frame (server → harness):
// serializeControlCommand builds + validates the envelope; FleetControlConnection
// .sendControlCommand pushes it over the node's WSS. The harness receiver half
// (A3, W2197) is built against this exact shape (A2-A3-BUS W2203).

import { describe, expect, it } from 'vitest';
import { serializeControlCommand } from '../../src/services/harness-control-codec.js';
import { FleetControlConnection } from '../../src/services/fleet-control-registry.js';
import { ControlCommandSchema } from '../../src/schemas/harness-control-protocol.js';

describe('serializeControlCommand', () => {
  it('builds a valid envelope with an optional reason', () => {
    expect(serializeControlCommand({ command: 'drain', reason: 'rolling restart' })).toEqual({
      type: 'controlCommand',
      command: 'drain',
      reason: 'rolling restart',
    });
  });

  it('omits reason when absent (no null/undefined key on the wire)', () => {
    const cmd = serializeControlCommand({ command: 'cordon' });
    expect(cmd).toEqual({ type: 'controlCommand', command: 'cordon' });
    expect('reason' in cmd).toBe(false);
  });

  it('accepts the full command set + rejects an unknown command', () => {
    for (const command of ['cordon', 'uncordon', 'drain', 'restart'] as const) {
      expect(serializeControlCommand({ command }).command).toBe(command);
    }
    expect(
      ControlCommandSchema.safeParse({ type: 'controlCommand', command: 'nuke' }).success,
    ).toBe(false);
  });
});

describe('FleetControlConnection.sendControlCommand', () => {
  it('serializes the command onto the node socket', () => {
    const sent: string[] = [];
    const conn = new FleetControlConnection('node-1', (d) => sent.push(d));
    conn.sendControlCommand(serializeControlCommand({ command: 'restart', reason: 'ops' }));
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toEqual({
      type: 'controlCommand',
      command: 'restart',
      reason: 'ops',
    });
  });
});
