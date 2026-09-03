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
  CookiesRequestSchema,
  SetCookiesRequestSchema,
  SetEgressRequestSchema,
  ProbeEgressFrameSchema,
  NavigateHistoryRequestSchema,
  UploadFileRequestSchema,
  ListDownloadsRequestSchema,
  FetchDownloadRequestSchema,
  TrimProfileRequestSchema,
  HARNESS_INTENT_PARAM_SCHEMAS,
  HARNESS_INTENT_RESULT_SCHEMAS,
  type IntentDispatch,
  type IntentResultEnvelope,
  type SessionAssign,
  type SessionEnd,
  type PauseSession,
  type ResumeSession,
  type ControlCommand,
  type ControlCommandKind,
  type CookiesRequest,
  type SetCookiesRequest,
  type SetEgressApplyPoint,
  type SetEgressRequest,
  type SetEgressExitIdentity,
  type ProbeEgressFrame,
  type NavigateHistoryRequest,
  type Cookie,
  type UploadFileRequest,
  type ListDownloadsRequest,
  type FetchDownloadRequest,
  type TrimProfileRequest,
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
import { z } from 'zod';

/** Proxy UDP pre-detection (A3 W2756) — the dispatch WIRE carries a verified
 *  per-proxy `udp_capable` that the harness maps to env DRIFTSTACK_PROXY_UDP_CAPABLE.
 *  It is INTERNAL to the server->harness wire ONLY: kept OFF the customer-facing
 *  SocksProxyConfigSchema (which feeds the public OpenAPI via SessionEgressConfig)
 *  so a customer can never claim it. resolveForDispatch is the sole writer, from a
 *  real data-path probe. Extending here keeps it out of the customer surface. */
