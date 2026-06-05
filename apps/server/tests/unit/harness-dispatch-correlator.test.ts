// Increment-2 — unit tests for IntentDispatchCorrelator (the WSS sender's
// transport-agnostic correlation + timeout core). Pins the A3 W106 contract:
// 1:1 intentId correlation, fast-fail on intent_dispatch_no_session, per-intent
// timeout max(30s, cap+15s), idempotent settle, never-rejects.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IntentDispatchCorrelator,
  dispatchTimeoutMs,
  DISPATCH_TIMEOUT_BASE_MS,
  type DispatchTransport,
} from '../../src/services/harness-dispatch-correlator.js';
import { encodeWireData } from '../../src/services/harness-control-codec.js';
import type {
  IntentDispatch,
  HarnessIntentName,
} from '../../src/schemas/harness-control-protocol.js';

function dispatch(
  intentId: string,
  intentName: HarnessIntentName,
  params: Record<string, unknown> = {},
  sessionId = 'ses_x',
): IntentDispatch {
  return {
    type: 'intentDispatch',
    sessionId,
    intentId,
    intentName,
    inputParams: encodeWireData(params),
  };
}

function recorder(): { transport: DispatchTransport; sent: IntentDispatch[] } {
  const sent: IntentDispatch[] = [];
  return { transport: { send: (d) => sent.push(d) }, sent };
}

describe('dispatchTimeoutMs', () => {
  it('is 30s for fast intents', () => {
    for (const n of [
      'navigate',
      'click',
      'send_keys',
      'scroll',
      'screenshot',
    ] as HarnessIntentName[]) {
      expect(dispatchTimeoutMs(n)).toBe(DISPATCH_TIMEOUT_BASE_MS);
    }
  });
  it('is cap+15s (315s) for behavioral_pause and wait_for', () => {
    expect(dispatchTimeoutMs('behavioral_pause')).toBe(300_000 + 15_000);
    expect(dispatchTimeoutMs('wait_for')).toBe(300 * 1000 + 15_000);
  });
});

