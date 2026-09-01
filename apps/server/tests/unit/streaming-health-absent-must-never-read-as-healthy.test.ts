import { describe, expect, it } from 'vitest';
import { CapabilityReportSchema } from '../../src/schemas/harness-control-protocol.js';
import {
  customerSafeCapabilityReport,
  SessionCapabilityReportStore,
} from '../../src/services/session-capability-report-store.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * B-9 — the control-plane half of A3's per-session streaming telemetry.
 *
 * Seven degradation counters plus four measured video figures reached NOBODY
 * before this: each landed in the node's own stderr, Heartbeat carries host
 * health only, and no frame had anywhere to put them. So when the owner said
 * "the stream is choppy", the evidence existed on a box nobody reads.
 *
 * ⛔ Deliberately NOT carried on `safeguardChecks`, which is shaped to fit it.
 * `layer` is an open string, so the schema would have ACCEPTED a streaming
 * entry and only the meaning would have broken — the store computes
 * `safeguards_passed` with `.every(c => c.passed)` and the relay emits a
 * customer-visible `safeguard_failed:<layer>`, so one choppy stream would have
 * been reported as a session-wide safeguard failure.
 */

function frame(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'capabilityReport',
    sessionId: 'ses_health',
    timestamp: '2026-09-01T00:00:00Z',
    egressPhase: 'phase_1_socks5',
    proxyKind: 'socks5',
    proxyUdpSupported: true,
    proxyIpv4Supported: true,
    proxyIpv6Supported: false,
    h3InterposeLoaded: true,
    transportModeRequested: 'h2-and-h3',
    transportModeActive: 'h2-and-h3',
    httpsSkipActive: false,
    safeguardChecks: [{ layer: 'egress', passed: true, timestamp: '2026-09-01T00:00:00Z' }],
    archetypeId: 'iphone15',
    ...over,
  };
}

describe('streaming health: absent must never read as healthy', () => {
  it('accepts a full report and keeps every field', () => {
    const parsed = CapabilityReportSchema.safeParse(
      frame({
        streamingHealth: {
          subscribers: 1,
          framesPublished: 900,
          timestampClamps: 2,
          inputAcksDropped: 0,
          inputAckPublishFailures: 0,
          inboundDroppedNoReceiver: 3,
          inputStalls: 1,
          videoFpsMean: 29.7,
          videoFpsMin: 4,
          videoLossFractionMax: 0.021,
          videoRttMsMean: 48,
        },
      }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // fpsMin specifically: stutter is a minimum problem, and a stream averaging
    // 29.7 that dips to 4 looks fine in the mean and awful to the operator.
    expect(parsed.data.streamingHealth?.videoFpsMin).toBe(4);
    expect(parsed.data.streamingHealth?.videoLossFractionMax).toBeCloseTo(0.021);
  });

  it('⛔ an omitted field stays ABSENT — it is never defaulted to 0', () => {
    // A zero fps for a session nobody measured reads as a dead stream; a zero
    // stall count for the same session reads as a clean one. Both are claims
    // made from no evidence.
    const parsed = CapabilityReportSchema.safeParse(frame({ streamingHealth: { subscribers: 2 } }));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.streamingHealth?.subscribers).toBe(2);
    expect(parsed.data.streamingHealth?.videoFpsMin).toBeUndefined();
    expect(parsed.data.streamingHealth?.inputStalls).toBeUndefined();
  });

  it('an older node that omits the block entirely still validates', () => {
    // Additive on the wire: the flag is default-OFF harness-side, so the field
    // must be absent on every node until someone arms it.
    const parsed = CapabilityReportSchema.safeParse(frame());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.streamingHealth).toBeUndefined();
  });

  it('⛔ the store records null, NOT an object of zeroes', () => {
    const store = new SessionCapabilityReportStore();
    const parsed = CapabilityReportSchema.safeParse(frame());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    store.set(parsed.data);
    // null is readable as "we do not know". {} of zeroes is a health claim.
    expect(store.get('ses_health')?.streaming_health).toBeNull();
  });

  it('the store carries a real report through unchanged', () => {
    const store = new SessionCapabilityReportStore();
    const parsed = CapabilityReportSchema.safeParse(
      frame({ streamingHealth: { subscribers: 0, videoFpsMin: 0 } }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    store.set(parsed.data);
    // A MEASURED zero is real data and must survive — it is only an absent
    // field that means unknown.
    expect(store.get('ses_health')?.streaming_health).toEqual({ subscribers: 0, videoFpsMin: 0 });
  });

  it('rejects out-of-range values rather than storing nonsense', () => {
    for (const bad of [
      { subscribers: -1 },
      { videoLossFractionMax: 1.5 },
      { framesPublished: 1.5 },
      { videoFpsMean: -3 },
    ]) {
      expect(CapabilityReportSchema.safeParse(frame({ streamingHealth: bad })).success).toBe(false);
    }
  });
});

describe('an internal store field must not leak into the customer payload', () => {
  // ⛔ `GET /v1/agent-sessions/:id` assigned the WHOLE store record to
  // `capability_report`, so every field added for internal use silently became
  // part of a public API response. Leak-by-default: the safe case required
  // remembering, the unsafe case happened automatically.
  //
  // It fired immediately — adding `streaming_health` for operator diagnosis put
  // eleven harness counters into a customer payload in the same commit, and only
  // a shape test caught it. The projection is now an explicit allowlist.

  it('the customer projection drops streaming_health', () => {
    const store = new SessionCapabilityReportStore();
    const parsed = CapabilityReportSchema.safeParse(
      frame({ streamingHealth: { subscribers: 3, videoFpsMin: 2 } }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    store.set(parsed.data);
    const stored = store.get('ses_health');
    expect(stored?.streaming_health).toEqual({ subscribers: 3, videoFpsMin: 2 });

    const projected = customerSafeCapabilityReport(stored!);
    expect('streaming_health' in projected).toBe(false);
  });

  it('the projection names its fields explicitly rather than spreading', () => {
    // A spread would re-open the leak the moment anyone adds a field. Read the
    // source: the function must not use `...report`.
    const src = readFileSync(
      resolve(__dirname, '../../src/services/session-capability-report-store.ts'),
      'utf8',
    );
    const body = src.slice(src.indexOf('export function customerSafeCapabilityReport'));
    const fn = body.slice(0, body.indexOf('\n}'));
    expect(fn, 'the customer projection must be an allowlist, not a spread').not.toMatch(
      /\.\.\.\s*report/,
    );
    // And it must still carry the fields customers already depend on.
    for (const field of ['timestamp', 'streaming_state', 'egress_state', 'safeguards_passed']) {
      expect(fn).toContain(field);
    }
  });
});
