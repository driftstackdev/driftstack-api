// V-820 — `/v1/fleet/events` fleet-node control-plane WebSocket.
//
// Per docs/network-architecture.md §"v1 design — signed JWT over mTLS", the
// canonical surface is a WebSocket at `wss://fleet.driftstack.dev/v1/fleet/events`:
// each fleet NODE opens one authenticated connection; the control plane sends
// IntentDispatch / sessionAssign / sessionEnd down it and receives intentResult /
// sessionStatus / heartbeat / capabilityReport / errorEvent back (A3 bus W122
// flat `{type,…}` envelope).
//
// Auth (A3 W121, control-plane-owns): the node presents an Ed25519 Bearer JWT
// (verified via FleetNodeAuth + the Redis nonce cache wired into it) and the
// `X-Driftstack-Mac-Node-Id` header (== the JWT iss). authenticateFleetUpgrade
// runs as a preHandler so a bad token is rejected with 401 BEFORE the socket
// opens. On success the connection is registered in the FleetControlRegistry
// keyed by nodeId; inbound frames route through the connection's
// IntentDispatchCorrelator (HarnessOutbound union → onResultFrame / onSessionError);
// on close the registry unregisters + fails the node's in-flight dispatches.
//
// Activation gate (lib/app.ts): the WS handler registers only when
// fleetNodeAuth + fleetNonceCache + fleetControlRegistry are all wired in
// AppDeps; otherwise registerFleetEventsDisabledRoutes serves a 503 stub so
// clients get a machine-readable signal. (Bootstrap wires the deps to take the
// route live in prod — a separate slice; until then the disabled stub runs.)

import websocketPlugin from '@fastify/websocket';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { FleetNodeAuth } from '../services/fleet-node-auth.js';
import type { FleetNonceCache } from '../services/fleet-nonce-cache.js';
import type { FleetControlRegistry } from '../services/fleet-control-registry.js';
import { authenticateFleetUpgrade } from '../services/fleet-upgrade-auth.js';
import { FeatureUnavailableError } from '../lib/errors.js';

export interface FleetEventsRoutesDeps {
  /** JWT verifier — Ed25519 signature check + nonce-cache replay defence at the
   *  WS upgrade. Production injects FleetNodeAuthImpl(repo, RedisFleetNonceCache). */
  auth: FleetNodeAuth;
  /** The same nonce cache the auth verifier was constructed with; present so the
   *  app.ts activation gate can require it explicitly. */
  nonceCache: FleetNonceCache;
  /** nodeId → connection registry the handler registers the verified node in. */
  registry: FleetControlRegistry;
}

/** A request after the upgrade preHandler has stamped the verified node id. */
type AuthedUpgradeRequest = FastifyRequest & { fleetNodeId?: string };

// Minimal structural view of the @fastify/websocket socket (a ws.WebSocket).
// Typed locally because ws's types aren't directly resolvable from apps/server,
// which would otherwise leave the handler's `socket` as `any`. A real
// ws.WebSocket is assignable to this (it has these exact methods).
interface FleetSocket {
  /** WHATWG/ws state number; OPEN is 1. */
  readonly readyState: number;
  /** Bytes ws has accepted but the underlying network has not drained yet. */
  readonly bufferedAmount: number;
  send(data: string): void;
  ping(): void;
  pong(data: Buffer): void;
  on(event: 'message', listener: (data: WsMessageData) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'ping', listener: (data: Buffer) => void): void;
  close(code?: number, reason?: string): void;
}

/** ws delivers a message as a Buffer, an array of Buffers (fragmented), or an
 *  ArrayBuffer. Keep it binary through admission; only accepted frames become
 *  a UTF-8 string inside FleetControlConnection.handleInboundBytes. */
