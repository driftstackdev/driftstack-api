// Increment-2 — unit tests for IntentDispatchCorrelator (the WSS sender's
// transport-agnostic correlation + timeout core). Pins the A3 W106 contract:
// 1:1 intentId correlation, fast-fail on intent_dispatch_no_session, per-intent
// timeout max(30s, cap+15s), idempotent settle, never-rejects.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IntentDispatchCorrelator,
  dispatchTimeoutMs,
  DISPATCH_TIMEOUT_BASE_MS,
  DISPATCH_NAVIGATION_BUDGET_MS,
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
  it('keeps only short read/key/script intents at the 30s loss-detection base', () => {
    for (const n of [
      'press_key',
      'execute_script',
      'detect_challenge',
      'extract',
      'screenshot',
      'get_page_source',
      'perceive',
    ] as HarnessIntentName[]) {
      expect(dispatchTimeoutMs(n)).toBe(DISPATCH_TIMEOUT_BASE_MS);
    }
  });

  it('uses the single 300s producer cap + 15s slack for bounded paced/wait intents', () => {
    for (const n of ['click', 'send_keys', 'behavioral_pause', 'wait_for'] as HarnessIntentName[]) {
      expect(dispatchTimeoutMs(n), n).toBe(315_000);
    }
  });

  it('allows search/login both a 300s typing phase and a separate 300s result wait plus slack', () => {
    for (const n of ['search', 'login'] as HarnessIntentName[]) {
      expect(dispatchTimeoutMs(n), n).toBe(615_000);
    }
  });

  it('keeps fill_form/scroll loss detection bounded at a documented provisional 315s', () => {
    for (const n of ['fill_form', 'scroll'] as HarnessIntentName[]) {
      expect(dispatchTimeoutMs(n), n).toBe(315_000);
    }
  });

  it('uses the 55s WebDriver navigation budget + 15s slack for navigate/history', () => {
    for (const n of ['navigate', 'back', 'forward'] as HarnessIntentName[]) {
      expect(dispatchTimeoutMs(n), n).toBe(DISPATCH_NAVIGATION_BUDGET_MS + 15_000);
    }
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
      outputData: encodeWireData({
        screenshot_b64: 'aGk=',
        format: 'png',
        full_page: false,
        annotated: false,
      }),
    });
    c.onResultFrame({
      type: 'intentResult',
      sessionId: 'ses_x',
      intentId: 'a',
      success: true,
      durationMs: 1,
      outputData: encodeWireData({ url: 'https://1' }),
    });
    expect((await p1).intentId).toBe('a');
    expect((await p2).intentId).toBe('b');
  });

  it('times out a fast intent at 30s with a synthesized intent_dispatch_error', async () => {
    const { transport } = recorder();
    const c = new IntentDispatchCorrelator(transport);
    const p = c.dispatch(dispatch('int_1', 'press_key', { key: 'Enter' }));
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
      outputData: encodeWireData({ paused_ms: 300_000, capped: false, behavioral: true }),
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
      outputData: encodeWireData({ url: 'https://x' }),
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
      outputData: encodeWireData({ url: 'https://x' }),
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

  it('DROPS a result whose sessionId disagrees with the pending dispatch (cross-session spoof guard) and leaves the pending entry for the legitimate result', async () => {
    const { transport } = recorder();
    const c = new IntentDispatchCorrelator(transport);
    // int_1 is in-flight for ses_A (its DOM/screenshot output must only settle
    // ses_A's dispatch).
    const p = c.dispatch(dispatch('int_1', 'get_page_source', {}, 'ses_A'));
    // A misrouted / id-echoed frame carrying ANOTHER session's output but the
    // same intentId must NOT settle int_1 (would leak ses_B's page into ses_A).
    c.onResultFrame({
      type: 'intentResult',
      sessionId: 'ses_B',
      intentId: 'int_1',
      success: true,
      durationMs: 1,
      // Deliberately invalid base64/result shape: the cross-session header must
      // be rejected before the payload is parsed.
      outputData: '***',
    });
    expect(c.inFlight()).toBe(1); // still pending — the spoof frame was dropped
    // The legitimate same-session result still settles it.
    c.onResultFrame({
      type: 'intentResult',
      sessionId: 'ses_A',
      intentId: 'int_1',
      success: true,
      durationMs: 2,
      outputData: encodeWireData({ source: '<html>ses_A</html>', truncated: false }),
    });
    const r = await p;
    expect(r.success).toBe(true);
    expect(r.outputData).toEqual({ source: '<html>ses_A</html>', truncated: false });
    expect(c.inFlight()).toBe(0);
  });

  it('settles a known same-session wrong-intent result as intent_dispatch_error', async () => {
    const { transport } = recorder();
    const c = new IntentDispatchCorrelator(transport);
    const p = c.dispatch(dispatch('int_shape', 'navigate', { url: 'https://x' }));
    c.onResultFrame({
      type: 'intentResult',
      sessionId: 'ses_x',
      intentId: 'int_shape',
      success: true,
      durationMs: 1,
      outputData: encodeWireData({ pressed: 'Enter' }),
    });
    const r = await p;
    expect(r).toMatchObject({ success: false, errorCode: 'intent_dispatch_error' });
    expect(c.inFlight()).toBe(0);
  });

  it('settles a known success missing outputData, but pre-decode ignores the same malformed unknown id', async () => {
    const { transport } = recorder();
    const c = new IntentDispatchCorrelator(transport);
    const p = c.dispatch(dispatch('int_missing', 'navigate', { url: 'https://x' }));
    c.onResultFrame({
      type: 'intentResult',
      sessionId: 'ses_x',
      intentId: 'unknown',
      success: true,
      durationMs: 1,
    });
    expect(c.inFlight()).toBe(1);
    c.onResultFrame({
      type: 'intentResult',
      sessionId: 'ses_x',
      intentId: 'int_missing',
      success: true,
      durationMs: 1,
    });
    expect(await p).toMatchObject({ success: false, errorCode: 'intent_dispatch_error' });
  });

  it('settles the live session_paused failure immediately with its retry signal intact', async () => {
    const { transport } = recorder();
    const c = new IntentDispatchCorrelator(transport);
    const p = c.dispatch(dispatch('int_paused', 'click', { element_id: 'el_1' }));
    c.onResultFrame({
      type: 'intentResult',
      sessionId: 'ses_x',
      intentId: 'int_paused',
      success: false,
      durationMs: 0,
      errorCode: 'session_paused',
      errorMessage: 'resume the session before retrying',
    });
    expect(await p).toMatchObject({ success: false, errorCode: 'session_paused' });
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

  it('a synchronously-throwing transport.send settles a uniform failure (never rejects) + leaks no timer/pending', async () => {
    // ws.send throws synchronously when the socket isn't OPEN (a dispatch racing a
    // remote close into CLOSING). dispatch() must still resolve with a failure —
    // the executor contract is never-rejects — and must not leak the timer/entry.
    const throwingTransport: DispatchTransport = {
      send: () => {
        throw new Error('WebSocket is not open: readyState 2 (CLOSING)');
      },
    };
    const c = new IntentDispatchCorrelator(throwingTransport);
    const r = await c.dispatch(dispatch('a', 'navigate', { url: 'https://1' }));
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('intent_dispatch_error');
    expect(r.errorMessage).toMatch(/dispatch send failed: .*CLOSING/);
    // No leak: the pending entry + its timer were cleared by settle().
    expect(c.inFlight()).toBe(0);
  });
});
