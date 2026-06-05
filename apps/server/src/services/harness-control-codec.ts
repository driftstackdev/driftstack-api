// Increment-2 — wire codec for the harness control-plane envelopes.
//
// The transport pieces that pair with the (b) mapper (agent-intent-to-dispatch):
//   - serializeIntentDispatch — builds a ControlInbound.IntentDispatch ready to
//     send over the /v1/fleet/events WSS (validated + params base64-encoded).
//   - parseIntentResult — decodes a HarnessOutbound.IntentResult back into the
//     logical result (outputData base64-decoded to its per-intent JSON).
//
// Wire codec (A3-confirmed 2026-06-05): inputParams / outputData are Swift
// `Data` and cross the wire as a BASE64 string of UTF-8 JSON (Codable's default
// `Data` encoding). Envelope keys are camelCase. This module is the single
// place that encodes/decodes that base64-JSON, so the rest of the server works
// with plain objects.
//
// Pure + transport-agnostic: no socket, no I/O. The (gated) WSS sender calls
// serializeIntentDispatch then writes the JSON; the receive loop calls
// parseIntentResult on each inbound IntentResult frame.

import {
  IntentDispatchSchema,
  IntentResultEnvelopeSchema,
  HARNESS_INTENT_PARAM_SCHEMAS,
  type IntentDispatch,
  type IntentResultEnvelope,
  type HarnessIntentName,
  type HarnessErrorCode,
} from '../schemas/harness-control-protocol.js';

/** Thrown when an inbound envelope's base64/JSON `Data` field is malformed —
 *  a harness↔server protocol violation, surfaced rather than silently dropped. */
export class HarnessWireCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessWireCodecError';
  }
}

/** Encode a logical value as the wire `Data` field: UTF-8 JSON → base64. */
export function encodeWireData(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

/** Decode a wire `Data` field: base64 → UTF-8 JSON → value. Throws
 *  HarnessWireCodecError on malformed base64 or invalid JSON. */
export function decodeWireData(base64: string): unknown {
  let json: string;
  try {
    json = Buffer.from(base64, 'base64').toString('utf8');
  } catch {
    throw new HarnessWireCodecError('inputParams/outputData is not valid base64');
  }
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new HarnessWireCodecError('inputParams/outputData base64 did not contain valid JSON');
  }
}

/**
 * Build a wire-ready IntentDispatch from the (b) mapper's output plus the
 * session + intent ids. Validates the logical params against the canonical
 * per-intent schema BEFORE encoding (so a wrong shape is caught here, not as an
 * opaque harness intent_missing_parameter), then base64-encodes them into
 * `inputParams`. The result is re-validated against IntentDispatchSchema.
 *
 * @throws HarnessWireCodecError if `params` fails its per-intent schema.
 */
export function serializeIntentDispatch(args: {
  sessionId: string;
  intentId: string;
  intentName: HarnessIntentName;
  params: Record<string, unknown>;
}): IntentDispatch {
  const paramSchema = HARNESS_INTENT_PARAM_SCHEMAS[args.intentName];
  const parsed = paramSchema.safeParse(args.params);
  if (!parsed.success) {
    throw new HarnessWireCodecError(
      `${args.intentName} params failed the harness contract before dispatch: ${parsed.error.message}`,
    );
  }
  const dispatch = {
    sessionId: args.sessionId,
    intentId: args.intentId,
    intentName: args.intentName,
    inputParams: encodeWireData(parsed.data),
  };
  // Re-validate the envelope so a malformed dispatch never leaves the server.
  return IntentDispatchSchema.parse(dispatch);
}

/** The logical (decoded) result the executor consumes. */
export interface ParsedIntentResult {
  sessionId: string;
  intentId: string;
  success: boolean;
  durationMs: number;
  /** The decoded per-intent result JSON (undefined when the harness sent none). */
  outputData?: unknown;
  errorCode?: HarnessErrorCode;
  errorMessage?: string;
}

/**
 * Validate + decode an inbound IntentResult frame. The envelope is validated
 * against IntentResultEnvelopeSchema first; then `outputData` (if present) is
 * base64-decoded to its logical JSON.
 *
 * @throws ZodError if the frame is not a valid IntentResultEnvelope.
 * @throws HarnessWireCodecError if `outputData` is malformed base64/JSON.
 */
export function parseIntentResult(frame: unknown): ParsedIntentResult {
  const env: IntentResultEnvelope = IntentResultEnvelopeSchema.parse(frame);
  const out: ParsedIntentResult = {
    sessionId: env.sessionId,
    intentId: env.intentId,
    success: env.success,
    durationMs: env.durationMs,
  };
  if (env.outputData !== undefined) out.outputData = decodeWireData(env.outputData);
  if (env.errorCode !== undefined) out.errorCode = env.errorCode;
  if (env.errorMessage !== undefined) out.errorMessage = env.errorMessage;
  return out;
}
