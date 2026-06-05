// Increment-2 — /v1/fleet/events WS-upgrade authentication gate.
//
// The security-critical core of the (next) WS route: it runs at the HTTP-upgrade
// phase (a preHandler) so an unauthenticated harness connection is rejected with
// 401 BEFORE the WebSocket opens. A fleet node authenticates with an Ed25519 JWT
// in `Authorization: Bearer <jwt>` (verified via the audited FleetNodeAuth +
// the Redis nonce cache wired into it) and declares its node id in the
// `X-Driftstack-Mac-Node-Id` header (== the JWT iss=sub; A3 bus W121
// control-plane-owns routing). Returns the verified nodeId for the route to key
// its FleetControlRegistry connection on.
//
// Uniform 401: per the fleet-node-auth audit, a verify failure returns the SAME
// generic message regardless of the FleetJwtVerifyError reason
// (unknown_node / revoked / signature_invalid / expired / replayed_nonce) — node
// existence + the failure cause must not be observable pre-auth. (The bearer-
// extraction errors are header-format errors, safe to surface.)
//
// Pure over a headers map + an injected FleetNodeAuth → unit-testable without a
// live socket (the @fastify/websocket plumbing that calls this is the mechanical
// next increment).

import { extractBearerToken } from './auth.js';
import { UnauthorizedError } from '../lib/errors.js';
import type { FleetNodeAuth } from './fleet-node-auth.js';

/** Lowercased per Fastify's header normalization. */
export const FLEET_NODE_ID_HEADER = 'x-driftstack-mac-node-id';

export interface FleetUpgradeAuthDeps {
  auth: FleetNodeAuth;
  /** Injectable clock for deterministic tests (defaults to now in verify()). */
  now?: Date;
}

/**
 * Authenticate a fleet-node WS-upgrade request. Resolves with the verified
 * `nodeId` (the JWT iss=sub) or throws UnauthorizedError (→ 401, upgrade
 * rejected before the socket opens).
 *
 * @throws UnauthorizedError on missing/malformed bearer, an invalid JWT (uniform
 *   message), or a node-id header that's absent or doesn't match the JWT iss.
 */
export async function authenticateFleetUpgrade(
  headers: Record<string, string | string[] | undefined>,
  deps: FleetUpgradeAuthDeps,
): Promise<{ nodeId: string }> {
  const authHeader = headers.authorization;
  const token = extractBearerToken(typeof authHeader === 'string' ? authHeader : undefined);

  const result = await deps.auth.verify(token, deps.now);
  if (!result.ok) {
    // Uniform 401 — never echo the FleetJwtVerifyError reason (anti-enumeration).
    throw new UnauthorizedError('Fleet-node authentication failed.');
  }

  const rawNodeId = headers[FLEET_NODE_ID_HEADER];
  const nodeId = typeof rawNodeId === 'string' ? rawNodeId : undefined;
  // The header is what the route keys the connection on pre-frame; it MUST match
  // the signed JWT iss so a node can't claim a different id than it authenticated.
  if (nodeId === undefined || nodeId !== result.claims.iss) {
    throw new UnauthorizedError('Fleet-node authentication failed.');
  }

  return { nodeId: result.claims.iss };
}
