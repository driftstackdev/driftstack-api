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
  SessionAssignSchema,
  SessionEndSchema,
  PauseSessionSchema,
  ResumeSessionSchema,
  ControlCommandSchema,
  HARNESS_INTENT_PARAM_SCHEMAS,
  type IntentDispatch,
  type IntentResultEnvelope,
  type SessionAssign,
  type SessionEnd,
  type PauseSession,
  type ResumeSession,
  type ControlCommand,
  type ControlCommandKind,
  type SessionAssignTransportMode,
  type HarnessIntentName,
  type HarnessErrorCode,
} from '../schemas/harness-control-protocol.js';
import {
  SocksProxyConfigSchema,
  InlineVpnProxyWireSchema,
  type SocksProxyConfig,
  type InlineVpnProxyWire,
} from '@driftstack/api-types';

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
    type: 'intentDispatch' as const,
    sessionId: args.sessionId,
    intentId: args.intentId,
    intentName: args.intentName,
    inputParams: encodeWireData(parsed.data),
  };
  // Re-validate the envelope so a malformed dispatch never leaves the server.
  return IntentDispatchSchema.parse(dispatch);
}

/**
 * Build a wire-ready ControlInbound.sessionAssign (EG-API-1.6). Mirrors
 * serializeIntentDispatch: validates the logical SocksProxyConfig against its
 * canonical schema and base64-encodes it into `inlineProxyConfig` (A3 W136:
 * `Data` field → base64 of utf8 JSON, NOT a nested object / raw JSON string),
 * maps the camelCase `livekit` input to its lone-snake_case wire shape, then
 * re-validates the whole envelope (required fields + the initialUrl http(s) guard)
 * so a malformed assign never leaves the server.
 *
 * @throws HarnessWireCodecError if `inlineProxyConfig` fails SocksProxyConfig validation.
 * @throws ZodError if the assembled envelope is invalid (missing required field /
 *   bad transportMode / non-http(s) initialUrl).
 */
export function serializeSessionAssign(args: {
  sessionId: string;
  archetype: string;
  behaviorProfile: string;
  // Optional (A3 W138): omit → harness defaults (h2-and-h3 / 300s idle / 1800s max).
  transportMode?: SessionAssignTransportMode;
  idleTimeoutSeconds?: number;
  maxDurationSeconds?: number;
  proxyConfigId?: string;
  /** Logical socks5 config OR a FLAT VPN wire object ({type:openvpn|wireguard,…});
   *  base64-encoded into the wire `inlineProxyConfig`. socks5 keeps its existing
   *  (type-less) shape; VPN uses the flat sibling-field shape A3 W2163 verified. */
  inlineProxyConfig?: SocksProxyConfig | InlineVpnProxyWire;
  initialUrl?: string;
  /** camelCase in; emitted as the snake_case wire object (room/token/ws_url/expires_at). */
  livekit?: { room: string; token: string; wsUrl: string; expiresAt: string };
  /** Profile-backed session (A3 W417). camelCase in; emitted snake_case
   *  (profile_id/dek/sealed_blob/sealed_blob_url/sealed_blob_put_url). Only
   *  profileId + dek required; blob fields optional (fresh profile ships none). */
  profile?: {
    profileId: string;
    dek: string;
    sealedBlob?: string;
    sealedBlobUrl?: string;
    sealedBlobPutUrl?: string;
  };
}): SessionAssign {
  let inlineProxyConfig: string | undefined;
  if (args.inlineProxyConfig !== undefined) {
    // VPN configs carry a `type` of openvpn|wireguard and use the FLAT
    // sibling-field wire (A3 W2163 — NOT nested); socks5 keeps its existing
    // type-less SocksProxyConfig shape. Validate against the matching contract,
    // then base64( utf8( JSON.stringify ) ) verbatim (same Data encoding as inputParams).
    const cfg = args.inlineProxyConfig as { type?: unknown };
    if (cfg.type === 'openvpn' || cfg.type === 'wireguard') {
      const parsed = InlineVpnProxyWireSchema.safeParse(args.inlineProxyConfig);
      if (!parsed.success) {
        throw new HarnessWireCodecError(
          `inlineProxyConfig failed the InlineVpnProxyWire contract before assign: ${parsed.error.message}`,
        );
      }
      inlineProxyConfig = encodeWireData(parsed.data);
    } else {
      const parsed = SocksProxyConfigSchema.safeParse(args.inlineProxyConfig);
      if (!parsed.success) {
        throw new HarnessWireCodecError(
          `inlineProxyConfig failed the SocksProxyConfig contract before assign: ${parsed.error.message}`,
        );
      }
      inlineProxyConfig = encodeWireData(parsed.data);
    }
  }
  const assign = {
    type: 'sessionAssign' as const,
    sessionId: args.sessionId,
    archetype: args.archetype,
    behaviorProfile: args.behaviorProfile,
    // Optional fields omitted entirely when not given → harness applies its W138
    // defaults rather than receiving an explicit null.
    ...(args.transportMode !== undefined ? { transportMode: args.transportMode } : {}),
    ...(args.idleTimeoutSeconds !== undefined
      ? { idleTimeoutSeconds: args.idleTimeoutSeconds }
      : {}),
    ...(args.maxDurationSeconds !== undefined
      ? { maxDurationSeconds: args.maxDurationSeconds }
      : {}),
    ...(args.proxyConfigId !== undefined ? { proxyConfigId: args.proxyConfigId } : {}),
    ...(inlineProxyConfig !== undefined ? { inlineProxyConfig } : {}),
    ...(args.initialUrl !== undefined ? { initialUrl: args.initialUrl } : {}),
    ...(args.livekit !== undefined
      ? {
          livekit: {
            room: args.livekit.room,
            token: args.livekit.token,
            ws_url: args.livekit.wsUrl,
            expires_at: args.livekit.expiresAt,
          },
        }
      : {}),
    ...(args.profile !== undefined
      ? {
          profile: {
            profile_id: args.profile.profileId,
            dek: args.profile.dek,
            ...(args.profile.sealedBlob !== undefined
              ? { sealed_blob: args.profile.sealedBlob }
              : {}),
            ...(args.profile.sealedBlobUrl !== undefined
              ? { sealed_blob_url: args.profile.sealedBlobUrl }
              : {}),
            ...(args.profile.sealedBlobPutUrl !== undefined
              ? { sealed_blob_put_url: args.profile.sealedBlobPutUrl }
              : {}),
          },
        }
      : {}),
  };
  return SessionAssignSchema.parse(assign);
}

