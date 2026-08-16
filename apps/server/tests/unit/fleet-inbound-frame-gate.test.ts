import { describe, expect, it, vi } from 'vitest';
import {
  FLEET_INBOUND_BYTE_BURST,
  FLEET_INBOUND_FRAME_BURST,
  FLEET_INBOUND_LARGE_FRAME_BURST,
  FleetInboundFrameBudget,
  readLargeDownloadResultHeader,
} from '../../src/services/fleet-inbound-frame-gate.js';
import { FleetControlRegistry } from '../../src/services/fleet-control-registry.js';
import { HARNESS_FRAME_ID_MAX_LENGTH } from '../../src/schemas/harness-control-protocol.js';

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

  it('CRITICAL bounds the DECODED id length, not just the frame bytes', () => {
    // The gate bounds correlation ids twice: a cheap byte precheck that rejects
    // anything longer than six bytes per allowed character, and a decoded-length
    // check after parsing. Only the second one enforces the declared limit —
    // a plain-ASCII id of 300 characters is 302 bytes, comfortably under the
    // 1538-byte precheck, so the precheck waves it through.
    //
    // Nothing pinned the decoded check: deleting it left all 22,424 tests in the
    // only workspace that can reach this module green. Over-length ids would
    // then flow to the download correlator, six times past the bound the schema
    // declares for the same fields.
    const frame = (over: Partial<{ requestId: string; sessionId: string }>) =>
      Buffer.from(
        JSON.stringify({
          type: 'downloadData',
          requestId: 'rq',
          sessionId: 'agt',
          dataB64: 'AAAA',
          ...over,
        }),
      );

    const atLimit = 'r'.repeat(HARNESS_FRAME_ID_MAX_LENGTH);
    const overLimit = 'r'.repeat(HARNESS_FRAME_ID_MAX_LENGTH + 1);

    // The boundary is the whole point: a test using a value far from it cannot
    // tell `<=` from `<`, and this bound is exactly where that distinction lives.
    expect(readLargeDownloadResultHeader(frame({ requestId: atLimit }))).toEqual({
      requestId: atLimit,
      sessionId: 'agt',
    });
    expect(readLargeDownloadResultHeader(frame({ sessionId: atLimit }))).toEqual({
      requestId: 'rq',
      sessionId: atLimit,
    });

    // One character past it, and still far below the byte precheck, is refused.
    expect(frame({ requestId: overLimit }).length).toBeLessThan(
      HARNESS_FRAME_ID_MAX_LENGTH * 6 + 2,
    );
    expect(readLargeDownloadResultHeader(frame({ requestId: overLimit }))).toBeNull();
    expect(readLargeDownloadResultHeader(frame({ sessionId: overLimit }))).toBeNull();
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
