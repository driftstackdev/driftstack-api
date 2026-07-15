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
    // Registers the plugin with a maxPayload bound on inbound frames, sized to the
    // largest legit frame — the file-download reply (A3 W2856): a 64 MiB per-file
    // cap → ~85.3 MiB base64 wire; 96 MiB headroom (mirrors UPLOAD_MAX_BODY_BYTES).
    expect(body).toMatch(/const FLEET_WS_MAX_PAYLOAD_BYTES = 96 \* 1024 \* 1024;/);
    expect(body).toMatch(
      /await app\.register\(websocketPlugin, \{\s*options: \{ maxPayload: FLEET_WS_MAX_PAYLOAD_BYTES \},\s*\}\);/,
    );
    expect(body).toMatch(/'\/v1\/fleet\/events',/);
    expect(body).toMatch(/websocket: true,/);
    // authenticateFleetUpgrade now also takes the query (the ?ds_token=/?node_id=
    // fallback for URLSession, which strips the Authorization header on WS).
    // toContain fragments (prettier wraps the multi-line call).
    expect(body).toContain('const { nodeId } = await authenticateFleetUpgrade(');
    expect(body).toContain('req.headers,');
    expect(body).toContain('as Record<string, unknown>,');
    expect(body).toContain('{ auth: deps.auth, logger: req.log },');
  });

  it('handler wiring pinned: register node by nodeId; route inbound messages; explicit PONG of inbound pings (+ ws auto-pong) + 30s keepalive ping with NO terminate(); clearInterval + unregister on close + error', () => {
    // register(nodeId, send, terminate) — the 3rd arg lets a later reconnect SUPERSEDE +
    // actively close THIS socket (P0 2026-07-11 zombie-conn fix). toContain fragments —
    // prettier wraps the multi-line call.
    expect(body).toContain('const conn = deps.registry.register(');
    expect(body).toContain('(data) => socket.send(data),');
    expect(body).toContain("socket.close(1012, 'superseded by a newer control connection')");
    expect(body).toContain("socket.on('message', (data: WsMessageData) => {");
    expect(body).toContain('conn.handleInboundBytes(messageToBuffer(data))');
    expect(body).toContain('socket.close(1008, admission)');
    expect(body).toContain('if (inboundRejected) return;');
    // ws default auto-pong answers the node's ping; the explicit ping->pong
    // handler is a logged backup; a 30s server->node ping keeps the direction
    // warm. Must NOT terminate() — that RST surfaces as the box's ENOTCONN/Code-57
    // flap (a missed pong is not proof of death).
    expect(body).toContain("socket.on('ping'");
    expect(body).toContain('socket.pong();');
    expect(body).toContain('socket.ping();');
    expect(body).toContain('clearInterval(keepalive)');
    expect(body).not.toContain('socket.terminate()');
    // close + error stop the keepalive timer, then identity-checked unregister.
    expect(body).toContain("deps.registry.unregister(nodeId, conn, 'fleet node socket closed')");
    expect(body).toContain("deps.registry.unregister(nodeId, conn, 'fleet node socket error')");
  });

  it('disabled variant pinned: stable 503 detail without internal infrastructure or design-doc leakage', () => {
    expect(body).toMatch(
      /export function registerFleetEventsDisabledRoutes\(app: FastifyInstance\): void \{\s*\n?\s*const detail = 'Fleet events stream is unavailable on this deployment\.';/,
    );
    const disabled = body.slice(body.indexOf('registerFleetEventsDisabledRoutes'));
    expect(disabled).not.toMatch(/fleet_nodes|mTLS|pending|docs\/internal/i);
    expect(body).toMatch(/throw new FeatureUnavailableError\(detail\);/);
  });
});
