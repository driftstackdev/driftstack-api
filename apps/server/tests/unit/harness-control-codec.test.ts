// Increment-2 — unit tests for the harness control-plane wire codec
// (serializeIntentDispatch / parseIntentResult + encode/decodeWireData).
// Pins the A3-confirmed base64-JSON `Data` codec + camelCase envelopes, and
// the round-trip with the (b) mapper output.

import { describe, expect, it } from 'vitest';
import {
  encodeWireData,
  decodeWireData,
  serializeIntentDispatch,
  parseIntentResult,
  HarnessWireCodecError,
} from '../../src/services/harness-control-codec.js';
import {
  IntentDispatchSchema,
  IntentResultEnvelopeSchema,
} from '../../src/schemas/harness-control-protocol.js';
import { agentIntentToDispatch } from '../../src/services/agent-intent-to-dispatch.js';

describe('encode/decodeWireData — base64 JSON round-trip', () => {
  it('encodes to base64 of the UTF-8 JSON', () => {
    const enc = encodeWireData({ url: 'https://example.com' });
    expect(enc).toBe(Buffer.from('{"url":"https://example.com"}', 'utf8').toString('base64'));
    expect(Buffer.from(enc, 'base64').toString('utf8')).toBe('{"url":"https://example.com"}');
  });

  it('round-trips arbitrary JSON values (object / empty / nested / unicode)', () => {
    for (const v of [{ a: 1 }, {}, { n: { deep: [1, 'x', true] } }, { s: 'héllo·世界' }]) {
      expect(decodeWireData(encodeWireData(v))).toEqual(v);
    }
  });

  it('decodeWireData throws HarnessWireCodecError on non-JSON base64', () => {
    const notJson = Buffer.from('not json at all', 'utf8').toString('base64');
    expect(() => decodeWireData(notJson)).toThrow(HarnessWireCodecError);
  });
});

describe('serializeIntentDispatch', () => {
  it('builds a schema-valid IntentDispatch with base64-encoded params', () => {
    const d = serializeIntentDispatch({
      sessionId: 'ses_x',
      intentId: 'int_1',
      intentName: 'navigate',
      params: { url: 'https://example.com' },
    });
    expect(IntentDispatchSchema.safeParse(d).success).toBe(true);
    expect(typeof d.inputParams).toBe('string');
    expect(d.sessionId).toBe('ses_x');
    expect(d.intentName).toBe('navigate');
    // inputParams decodes back to the original params.
    expect(decodeWireData(d.inputParams)).toEqual({ url: 'https://example.com' });
  });

  it('encodes no-param intents as base64 of {}', () => {
    const d = serializeIntentDispatch({
      sessionId: 'ses_x',
      intentId: 'int_2',
      intentName: 'screenshot',
      params: {},
    });
    expect(decodeWireData(d.inputParams)).toEqual({});
  });

  it('rejects params that fail the per-intent harness contract (caught here, not at the harness)', () => {
    expect(() =>
      serializeIntentDispatch({
        sessionId: 'ses_x',
        intentId: 'int_3',
        intentName: 'navigate',
        params: {}, // navigate requires url
      }),
    ).toThrow(HarnessWireCodecError);
  });

  it('composes with the (b) mapper: AgentIntent → dispatch → wire envelope', () => {
    const mapped = agentIntentToDispatch({
      kind: 'interact',
      action: 'type',
      selector: '#email',
      value: 'a@b.com',
    });
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) throw new Error('narrow');
    const d = serializeIntentDispatch({
      sessionId: 'ses_x',
      intentId: 'int_4',
      intentName: mapped.intentName,
      params: mapped.params,
    });
    expect(d.intentName).toBe('send_keys');
    expect(decodeWireData(d.inputParams)).toEqual({
      strategy: 'css selector',
      value: '#email',
      text: 'a@b.com',
    });
  });
});

describe('parseIntentResult', () => {
  it('decodes a success frame with base64 outputData', () => {
    const frame = {
      type: 'intentResult' as const,
      sessionId: 'ses_x',
      intentId: 'int_1',
      success: true,
      durationMs: 42,
      outputData: encodeWireData({ url: 'https://example.com' }),
    };
    expect(IntentResultEnvelopeSchema.safeParse(frame).success).toBe(true);
    const r = parseIntentResult(frame);
    expect(r.success).toBe(true);
    expect(r.durationMs).toBe(42);
    expect(r.outputData).toEqual({ url: 'https://example.com' });
    expect(r.errorCode).toBeUndefined();
  });

  it('decodes a failure frame (no outputData, errorCode + errorMessage preserved)', () => {
    const r = parseIntentResult({
      type: 'intentResult',
      sessionId: 'ses_x',
      intentId: 'int_2',
      success: false,
      durationMs: 0,
      errorCode: 'intent_missing_parameter',
      errorMessage: 'url is required',
    });
    expect(r.success).toBe(false);
    expect(r.outputData).toBeUndefined();
    expect(r.errorCode).toBe('intent_missing_parameter');
    expect(r.errorMessage).toBe('url is required');
  });

  it('throws on a frame that is not a valid IntentResultEnvelope (unknown errorCode)', () => {
    expect(() =>
      parseIntentResult({
        type: 'intentResult',
        sessionId: 'ses_x',
        intentId: 'int_3',
        success: false,
        durationMs: 0,
        errorCode: 'totally_made_up',
      }),
    ).toThrow();
  });

  it('throws HarnessWireCodecError when outputData is malformed base64/JSON', () => {
    expect(() =>
      parseIntentResult({
        type: 'intentResult',
        sessionId: 'ses_x',
        intentId: 'int_4',
        success: true,
        durationMs: 1,
        outputData: Buffer.from('nope', 'utf8').toString('base64'),
      }),
    ).toThrow(HarnessWireCodecError);
  });

  it('round-trips serialize → (transport) → IntentResult shape', () => {
    // A dispatched navigate, then the harness echoes a result for it.
    const d = serializeIntentDispatch({
      sessionId: 'ses_x',
      intentId: 'int_5',
      intentName: 'navigate',
      params: { url: 'https://x' },
    });
    const r = parseIntentResult({
      type: 'intentResult',
      sessionId: d.sessionId,
      intentId: d.intentId,
      success: true,
      durationMs: 10,
      outputData: encodeWireData({ url: 'https://x' }),
    });
    expect(r.intentId).toBe('int_5');
    expect(r.outputData).toEqual({ url: 'https://x' });
  });
});
