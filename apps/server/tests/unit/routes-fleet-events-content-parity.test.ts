// Drift guard for apps/server/src/routes/fleet-events.ts. Pins the
// V-820 /v1/fleet/events stub — the WebSocket path is registered for
// Agent 1's V-820.B.1.b dependency but both wired + disabled variants
// return 503 FeatureUnavailable until the fleet_nodes migration +
// fastify-websocket plugin + mTLS layer all land. The "activation
// gate" + "real implementation" being separate concerns is the
// load-bearing pattern.

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

  it('V-820 module-level framing pinned: \'/v1/fleet/events route stub (activation-gate posture). Per docs/network-architecture.md §"v1 design — signed JWT over mTLS", the canonical surface is a WebSocket at wss://fleet.driftstack.dev/v1/fleet/events — fleet nodes open an authenticated long-poll / WebSocket connection and the control plane streams session-creation events out.\' — pinned so the V-820 anchor + activation-gate-posture + wss-canonical-surface + JWT-over-mTLS + long-poll-or-WebSocket contract all stay documented', () => {
    expect(body).toMatch(
      /\/\/ V-820 — `\/v1\/fleet\/events` route stub \(activation-gate posture\)\./,
    );
    expect(body).toMatch(
      /\/\/ Per docs\/network-architecture\.md §"v1 design — signed JWT over\s*\n?\s*\/\/ mTLS", the canonical surface is a WebSocket at\s*\n?\s*\/\/ `wss:\/\/fleet\.driftstack\.dev\/v1\/fleet\/events` — fleet nodes open\s*\n?\s*\/\/ an authenticated long-poll \/ WebSocket connection and the control\s*\n?\s*\/\/ plane streams session-creation events out\./,
    );
  });

  it("Agent 1 V-820.B.1.b dependency + auto-expire 2026-06-15 framing pinned: 'This slice registers the PATH so consumers (Agent 1 V-820.B.1.b dependency; auto-expires 2026-06-15 per ORCHESTRATOR-STATE.md) get a concrete URL to wire against. The wired WebSocket handler lands in a focused follow-up slice once: 1. fleet_nodes SQL migration approved (Tier-2; design at docs/internal/fleet-nodes-sql-migration-design.md) 2. fastify-websocket plugin added 3. mTLS layer at Cloudflare Authenticated Origin Pulls' — pinned so the 3-prerequisite roster + cross-agent-dependency contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ This slice registers the PATH so consumers \(Agent 1 V-820\.B\.1\.b\s*\n?\s*\/\/ dependency; auto-expires 2026-06-15 per ORCHESTRATOR-STATE\.md\) get\s*\n?\s*\/\/ a concrete URL to wire against\./,
    );
    expect(body).toMatch(
      /\/\/\s*1\. `fleet_nodes` SQL migration approved \(Tier-2; design at\s*\n?\s*\/\/\s*`docs\/internal\/fleet-nodes-sql-migration-design\.md`\)\s*\n?\s*\/\/\s*2\. fastify-websocket plugin added\s*\n?\s*\/\/\s*3\. mTLS layer at Cloudflare Authenticated Origin Pulls/,
    );
  });

  it('Both-variants-return-503 framing pinned: \'Until then both the wired + disabled variants return 503 FeatureUnavailable; the wired variant is intentionally a not-yet-implemented stub even when AppDeps is set, so a future founder flip needs an explicit handler-implementation slice (not just the AppDeps wiring) to take the gate live. This matches the pattern of "activation gate" + "real implementation" being separate concerns.\' — pinned so the activation-gate-vs-real-impl separation + explicit-handler-slice contract all stay documented (drift to making the wired variant return success on bare AppDeps wiring would defeat the two-stage activation pattern)', () => {
    expect(body).toMatch(
      /\/\/ Until then both the wired \+ disabled variants return 503\s*\n?\s*\/\/ FeatureUnavailable; the wired variant is intentionally a\s*\n?\s*\/\/ not-yet-implemented stub even when AppDeps is set, so a future\s*\n?\s*\/\/ founder flip needs an explicit handler-implementation slice\s*\n?\s*\/\/ \(not just the AppDeps wiring\) to take the gate live\. This\s*\n?\s*\/\/ matches the pattern of "activation gate" \+ "real implementation"\s*\n?\s*\/\/ being separate concerns\./,
    );
  });

  it("FleetEventsRoutesDeps 2-field shape pinned: auth: FleetNodeAuth + nonceCache: FleetNonceCache + 'JWT verifier — required at handshake (Ed25519 signature check + nonce-cache replay defence). Wired but unused in this stub.' framing — pinned so the Ed25519-signature + nonce-replay-defence + handshake-time contract stays documented (drift to dropping Ed25519 would weaken the signing primitive)", () => {
    expect(body).toMatch(/export interface FleetEventsRoutesDeps \{/);
    expect(body).toMatch(
      /\/\*\* JWT verifier — required at handshake \(Ed25519 signature check\s*\n?\s*\*\s+\+ nonce-cache replay defence\)\. Wired but unused in this stub\. \*\/\s*\n?\s*auth: FleetNodeAuth;\s*\n?\s*nonceCache: FleetNonceCache;/,
    );
  });

  it('Wired variant throws FeatureUnavailableError with explicit AppDeps-is-wired-but-handler-pending detail — pinned so the wired-stub posture stays distinguishable from the disabled-variant posture (drift to a generic error string would lose the cross-agent-coordination signal). Quoted detail: AppDeps is wired (fleetNodeAuth + fleetNonceCache present) but the WebSocket route + fastify-websocket plugin + mTLS layer (Cloudflare AOP) are pending', () => {
    expect(body).toMatch(
      /export function registerFleetEventsRoutes\(\s*\n?\s*app: FastifyInstance,\s*\n?\s*\/\/ The wired registrar accepts deps but the real handler lands in\s*\n?\s*\/\/ a follow-up slice\. Currently this still 503-stubs to make the\s*\n?\s*\/\/ "AppDeps wired but route not implemented yet" state explicit\.\s*\n?\s*_deps: FleetEventsRoutesDeps,\s*\n?\s*\): void \{/,
    );
    expect(body).toMatch(
      /'Fleet events stream handler is not yet implemented\. AppDeps is wired ' \+\s*\n?\s*'\(fleetNodeAuth \+ fleetNonceCache present\) but the WebSocket route \+ ' \+\s*\n?\s*'fastify-websocket plugin \+ mTLS layer \(Cloudflare AOP\) are pending\. ' \+\s*\n?\s*'See docs\/internal\/cross-agent-control-plane-contract\.md\.'/,
    );
  });

  it("Disabled variant detail framing pinned: 'Fleet events stream is not yet enabled on this deployment. The fleet_nodes SQL table + WebSocket route + mTLS layer are pending. See docs/internal/fleet-nodes-sql-migration-design.md.' — pinned so the disabled-variant detail string + sql-migration-design-doc cross-reference stay documented (operator should not see the wired-variant detail when AppDeps is unset)", () => {
    expect(body).toMatch(
      /export function registerFleetEventsDisabledRoutes\(app: FastifyInstance\): void \{\s*\n?\s*const detail =\s*\n?\s*'Fleet events stream is not yet enabled on this deployment\. The ' \+\s*\n?\s*'fleet_nodes SQL table \+ WebSocket route \+ mTLS layer are pending\. ' \+\s*\n?\s*'See docs\/internal\/fleet-nodes-sql-migration-design\.md\.';/,
    );
  });
});