describe('IntentDispatchCorrelator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends the dispatch + correlates the IntentResult by intentId', async () => {
    const { transport, sent } = recorder();
    const c = new IntentDispatchCorrelator(transport);
    const d = dispatch('int_1', 'navigate', { url: 'https://x' });
    const p = c.dispatch(d);
    expect(sent).toEqual([d]);
    expect(c.inFlight()).toBe(1);
    c.onResultFrame({
      type: 'intentResult',
      sessionId: 'ses_x',
      intentId: 'int_1',
      success: true,
      durationMs: 7,
      outputData: encodeWireData({ url: 'https://x' }),
    });
    const r = await p;
    expect(r.success).toBe(true);
    expect(r.outputData).toEqual({ url: 'https://x' });
    expect(c.inFlight()).toBe(0);
  });

  it('correlates by intentId across interleaved dispatches', async () => {
    const { transport } = recorder();
    const c = new IntentDispatchCorrelator(transport);
    const p1 = c.dispatch(dispatch('a', 'navigate', { url: 'https://1' }));
    const p2 = c.dispatch(dispatch('b', 'screenshot'));
    // Resolve out of order.
    c.onResultFrame({
      type: 'intentResult',
      sessionId: 'ses_x',
      intentId: 'b',
      success: true,
      durationMs: 1,
    });
    c.onResultFrame({
      type: 'intentResult',
      sessionId: 'ses_x',
      intentId: 'a',
      success: true,
      durationMs: 1,
    });
    expect((await p1).intentId).toBe('a');
    expect((await p2).intentId).toBe('b');
  });

  it('times out a fast intent at 30s with a synthesized intent_dispatch_error', async () => {
    const { transport } = recorder();
    const c = new IntentDispatchCorrelator(transport);
    const p = c.dispatch(dispatch('int_1', 'navigate', { url: 'https://x' }));
    await vi.advanceTimersByTimeAsync(DISPATCH_TIMEOUT_BASE_MS);
    const r = await p;
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('intent_dispatch_error');
    expect(r.errorMessage).toMatch(/timed out after 30000ms/);
    expect(c.inFlight()).toBe(0);
  });

  it('does not time out behavioral_pause before its 315s ceiling', async () => {
    const { transport } = recorder();
    const c = new IntentDispatchCorrelator(transport);
    const p = c.dispatch(dispatch('int_1', 'behavioral_pause', { duration_ms: 300_000 }));
    await vi.advanceTimersByTimeAsync(300_000); // past 30s, before 315s
    expect(c.inFlight()).toBe(1);
    c.onResultFrame({
      type: 'intentResult',
      sessionId: 'ses_x',
      intentId: 'int_1',
      success: true,
      durationMs: 300_000,
      outputData: encodeWireData({ paused_ms: 300_000, capped: false }),
    });
    expect((await p).success).toBe(true);
  });

  it('fast-fails on intent_dispatch_no_session SessionStatus (no timeout wait)', async () => {
    const { transport } = recorder();
    const c = new IntentDispatchCorrelator(transport);
    const p = c.dispatch(dispatch('int_1', 'navigate', { url: 'https://x' }));
    c.onSessionError('ses_x', 'intent_dispatch_no_session: navigate');
    const r = await p;
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('intent_session_not_established');
    expect(r.errorMessage).toBe('intent_dispatch_no_session: navigate');
    expect(c.inFlight()).toBe(0);
  });

  it('ignores SessionStatus errors for other sessions / non-no-session details', async () => {
    const { transport } = recorder();
    const c = new IntentDispatchCorrelator(transport);
    const p = c.dispatch(dispatch('int_1', 'navigate', { url: 'https://x' }, 'ses_x'));
    c.onSessionError('ses_OTHER', 'intent_dispatch_no_session: navigate'); // different session
    c.onSessionError('ses_x', 'some_other_error'); // not a no-session error
    expect(c.inFlight()).toBe(1);
    c.onResultFrame({
      type: 'intentResult',
      sessionId: 'ses_x',
      intentId: 'int_1',
      success: true,
      durationMs: 1,
    });
    expect((await p).success).toBe(true);
  });

  it('synthesizes a typed failure on malformed outputData rather than throwing', async () => {
    const { transport } = recorder();
    const c = new IntentDispatchCorrelator(transport);
    const p = c.dispatch(dispatch('int_1', 'navigate', { url: 'https://x' }));
    expect(() =>
      c.onResultFrame({
        type: 'intentResult',
        sessionId: 'ses_x',
        intentId: 'int_1',
        success: true,
        durationMs: 1,
        outputData: Buffer.from('not json', 'utf8').toString('base64'),
      }),
    ).not.toThrow();
    const r = await p;
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('intent_dispatch_error');
    expect(r.errorMessage).toMatch(/malformed/);
  });

  it('ignores non-IntentResult frames + results for unknown/settled ids (idempotent)', async () => {
    const { transport } = recorder();
    const c = new IntentDispatchCorrelator(transport);
    const p = c.dispatch(dispatch('int_1', 'navigate', { url: 'https://x' }));
    c.onResultFrame({ totally: 'not a result' }); // ignored
    c.onResultFrame({
      type: 'intentResult',
      sessionId: 'ses_x',
      intentId: 'UNKNOWN',
      success: true,
      durationMs: 1,
    }); // no pending
    expect(c.inFlight()).toBe(1);
    c.onResultFrame({
      type: 'intentResult',
      sessionId: 'ses_x',
      intentId: 'int_1',
      success: true,
      durationMs: 1,
    });
    await p;
    // A duplicate result for the now-settled id is a harmless no-op.
    expect(() =>
      c.onResultFrame({
        type: 'intentResult',
        sessionId: 'ses_x',
        intentId: 'int_1',
        success: true,
        durationMs: 1,
      }),
    ).not.toThrow();
    expect(c.inFlight()).toBe(0);
  });

  it('failAll fails every in-flight dispatch (connection drop)', async () => {
    const { transport } = recorder();
    const c = new IntentDispatchCorrelator(transport);
    const p1 = c.dispatch(dispatch('a', 'navigate', { url: 'https://1' }));
    const p2 = c.dispatch(dispatch('b', 'screenshot', {}, 'ses_y'));
    c.failAll('control connection dropped');
    for (const r of [await p1, await p2]) {
      expect(r.success).toBe(false);
      expect(r.errorCode).toBe('intent_dispatch_error');
      expect(r.errorMessage).toBe('control connection dropped');
    }
    expect(c.inFlight()).toBe(0);
  });
});
