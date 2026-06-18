// Drift guard for apps/server/src/routes/fleet-events.ts — the V-820
// /v1/fleet/events fleet-node control-plane WebSocket. Pins the live WS handler
// (auth-at-upgrade + registry wiring) + the disabled 503 stub. Drift here would
// break the harness↔control-plane connection contract or the auth gate.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/fleet-events.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('routes/fleet-events content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('V-820 module framing pinned: fleet-node control-plane WebSocket at wss://fleet.driftstack.dev/v1/fleet/events; flat {type,…} envelope (A3 W122)', () => {
    expect(body).toMatch(/\/\/ V-820 — `\/v1\/fleet\/events` fleet-node control-plane WebSocket\./);
    expect(body).toMatch(/wss:\/\/fleet\.driftstack\.dev\/v1\/fleet\/events/);
    expect(body).toMatch(/A3 bus W122\s*\n?\s*\/\/ flat `\{type,…\}` envelope/);
  });

  it('auth framing pinned: Ed25519 Bearer JWT + X-Driftstack-Mac-Node-Id (== JWT iss) verified at the upgrade preHandler → 401 before the socket opens (A3 W121 control-plane-owns)', () => {
    expect(body).toMatch(/A3 W121, control-plane-owns/);
    expect(body).toMatch(/X-Driftstack-Mac-Node-Id` header \(== the JWT iss\)/);
    expect(body).toMatch(
      /authenticateFleetUpgrade\s*\n?\s*\/\/ runs as a preHandler so a bad token is rejected with 401 BEFORE the socket\s*\n?\s*\/\/ opens\./,
    );
  });

  it('FleetEventsRoutesDeps 3-field shape pinned: auth: FleetNodeAuth + nonceCache: FleetNonceCache + registry: FleetControlRegistry', () => {
    expect(body).toMatch(/export interface FleetEventsRoutesDeps \{/);
    expect(body).toMatch(/auth: FleetNodeAuth;/);
    expect(body).toMatch(/nonceCache: FleetNonceCache;/);
    expect(body).toMatch(/registry: FleetControlRegistry;/);
  });

  it('registerFleetEventsRoutes is async, registers the @fastify/websocket plugin before the route, defines the websocket:true GET with the auth preHandler', () => {
    expect(body).toMatch(/import websocketPlugin from '@fastify\/websocket';/);
    expect(body).toMatch(
      /export async function registerFleetEventsRoutes\(\s*\n?\s*app: FastifyInstance,\s*\n?\s*deps: FleetEventsRoutesDeps,\s*\n?\s*\): Promise<void> \{/,
    );
    // Registers the plugin with a maxPayload bound on inbound frames (A3 W227:
    // harness caps inline outputData at 8 MiB → ~10.7 MiB base64 wire; 16 MiB headroom).
    expect(body).toMatch(/const FLEET_WS_MAX_PAYLOAD_BYTES = 16 \* 1024 \* 1024;/);
    expect(body).toMatch(
      /await app\.register\(websocketPlugin, \{ options: \{ maxPayload: FLEET_WS_MAX_PAYLOAD_BYTES \} \}\);/,
    );
    expect(body).toMatch(/'\/v1\/fleet\/events',/);
    expect(body).toMatch(/websocket: true,/);
    // authenticateFleetUpgrade now also takes the query (the ?ds_token=/?node_id=
    // fallback for URLSession, which strips the Authorization header on WS).
    // toContain fragments (prettier wraps the multi-line call).
    expect(body).toContain('const { nodeId } = await authenticateFleetUpgrade(');
    expect(body).toContain('req.headers,');
    expect(body).toContain('as Record<string, unknown>,');
    expect(body).toContain('{ auth: deps.auth },');
  });

  it('handler wiring pinned: register the verified node by nodeId; route inbound messages to the connection; unregister on close + error', () => {
    expect(body).toMatch(
      /const conn = deps\.registry\.register\(nodeId, \(data\) => socket\.send\(data\)\);/,
    );
    expect(body).toMatch(
      /socket\.on\('message', \(data: WsMessageData\) => conn\.handleInbound\(messageToString\(data\)\)\);/,
    );
    expect(body).toMatch(/socket\.on\('close', \(\) => deps\.registry\.unregister\(nodeId/);
    expect(body).toMatch(/socket\.on\('error', \(\) => deps\.registry\.unregister\(nodeId/);
  });

  it('disabled variant pinned: 503 stub with the fleet_nodes-pending detail + design-doc pointer', () => {
    expect(body).toMatch(
      /export function registerFleetEventsDisabledRoutes\(app: FastifyInstance\): void \{\s*\n?\s*const detail =\s*\n?\s*'Fleet events stream is not yet enabled on this deployment\. The ' \+\s*\n?\s*'fleet_nodes SQL table \+ WebSocket route \+ mTLS layer are pending\. ' \+\s*\n?\s*'See docs\/internal\/fleet-nodes-sql-migration-design\.md\.';/,
    );
    expect(body).toMatch(/throw new FeatureUnavailableError\(detail\);/);
  });
});
