import { describe, expect, it, vi } from 'vitest';
import {
  FLEET_INBOUND_BYTE_BURST,
  FLEET_INBOUND_FRAME_BURST,
  FLEET_INBOUND_LARGE_FRAME_BURST,
  FleetInboundFrameBudget,
  readLargeDownloadResultHeader,
} from '../../src/services/fleet-inbound-frame-gate.js';
import { FleetControlRegistry } from '../../src/services/fleet-control-registry.js';

describe('fleet inbound frame gate', () => {
  it('extracts only top-level correlation strings without depending on field order', () => {
    const raw = Buffer.from(
      JSON.stringify({
        dataB64: 'AAAA',
        nested: {
          type: 'downloadData',
          requestId: 'nested-decoy',
          sessionId: 'nested-decoy',
        },
        sessionId: 'agt_real',
        requestId: 'rq_real',
        type: 'downloadData',
      }),
    );
    expect(readLargeDownloadResultHeader(raw)).toEqual({
      requestId: 'rq_real',
      sessionId: 'agt_real',
    });
  });

  it('accepts bounded JSON escapes and whitespace in correlation headers', () => {
    const raw = Buffer.from(
      '{ "requestId" : "rq_\\u0031", "type" : "downloadData", "sessionId" : "agt_A", "dataB64" : "AAAA" }',
    );
    expect(readLargeDownloadResultHeader(raw)).toEqual({
      requestId: 'rq_1',
      sessionId: 'agt_A',
    });
  });

  it('fails closed on nested-only, duplicate, wrong-type, malformed, and trailing headers', () => {
    const frames = [
      { nested: { type: 'downloadData', requestId: 'rq', sessionId: 'agt' } },
      '{"type":"downloadData","type":"downloadData","requestId":"rq","sessionId":"agt"}',
      { type: 'intentResult', requestId: 'rq', sessionId: 'agt' },
      '{"type":"downloadData","requestId":"rq","sessionId":"agt"',
      '{"type":"downloadData","requestId":"rq","sessionId":"agt"} trailing',
      '{"type":"downloadData","requestId":"rq","sessionId":"agt",}',
      '{"type":"downloadData","requestId":"rq\\q","sessionId":"agt"}',
    ];
    for (const frame of frames) {
      const raw = Buffer.from(typeof frame === 'string' ? frame : JSON.stringify(frame));
      expect(readLargeDownloadResultHeader(raw)).toBeNull();
    }
  });

  it('bounds ordinary bytes and frame count independently, then refills over time', () => {
    let now = 1_000;
    const budget = new FleetInboundFrameBudget(() => now);

    expect(budget.admit('node-invalid', -1, false)).toBe(false);
    expect(budget.admit('node-invalid', Number.POSITIVE_INFINITY, false)).toBe(false);

    expect(budget.admit('node-bytes', FLEET_INBOUND_BYTE_BURST, false)).toBe(true);
    expect(budget.admit('node-bytes', 1, false)).toBe(false);
    now += 1_000;
    expect(budget.admit('node-bytes', 1, false)).toBe(true);

    for (let i = 0; i < FLEET_INBOUND_FRAME_BURST; i += 1) {
      expect(budget.admit('node-frames', 0, false)).toBe(true);
    }
    expect(budget.admit('node-frames', 0, false)).toBe(false);
    now += 1_000;
    expect(budget.admit('node-frames', 0, false)).toBe(true);
  });

  it('charges a correlated large download one frame but not its unavoidable body bytes', () => {
    const budget = new FleetInboundFrameBudget(() => 1_000);
    expect(budget.admit('node-large', 96 * 1024 * 1024, true)).toBe(true);
    expect(budget.admit('node-large', FLEET_INBOUND_BYTE_BURST, false)).toBe(true);
  });

  it('limits pre-correlation large-frame scans independently of ordinary traffic', () => {
    const budget = new FleetInboundFrameBudget(() => 1_000);
    for (let i = 0; i < FLEET_INBOUND_LARGE_FRAME_BURST; i += 1) {
      expect(budget.admit('node-large-scan', 96 * 1024 * 1024, true)).toBe(true);
    }
    expect(budget.admit('node-large-scan', 96 * 1024 * 1024, true)).toBe(false);
    expect(budget.admit('node-large-scan', 1, false)).toBe(true);
  });

  it('the production registry preserves a node frame budget across reconnects', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const registry = new FleetControlRegistry();
      const first = registry.register('node-reconnect', () => {});
      for (let i = 0; i < FLEET_INBOUND_FRAME_BURST; i += 1) {
        expect(first.handleInboundBytes(Buffer.from('{}'))).toBe('accepted');
      }
      const successor = registry.register('node-reconnect', () => {});
      expect(successor.handleInboundBytes(Buffer.from('{}'))).toBe('parse-budget-exhausted');
    } finally {
      clock.mockRestore();
    }
  });
});