const SocksProxyConfigWireSchema = SocksProxyConfigSchema.extend({
  udp_capable: z.boolean().nullable().optional(),
});

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
  /** Explicit geolocation OVERRIDE (A3 verdict 2026-07-01). Absent ⇒ the
   *  harness keeps its proxy-exit auto-derive (exit-coherent default);
   *  present ⇒ the fork's location provider serves exactly these coordinates.
   *  accuracy is meters; omitted → harness default 35.0. */
  geolocation?: { latitude: number; longitude: number; accuracy?: number };
  /** #128 new-tab IP panel — CP-probed exit identity for the box-local new-tab
   *  page. camelCase in; emitted as the snake_case wire block (quic_ok/probed_at).
   *  Absent ⇒ box keeps today's behaviour. region/city/timezone null when the
   *  geo lookup can't resolve them. */
  exitIdentity?: {
    ip: string;
    country: string;
    region: string | null;
    city: string | null;
    timezone: string | null;
    quicOk: boolean;
    probedAt: string;
  };
}): SessionAssign {
  let inlineProxyConfig: string | undefined;
  if (args.inlineProxyConfig !== undefined) {
    inlineProxyConfig = encodeInlineProxyConfig(args.inlineProxyConfig, 'assign');
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
    ...(args.geolocation !== undefined
      ? {
          geolocation: {
            latitude: args.geolocation.latitude,
            longitude: args.geolocation.longitude,
            ...(args.geolocation.accuracy !== undefined
              ? { accuracy: args.geolocation.accuracy }
              : {}),
          },
        }
      : {}),
    ...(args.exitIdentity !== undefined
      ? {
          exit_identity: {
            ip: args.exitIdentity.ip,
            country: args.exitIdentity.country,
            region: args.exitIdentity.region,
            city: args.exitIdentity.city,
            timezone: args.exitIdentity.timezone,
            quic_ok: args.exitIdentity.quicOk,
            probed_at: args.exitIdentity.probedAt,
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

/**
 * Founder #48 (cookies live-view) — build a wire-ready `cookiesRequest` to PULL a
 * session's full cookie jar over that node's own WSS. Correlated by `requestId`
 * (the harness echoes it on the `cookiesResult` reply, A2 W2816 / A3 W2817 PULL
 * contract). Re-validated so a malformed envelope never leaves the server.
 */
export function serializeCookiesRequest(args: {
  requestId: string;
  sessionId: string;
}): CookiesRequest {
  return CookiesRequestSchema.parse({
    type: 'cookiesRequest',
    requestId: args.requestId,
    sessionId: args.sessionId,
  });
}

/**
 * Cookie-import — build a wire-ready `setCookies` to WRITE a customer's exported
 * jar into the session's WKWebsiteDataStore.httpCookieStore over that node's WSS.
 * The write-twin of serializeCookiesRequest; `cookies` is the EXACT CookieSchema
 * shape the PULL/Export emits (a cookies.json round-trips 1:1). Correlated by
 * `requestId` (the harness echoes it on the `setCookiesResult` reply). Re-validated
 * so a malformed envelope never leaves the server.
 */
export function serializeSetCookies(args: {
  requestId: string;
  sessionId: string;
  cookies: Cookie[];
}): SetCookiesRequest {
  return SetCookiesRequestSchema.parse({
    type: 'setCookies',
    requestId: args.requestId,
    sessionId: args.sessionId,
    cookies: args.cookies,
  });
}

/**
 * Live egress swap (A3 P-17) — build a wire-ready `setEgress` to move a RUNNING
 * session onto a different exit over that node's WSS. Correlated by `requestId`
 * (the harness echoes it on the `setEgressResult` reply). Re-validated so a
 * malformed envelope never leaves the server.
 *
 * `exitIdentity` travels WITH `inlineProxyConfig` rather than being derived
 * later: the two describe one exit, and a frame that carried the new IP with the
 * old timezone would hand the node a self-contradicting geography.
 */
/**
 * Validate a proxy config against the contract its `type` selects, then
 * base64( utf8( JSON.stringify ) ) it for the wire.
 *
 * Shared by `sessionAssign` and `setEgress` deliberately. Both put the SAME field
 * on the wire, and two encoders for one field is the shape that drifts: the moment
 * one gains a contract the other does not, a config the harness would refuse on
 * assign sails through on a swap. `where` only names the operation in the error,
 * so a failure says which call refused it.
 */
function encodeInlineProxyConfig(
  config: SocksProxyConfig | InlineVpnProxyWire,
  where: string,
): string {
  const cfg = config as { type?: unknown };
  if (cfg.type === 'openvpn' || cfg.type === 'wireguard') {
    const parsedVpn = InlineVpnProxyWireSchema.safeParse(config);
    if (!parsedVpn.success) {
      throw new HarnessWireCodecError(
        `inlineProxyConfig failed the InlineVpnProxyWire contract before ${where}: ${parsedVpn.error.message}`,
      );
    }
    return encodeWireData(parsedVpn.data);
  }
  const parsedSocks = SocksProxyConfigWireSchema.safeParse(config);
  if (!parsedSocks.success) {
    throw new HarnessWireCodecError(
      `inlineProxyConfig failed the SocksProxyConfig contract before ${where}: ${parsedSocks.error.message}`,
    );
  }
  return encodeWireData(parsedSocks.data);
}

export function serializeSetEgress(args: {
  requestId: string;
  sessionId: string;
  inlineProxyConfig: SocksProxyConfig | InlineVpnProxyWire;
  exitIdentity: SetEgressExitIdentity;
  applyPoint: SetEgressApplyPoint;
}): SetEgressRequest {
  return SetEgressRequestSchema.parse({
    type: 'setEgress',
    requestId: args.requestId,
    sessionId: args.sessionId,
    inlineProxyConfig: encodeInlineProxyConfig(args.inlineProxyConfig, 'egress swap'),
    exitIdentity: args.exitIdentity,
    applyPoint: args.applyPoint,
  });
}

/**
 * Node-scoped egress probe (T-1) — build a wire-ready `probeEgress` so a fleet
 * Mac (the machine that will run the profile) measures a proxy's reachability /
 * latency / QUIC, instead of the customer's laptop or the control plane. Base64
 * encodes the SAME `inlineProxyConfig` a sessionAssign carries — through the
 * SHARED `encodeInlineProxyConfig`, so a config the harness would refuse on assign
 * is refused here too (`where` = 'probe' names the op in the error). Re-validated
 * against ProbeEgressFrameSchema so a malformed envelope never leaves the server.
 *
 * ⛔ NODE-SCOPED: there is no `sessionId`, and the frame schema is `.strict()`, so
 * one added by accident fails the parse rather than turning this into a session op.
 */
export function serializeProbeEgress(args: {
  requestId: string;
  inlineProxyConfig: SocksProxyConfig | InlineVpnProxyWire;
  target: { host: string; port: number };
}): ProbeEgressFrame {
  return ProbeEgressFrameSchema.parse({
    type: 'probeEgress',
    requestId: args.requestId,
    inlineProxyConfig: encodeInlineProxyConfig(args.inlineProxyConfig, 'probe'),
    target: { host: args.target.host, port: args.target.port },
  });
}

/**
 * History-navigation (sim back/forward — A3 W2870) — build a wire-ready
 * `navigateHistory` to step the running session's WebKit back-forward list one entry
 * in `direction` over that node's live WSS. The sibling of serializeSetCookies;
 * `direction` is the closed enum ['back','forward']. Correlated by `requestId` (the
 * harness echoes it on the `navigateHistoryResult` reply). Re-validated so a malformed
 * envelope never leaves the server.
 */
export function serializeNavigateHistory(args: {
  requestId: string;
  sessionId: string;
  direction: 'back' | 'forward';
  tabId?: string;
}): NavigateHistoryRequest {
  return NavigateHistoryRequestSchema.parse({
    type: 'navigateHistory',
    requestId: args.requestId,
    sessionId: args.sessionId,
    direction: args.direction,
    ...(args.tabId !== undefined ? { tabId: args.tabId } : {}),
  });
}

/**
 * File-control (A3 W2851) — build a wire-ready `uploadFile` to relay a customer's
 * file bytes (base64) into the session's isolated upload jail over that node's WSS.
 * Correlated by `requestId` (the harness echoes it on the `uploadResult` reply).
 * Re-validated so a malformed envelope never leaves the server. The 64 MiB cap is
 * enforced route-side before this is called (and again harness-side).
 */
export function serializeUploadFile(args: {
  requestId: string;
  sessionId: string;
  name: string;
  mime: string;
  dataB64: string;
}): UploadFileRequest {
  return UploadFileRequestSchema.parse({
    type: 'uploadFile',
    requestId: args.requestId,
    sessionId: args.sessionId,
    name: args.name,
    mime: args.mime,
    dataB64: args.dataB64,
  });
}

/**
 * File-control download (A3 W2856) — build a wire-ready `listDownloads` asking the
 * node for the files in the session's download jail. Correlated by `requestId` (the
 * harness echoes it on the `downloadsList` reply). Re-validated before it leaves.
 */
export function serializeListDownloads(args: {
  requestId: string;
  sessionId: string;
}): ListDownloadsRequest {
  return ListDownloadsRequestSchema.parse({
    type: 'listDownloads',
    requestId: args.requestId,
    sessionId: args.sessionId,
  });
}

/**
 * File-control download (A3 W2856) — build a wire-ready `fetchDownload` to pull one
 * jailed file's bytes (base64) by basename. Correlated by `requestId`; 64 MiB cap +
 * basename re-sanitization + jail-confinement enforced harness-side.
 */
export function serializeFetchDownload(args: {
  requestId: string;
  sessionId: string;
  name: string;
}): FetchDownloadRequest {
  return FetchDownloadRequestSchema.parse({
    type: 'fetchDownload',
    requestId: args.requestId,
    sessionId: args.sessionId,
    name: args.name,
  });
}

/**
 * Profile-trim (doc-150 §8.3) — build a wire-ready `trimProfile` to reclaim a
 * profile's re-fetchable cache bytes OUT-OF-SESSION over any healthy node's WSS.
 * Carries the JIT crypto envelope (the same dek + presigned GET/PUT a session-assign
 * mints) so the node can open → trim → re-seal → PUT the trimmed blob. Correlated by
 * `requestId` (the harness echoes it on the `trimResult` reply). `sealedBlobPutURL`
 * is required; one of `sealedBlob` / `sealedBlobURL` supplies the input. Re-validated
 * so a malformed envelope never leaves the server. NEVER log `dek`.
 *
 * Like serializeSessionAssign's profile block, the camelCase args are mapped to the
 * snake_case WIRE keys (`profile_id` / `sealed_blob` / `sealed_blob_url` /
 * `sealed_blob_put_url`) the harness's Swift Codable decoder expects — only `type` +
 * `requestId` stay camelCase (the universal CP→node envelope convention). Emitting
 * camelCase payload keys made the box decode fail keyNotFound 'profile_id' (trim
 * never executed).
 */
export function serializeTrimProfile(args: {
  requestId: string;
  profileId: string;
  dek: string;
  sealedBlob?: string;
  sealedBlobURL?: string;
  sealedBlobPutURL: string;
  scope?: 'cache' | 'cookies' | 'history' | 'all';
}): TrimProfileRequest {
  return TrimProfileRequestSchema.parse({
    type: 'trimProfile',
    requestId: args.requestId,
    profile_id: args.profileId,
    dek: args.dek,
    ...(args.sealedBlob !== undefined ? { sealed_blob: args.sealedBlob } : {}),
    ...(args.sealedBlobURL !== undefined ? { sealed_blob_url: args.sealedBlobURL } : {}),
    sealed_blob_put_url: args.sealedBlobPutURL,
    // Omitted rather than defaulted to 'cache': an absent field is what an older
    // node expects, and emitting the default would change the frame for every
    // existing caller to say the same thing.
    ...(args.scope !== undefined ? { scope: args.scope } : {}),
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
 * against IntentResultEnvelopeSchema first; a successful `outputData` is then
 * base64-decoded and validated against the exact originating intent's result
 * schema. A cross-intent or drifted success must never enter the agent loop.
 *
 * @throws ZodError if the frame is not a valid IntentResultEnvelope.
 * @throws HarnessWireCodecError if `outputData` is malformed base64/JSON.
 */
export function parseIntentResult(
  frame: unknown,
  expectedIntentName: HarnessIntentName,
): ParsedIntentResult {
  const env: IntentResultEnvelope = IntentResultEnvelopeSchema.parse(frame);
  if (env.success) {
    const decoded = decodeWireData(env.outputData);
    const result = HARNESS_INTENT_RESULT_SCHEMAS[expectedIntentName].safeParse(decoded);
    if (!result.success) {
      throw new HarnessWireCodecError(
        `${expectedIntentName} result failed the harness contract: ${result.error.message}`,
      );
    }
    return {
      sessionId: env.sessionId,
      intentId: env.intentId,
      success: true,
      durationMs: env.durationMs,
      outputData: result.data,
    };
  }
  return {
    sessionId: env.sessionId,
    intentId: env.intentId,
    success: false,
    durationMs: env.durationMs,
    errorCode: env.errorCode,
    ...(env.errorMessage !== undefined ? { errorMessage: env.errorMessage } : {}),
  };
}
