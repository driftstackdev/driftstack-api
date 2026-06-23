// V-531.B — LiveKit access-token minting.
//
// LiveKit's WS handshake requires a short-lived HS256 JWT signed with
// the project's API secret. The token carries the room name + role
// claims (publisher vs subscriber) so the SFU can enforce per-token
// authorization without an out-of-band session lookup. LiveKit's
// public spec is at:
//   https://docs.livekit.io/realtime/concepts/authentication/
//
// We sign the token in-process rather than pulling `livekit-server-sdk`
// because the JWT format is stable + small enough that a 30-LOC
// implementation against `node:crypto` is preferable to the dep + its
// transitive footprint. LiveKit's spec calls for a strictly-typed
// `video` grant claim; the `VideoGrant` interface here mirrors the
// SDK's surface so a future swap is a drop-in.
//
// Posture: wire-ready. Until the operator sets `LIVEKIT_API_KEY` +
// `LIVEKIT_API_SECRET` + `LIVEKIT_WS_URL` (via `config.livekit`), the
// /v1/sessions/:id/livekit-token route at app.ts stays unregistered.

import { createHmac } from 'node:crypto';
import type { DrizzleFleetNodesRepo, FleetNodeDetail } from '../db/fleet-nodes-repo.js';

/**
 * Resolve the fleet node whose LiveKit credentials should sign a session's
 * SUBSCRIBER token (gui-client viewer). Binds to the session's persisted
 * `node_id` — the Mac the harness was dispatched to and PUBLISHES from — so the
 * token is signed by + points at the SAME Mac that holds the video room. The
 * naive `findNearestWithLivekit(region)` ("most-recently-LiveKit-registered in
 * region") returns the WRONG Mac the instant a region has >=2 LiveKit boxes (or a
 * creds rotation lands between the publisher dispatch and the subscriber mint) →
 * the viewer joins an empty room on the wrong box: black screen + the input
 * DataChannel never reaches the publishing Mac. Falls back to the region-nearest
 * node ONLY for a NULL/legacy (never-dispatched) `node_id`, or if the bound node
 * has vanished / lost its creds (logged, never thrown — a degraded view beats a
 * 500). Mirrors the binding the close path (dispatchSessionEndOnClose) already does.
 */
export async function resolveSessionPublisherNode(
  fleetNodesRepo: Pick<DrizzleFleetNodesRepo, 'getDetailByNodeIdOrId' | 'findNearestWithLivekit'>,
  sessionNodeId: string | null | undefined,
  region: string | null | undefined,
  logger?: { warn: (obj: unknown, msg: string) => void },
): Promise<FleetNodeDetail | null> {
  if (sessionNodeId != null && sessionNodeId !== '') {
    const bound = await fleetNodesRepo.getDetailByNodeIdOrId(sessionNodeId);
    if (bound !== null && bound.livekit !== null) return bound;
    logger?.warn(
      { component: 'livekit-token', boundNodeId: sessionNodeId, boundNodeFound: bound !== null },
      'session-bound LiveKit node missing or has no credentials; falling back to region-nearest node',
    );
  }
  return fleetNodesRepo.findNearestWithLivekit(region);
}

export interface VideoGrant {
  /** Room name the token grants access to. */
  room: string;
  /** Allow the holder to join the room. Always true for our use. */
  roomJoin: true;
  /** Whether the holder can publish tracks (Mac-mini-side publishers). */
  canPublish: boolean;
  /** Whether the holder can subscribe to tracks (dashboard viewers). */
  canSubscribe: boolean;
  /** Whether the holder can publish DATA messages over the room DataChannel.
   *  The customer (subscriber-only for tracks) needs this true to drive the
   *  device: the floating-iPhone simulator's input-capture sends mouse/keyboard
   *  InputEvents over the DataChannel to the Mac-side CGEvent decoder. Omitted
   *  (undefined) leaves it to LiveKit's default — set it EXPLICITLY on a
   *  control-bearing token rather than relying on that default. */
  canPublishData?: boolean;
}

export interface MintLivekitTokenOpts {
  /** LiveKit project API key (`config.livekit.apiKey`). */
  apiKey: string;
  /** LiveKit project API secret (`config.livekit.apiSecret`). */
  apiSecret: string;
  /** Per-session identity (stable per-user-per-room). */
  identity: string;
  /** Video grant — room + role. */
  video: VideoGrant;
  /** TTL in seconds. Default 600 (10 min). LiveKit's max is 6h. */
  ttlSeconds?: number;
  /** Override the "now" epoch (test seam). Defaults to Date.now(). */
  nowMs?: number;
  /** Override JTI generation (test seam). Defaults to a random hex. */
  jti?: string;
}

/**
 * Mint a LiveKit access-token JWT.
 *
 * Returns the compact `<base64url(header)>.<base64url(payload)>.<base64url(sig)>`
 * triplet ready to hand to a LiveKit client (`new Room()`/connect()).
 *
 * Errors:
 *   - empty apiKey / apiSecret / identity → `TypeError`. Caller should
 *     prefer not registering the route when `config.livekit` is
 *     unset, not call this and catch.
 */
export function mintLivekitToken(opts: MintLivekitTokenOpts): string {
  if (!opts.apiKey || !opts.apiSecret || !opts.identity) {
    throw new TypeError('apiKey + apiSecret + identity are required');
  }
  const now = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const ttl = opts.ttlSeconds ?? 600;
  const exp = now + ttl;

  const header = { alg: 'HS256', typ: 'JWT' };
  // Field order matches the LiveKit reference SDK so debug-tooling
  // round-trips byte-identical when comparing tokens.
  const payload = {
    exp,
    iss: opts.apiKey,
    nbf: now,
    sub: opts.identity,
    jti: opts.jti ?? randomJti(),
    video: opts.video,
  };

  const encodedHeader = base64UrlJson(header);
  const encodedPayload = base64UrlJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac('sha256', opts.apiSecret).update(signingInput).digest();
  return `${signingInput}.${toBase64Url(signature)}`;
}

function base64UrlJson(value: unknown): string {
  return toBase64Url(Buffer.from(JSON.stringify(value), 'utf8'));
}

function toBase64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomJti(): string {
  // 16 random bytes → 32 hex chars. Enough entropy for in-flight
  // tokens; we don't reuse jtis server-side.
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
