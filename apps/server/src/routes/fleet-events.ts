// V-820 — `/v1/fleet/events` route stub (activation-gate posture).
//
// Per docs/network-architecture.md §"v1 design — signed JWT over
// mTLS", the canonical surface is a WebSocket at
// `wss://fleet.driftstack.dev/v1/fleet/events` — fleet nodes open
// an authenticated long-poll / WebSocket connection and the control
// plane streams session-creation events out.
//
// This slice registers the PATH so consumers (Agent 1 V-820.B.1.b
// dependency; auto-expires 2026-06-15 per ORCHESTRATOR-STATE.md) get
// a concrete URL to wire against. The wired WebSocket handler lands
// in a focused follow-up slice once:
//   1. `fleet_nodes` SQL migration approved (Tier-2; design at
//      `docs/internal/fleet-nodes-sql-migration-design.md`)
//   2. fastify-websocket plugin added
//   3. mTLS layer at Cloudflare Authenticated Origin Pulls
//
// Until then both the wired + disabled variants return 503
// FeatureUnavailable; the wired variant is intentionally a
// not-yet-implemented stub even when AppDeps is set, so a future
// founder flip needs an explicit handler-implementation slice
// (not just the AppDeps wiring) to take the gate live. This
// matches the pattern of "activation gate" + "real implementation"
// being separate concerns.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { FleetNodeAuth } from '../services/fleet-node-auth.js';
import type { FleetNonceCache } from '../services/fleet-nonce-cache.js';
import { FeatureUnavailableError } from '../lib/errors.js';

export interface FleetEventsRoutesDeps {
  /** JWT verifier — required at handshake (Ed25519 signature check
   *  + nonce-cache replay defence). Wired but unused in this stub. */
  auth: FleetNodeAuth;
  nonceCache: FleetNonceCache;
}

export function registerFleetEventsRoutes(
  app: FastifyInstance,
  // The wired registrar accepts deps but the real handler lands in
  // a follow-up slice. Currently this still 503-stubs to make the
  // "AppDeps wired but route not implemented yet" state explicit.
  _deps: FleetEventsRoutesDeps,
): void {
  app.get('/v1/fleet/events', (_req: FastifyRequest): never => {
    throw new FeatureUnavailableError(
      'Fleet events stream handler is not yet implemented. AppDeps is wired ' +
        '(fleetNodeAuth + fleetNonceCache present) but the WebSocket route + ' +
        'fastify-websocket plugin + mTLS layer (Cloudflare AOP) are pending. ' +
        'See docs/internal/cross-agent-control-plane-contract.md.',
    );
  });
}

export function registerFleetEventsDisabledRoutes(app: FastifyInstance): void {
  const detail =
    'Fleet events stream is not yet enabled on this deployment. The ' +
    'fleet_nodes SQL table + WebSocket route + mTLS layer are pending. ' +
    'See docs/internal/fleet-nodes-sql-migration-design.md.';
  app.get('/v1/fleet/events', (): never => {
    throw new FeatureUnavailableError(detail);
  });
}
