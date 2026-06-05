// Increment-2 — unit tests for ControlPlaneAgentExecutor: the plan runner that
// chains mapper → serialize → dispatcher → result-mapper, halting on the first
// failure. Uses a mock IntentDispatcher (the correlator is tested separately).

import { describe, expect, it } from 'vitest';
import {
  ControlPlaneAgentExecutor,
  type IntentDispatcher,
} from '../../src/services/agent-executor-control-plane.js';
import type { ExecuteArgs } from '../../src/services/agent-executor.js';
import {
  decodeWireData,
  type ParsedIntentResult,
} from '../../src/services/harness-control-codec.js';
import type { AgentIntent } from '@driftstack/api-types';
import type { IntentDispatch } from '../../src/schemas/harness-control-protocol.js';

function planArgs(intents: AgentIntent[], sessionId = 'ses_x'): ExecuteArgs {
  return { sessionId, plan: { kind: 'plan', intents, tokensConsumed: 0 } };
}

function okResult(intentId: string, sessionId = 'ses_x', outputData?: unknown): ParsedIntentResult {
  return { sessionId, intentId, success: true, durationMs: 1, outputData };
}
function failResult(
  intentId: string,
  errorCode: ParsedIntentResult['errorCode'],
  sessionId = 'ses_x',
): ParsedIntentResult {
  return { sessionId, intentId, success: false, durationMs: 0, errorCode };
}

/** Mock dispatcher: records dispatches, returns results via a per-call fn. */
function mockDispatcher(respond: (d: IntentDispatch, index: number) => ParsedIntentResult): {
  got: IntentDispatch[];
  dispatcher: IntentDispatcher;
} {
  const got: IntentDispatch[] = [];
  return {
    got,
    dispatcher: {
      dispatch: (d) => {
        const i = got.length;
        got.push(d);
        return Promise.resolve(respond(d, i));
      },
    },
  };
}

// Deterministic intentId generator for assertions.
function seqIds(): () => string {
  let n = 0;
  return () => `int_${++n}`;
}

describe('ControlPlaneAgentExecutor', () => {
  it('runs an all-success plan → every result success, ok:true', async () => {
    const { got, dispatcher } = mockDispatcher((d) =>
      okResult(d.intentId, d.sessionId, { url: 'https://x' }),
    );
    const exec = new ControlPlaneAgentExecutor(dispatcher, seqIds());
    const res = await exec.execute(
      planArgs([
        { kind: 'navigate', url: 'https://x' },
        { kind: 'interact', action: 'tap', selector: '#go' },
        { kind: 'capture', capture: 'screenshot' },
      ]),
    );
    expect(res.ok).toBe(true);
    expect(res.results).toHaveLength(3);
    expect(res.results.every((r) => r.kind === 'success')).toBe(true);
    // Dispatched the 3 mapped intents in order with the right intentNames.
    expect(got.map((d) => d.intentName)).toEqual(['navigate', 'click', 'screenshot']);
    expect(got.map((d) => d.sessionId)).toEqual(['ses_x', 'ses_x', 'ses_x']);
    // Params are base64-encoded on the wire.
    expect(decodeWireData(got[0]!.inputParams)).toEqual({ url: 'https://x' });
    expect(decodeWireData(got[1]!.inputParams)).toEqual({ strategy: 'css selector', value: '#go' });
  });

  it('halts on the first dispatch failure (later intents not dispatched)', async () => {
    const { got, dispatcher } = mockDispatcher((d, i) =>
      i === 1 ? failResult(d.intentId, 'intent_webdriver_failed') : okResult(d.intentId),
    );
    const exec = new ControlPlaneAgentExecutor(dispatcher, seqIds());
    const res = await exec.execute(
      planArgs([
        { kind: 'navigate', url: 'https://x' },
        { kind: 'interact', action: 'tap', selector: '#go' },
        { kind: 'capture', capture: 'screenshot' }, // must NOT be dispatched
      ]),
    );
    expect(res.ok).toBe(false);
    expect(res.results).toHaveLength(2);
    expect(res.results[0]!.kind).toBe('success');
    expect(res.results[1]!.kind).toBe('failure');
    expect(got).toHaveLength(2); // 3rd intent never dispatched
  });

  it('an unsupported intent fails WITHOUT dispatching + halts the plan', async () => {
    const { got, dispatcher } = mockDispatcher((d) => okResult(d.intentId));
    const exec = new ControlPlaneAgentExecutor(dispatcher, seqIds());
    const res = await exec.execute(
      planArgs([
        { kind: 'interact', action: 'swipe' }, // no harness intent → unsupported
        { kind: 'navigate', url: 'https://x' }, // must NOT run
      ]),
    );
    expect(res.ok).toBe(false);
    expect(res.results).toHaveLength(1);
    expect(res.results[0]!.kind).toBe('failure');
    if (res.results[0]!.kind !== 'failure') throw new Error('narrow');
    expect(res.results[0]!.reason).toMatch(/swipe has no harness intent/);
    expect(got).toHaveLength(0); // never reached the dispatcher
  });

  it('maps a dispatch failure to a customer failure reason', async () => {
    const { dispatcher } = mockDispatcher((d) =>
      failResult(d.intentId, 'intent_session_not_established'),
    );
    const exec = new ControlPlaneAgentExecutor(dispatcher, seqIds());
    const res = await exec.execute(planArgs([{ kind: 'navigate', url: 'https://x' }]));
    expect(res.ok).toBe(false);
    expect(res.results[0]!.kind).toBe('failure');
    if (res.results[0]!.kind !== 'failure') throw new Error('narrow');
    expect(res.results[0]!.reason).toContain('the browser session was not established');
  });

  it('empty plan → ok:true, no dispatches', async () => {
    const { got, dispatcher } = mockDispatcher((d) => okResult(d.intentId));
    const exec = new ControlPlaneAgentExecutor(dispatcher, seqIds());
    const res = await exec.execute(planArgs([]));
    expect(res.ok).toBe(true);
    expect(res.results).toHaveLength(0);
    expect(got).toHaveLength(0);
  });

  it('success summary carries the navigate url from outputData', async () => {
    const { dispatcher } = mockDispatcher((d) =>
      okResult(d.intentId, d.sessionId, { url: 'https://final' }),
    );
    const exec = new ControlPlaneAgentExecutor(dispatcher, seqIds());
    const res = await exec.execute(planArgs([{ kind: 'navigate', url: 'https://x' }]));
    expect(res.results[0]!.kind).toBe('success');
    if (res.results[0]!.kind !== 'success') throw new Error('narrow');
    expect(res.results[0]!.summary).toBe('navigated to https://final');
  });
});