type WsMessageData = Buffer | ArrayBuffer | Buffer[];
function messageToBuffer(data: WsMessageData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** Keep the process-local outbound queue below the same generous ceiling that
 * admits the largest legitimate inbound frame. A synchronous refusal is
 * intentional: every registry correlator already converts transport throws to
 * its bounded error outcome and clears its pending timer. The shared node socket
 * stays open, so a later request can proceed once the existing queue drains. */
export const FLEET_WS_MAX_BUFFERED_BYTES = 96 * 1024 * 1024;
export const FLEET_WS_OPEN_STATE = 1;

export function assertFleetSocketOpen(readyState: number): void {
  if (readyState !== FLEET_WS_OPEN_STATE) {
    throw new Error('fleet control socket is not open');
  }
}

export function assertFleetOutboundCapacity(bufferedAmount: number, frameBytes: number): void {
  if (bufferedAmount + frameBytes > FLEET_WS_MAX_BUFFERED_BYTES) {
    throw new Error('fleet control socket outbound buffer capacity exceeded');
  }
}

function sendFleetFrame(socket: FleetSocket, data: string): void {
  assertFleetSocketOpen(socket.readyState);
  assertFleetOutboundCapacity(socket.bufferedAmount, Buffer.byteLength(data, 'utf8'));
  socket.send(data);
}

export async function registerFleetEventsRoutes(
  app: FastifyInstance,
  deps: FleetEventsRoutesDeps,
): Promise<void> {
  // The plugin must be registered before the websocket:true route is defined.
  // maxPayload bounds INBOUND frames (handleInbound JSON.parses each raw frame,
  // so an oversized frame = a huge string + parse = memory DoS from a buggy/
  // compromised fleet node). ws (v8.18.0) enforces maxPayload by throwing +
  // forcibly closing the WHOLE socket on the offending frame (receiver.js →
  // websocket.js receiverOnError) — NOT a per-message reject — and this is the
  // single SHARED control socket carrying dispatch/cookies/uploads/downloads/
  // trims for EVERY session dispatched to that node, so an oversized frame
  // fails every in-flight correlator for the node (FleetControlRegistry's
  // close/unregister → failAll()), not just the one request that overflowed.
  // The largest legit frame is now the file-DOWNLOAD reply (A3 W2856 /
  // DownloadDataResultSchema): `downloadData.dataB64` carries up to the 64 MiB
  // per-file cap (harness-enforced, same ceiling as the upload path's
  // UPLOAD_MAX_FILE_BYTES) — base64-encoded on the wire (~×4/3 → ~85.3 MiB) plus
  // the JSON envelope. That supersedes the OLD sizing rationale (an intentResult
  // whose inline outputData the harness caps at 8 MiB / A3 W227 / harness
  // f711840f → ~10.7 MiB base64), which is now the SMALLER of the two caps.
  // 96 MiB clears the 64 MiB download cap's ~85.3 MiB base64 inflation with real
  // headroom (mirrors UPLOAD_MAX_BODY_BYTES in agent-sessions.ts, which sizes
  // the equivalent HTTP body the same way) while still cutting the ws default
  // (100 MiB).
  const FLEET_WS_MAX_PAYLOAD_BYTES = 96 * 1024 * 1024;
  // Disable ws's default auto-pong so the bounded listener below is the single
  // protocol-pong owner. `@fastify/websocket` forwards these options to its
  // WebSocketServer, whose autoPong default is otherwise true.
  await app.register(websocketPlugin, {
    options: { maxPayload: FLEET_WS_MAX_PAYLOAD_BYTES, autoPong: false },
  });

  app.get(
    '/v1/fleet/events',
    {
      websocket: true,
      // Authenticate at the HTTP-upgrade phase: a bad token throws
      // UnauthorizedError → 401 and the socket never opens.
      preHandler: async (req: FastifyRequest) => {
        const { nodeId } = await authenticateFleetUpgrade(
          req.headers,
          (req.query ?? {}) as Record<string, unknown>,
          { auth: deps.auth, logger: req.log },
        );
        (req as AuthedUpgradeRequest).fleetNodeId = nodeId;
      },
    },
    (socket: FleetSocket, req: FastifyRequest) => {
      const nodeId = (req as AuthedUpgradeRequest).fleetNodeId;
      if (nodeId === undefined) {
        // Defensive: the preHandler must have set it; never reached on the
        // authenticated path. Close with policy-violation rather than serve.
        socket.close(1008, 'unauthenticated');
        return;
      }
      // The 3rd arg lets a later reconnect for this node SUPERSEDE + actively close this
      // socket, so a half-open box socket can't linger + zombie-heartbeat into the CP's
      // stale-guard forever (the 2026-07-11 P0). GRACEFUL close (1012), not terminate()/
      // destroy — the box sees a clean WS close + reconnects, not an abrupt RST.
      const conn = deps.registry.register(
        nodeId,
        (data) => sendFleetFrame(socket, data),
        () => {
          try {
            socket.close(1012, 'superseded by a newer control connection');
          } catch {
            // socket already closing — ignore
          }
        },
      );
      let inboundRejected = false;
      socket.on('message', (data: WsMessageData) => {
        if (inboundRejected) return;
        const admission = conn.handleInboundBytes(messageToBuffer(data));
        if (admission === 'accepted') return;
        // Policy-close the whole authenticated socket after the first rejected
        // frame. Do not log or reflect payload text; the bounded reason is
        // enough for the node to reconnect/back off and for in-flight requests
        // to fail through the normal close→unregister path.
        inboundRejected = true;
        socket.close(1008, admission);
      });
      // Explicitly PONG every inbound ping from the node. With autoPong:false in
      // the plugin options, ws no longer auto-replies, so this is the single,
      // guaranteed source of pongs — a node keepalive ping is always answered, so
      // its "no PONG within 10s -> half-open -> reconnect" flap cannot recur from
      // a missing server pong. (The app-level `heartbeat` JSON frame is
      // node->server only and is unrelated to WS protocol ping/pong.)
      socket.on('ping', (data: Buffer) => {
        try {
          socket.pong(data);
        } catch {
          // socket already closing — ignore
        }
      });
      // Keep the server->node direction warm so a proxy/NAT idle timer can't reap
      // an otherwise-silent control socket: a protocol ping every 30s (well under
      // nginx's 60s read timeout). Do NOT terminate() on a missed pong --
      // terminate() = socket.destroy() = an abrupt RST the box sees as
      // ENOTCONN/Code-57, and one missed pong is not proof of death (a brief
      // event-loop stall on either side). TCP keepalive + the box's own reconnect
      // handle genuinely-dead sockets. MUST clearInterval on teardown.
      const FLEET_WS_KEEPALIVE_MS = 30_000;
      const keepalive = setInterval(() => {
        try {
          socket.ping();
        } catch {
          // socket already closing — ignore
        }
      }, FLEET_WS_KEEPALIVE_MS);
      const stopKeepalive = (): void => clearInterval(keepalive);
      // Pass `conn` so unregister is identity-checked: a reconnect that already
      // replaced this connection must not be torn down by this socket's lagging
      // close/error event (see FleetControlRegistry.unregister).
      socket.on('close', () => {
        stopKeepalive();
        deps.registry.unregister(nodeId, conn, 'fleet node socket closed');
      });
      socket.on('error', () => {
        stopKeepalive();
        deps.registry.unregister(nodeId, conn, 'fleet node socket error');
      });
    },
  );
}

// Registered when fleet dependencies are omitted from AppDeps. Return a stable,
// machine-readable deployment-state signal instead of a bare 404 or internal plan.
export function registerFleetEventsDisabledRoutes(app: FastifyInstance): void {
  const detail = 'Fleet events stream is unavailable on this deployment.';
  app.get('/v1/fleet/events', (): never => {
    throw new FeatureUnavailableError(detail);
  });
}
