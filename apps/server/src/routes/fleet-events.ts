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
  send(data: string): void;
  on(event: 'message', listener: (data: WsMessageData) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  close(code?: number, reason?: string): void;
}

/** ws delivers a message as a Buffer, an array of Buffers (fragmented), or an
 *  ArrayBuffer. Normalise to a UTF-8 string for the JSON frame parser. */
type WsMessageData = Buffer | ArrayBuffer | Buffer[];
function messageToString(data: WsMessageData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

export async function registerFleetEventsRoutes(
  app: FastifyInstance,
  deps: FleetEventsRoutesDeps,
): Promise<void> {
  // The plugin must be registered before the websocket:true route is defined.
  await app.register(websocketPlugin);

  app.get(
    '/v1/fleet/events',
    {
      websocket: true,
      // Authenticate at the HTTP-upgrade phase: a bad token throws
      // UnauthorizedError → 401 and the socket never opens.
      preHandler: async (req: FastifyRequest) => {
        const { nodeId } = await authenticateFleetUpgrade(req.headers, { auth: deps.auth });
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
      const conn = deps.registry.register(nodeId, (data) => socket.send(data));
      socket.on('message', (data: WsMessageData) => conn.handleInbound(messageToString(data)));
      socket.on('close', () => deps.registry.unregister(nodeId, 'fleet node socket closed'));
      socket.on('error', () => deps.registry.unregister(nodeId, 'fleet node socket error'));
    },
  );
}

// Registered when the fleet deps are omitted from AppDeps (e.g. before the
// bootstrap wiring takes the route live). Returns 503 + a pointer so clients get
// a machine-readable "not yet enabled" signal instead of a bare 404.
export function registerFleetEventsDisabledRoutes(app: FastifyInstance): void {
  const detail =
    'Fleet events stream is not yet enabled on this deployment. The ' +
    'fleet_nodes SQL table + WebSocket route + mTLS layer are pending. ' +
    'See docs/internal/fleet-nodes-sql-migration-design.md.';
  app.get('/v1/fleet/events', (): never => {
    throw new FeatureUnavailableError(detail);
  });
}