/**
 * Build a wire-ready ControlInbound.sessionEnd — the trivial teardown envelope
 * sent when an agent-session closes so the harness frees the session (fork +
 * proxy + capture) and its concurrency slot (A3 W420 sessionEnd teardown site).
 * Re-validated so a malformed envelope never leaves the server.
 */
export function serializeSessionEnd(sessionId: string): SessionEnd {
  return SessionEndSchema.parse({ type: 'sessionEnd', sessionId });
}

/**
 * W393 challenge-handling — build a `pauseSession` ControlInbound envelope. The
 * harness halts action-intent execution (pause-gate; observation still flows).
 * Re-validated so a malformed envelope never leaves the server.
 */
export function serializePauseSession(sessionId: string): PauseSession {
  return PauseSessionSchema.parse({ type: 'pauseSession', sessionId });
}

/**
 * W393 challenge-handling — build a `resumeSession` ControlInbound envelope.
 * `challengeId` (optional) correlates to the session.challenge_detected the
 * customer is responding to: present → the harness validates it against the
 * active challenge (stale → stays paused); absent → a manual override resume.
 */
export function serializeResumeSession(args: {
  sessionId: string;
  challengeId?: string;
}): ResumeSession {
  return ResumeSessionSchema.parse({
    type: 'resumeSession',
    sessionId: args.sessionId,
    ...(args.challengeId !== undefined ? { challengeId: args.challengeId } : {}),
  });
}

/**
 * Fleet-admin (§A5) — build a wire-ready `controlCommand` ControlInbound for a
 * node-level operator action (cordon / uncordon / drain / restart), sent over
 * that node's own WSS connection. `reason` is operator free text for the node's
 * logs + the audit trail. Re-validated so a malformed envelope never leaves the
 * server. (A2-A3-BUS W2203: command-frame control-signal path; harness builds
 * the matching receiver per W2197.)
 */
export function serializeControlCommand(args: {
  command: ControlCommandKind;
  reason?: string;
}): ControlCommand {
  return ControlCommandSchema.parse({
    type: 'controlCommand',
    command: args.command,
    ...(args.reason !== undefined ? { reason: args.reason } : {}),
  });
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
