// Drift guard for apps/server/src/routes/mac-nodes-register.ts. Pins
// LK.2 POST /v1/mac-nodes/register — per-Mac LiveKit credential
// registration with AES-256-GCM under MFA_ENCRYPTION_KEY, admin-only
// scope, audit log emission with secret material NEVER payloaded.
// Drift to admin-audit secret leakage would break the credential-
// management trust contract.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/mac-nodes-register.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('routes/mac-nodes-register content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("LK.2 module-level framing pinned: 'POST /v1/mac-nodes/register. Each Mac mini in the fleet stores its own LiveKit API key + secret (provisioned by Agent 1's launchd LiveKit Server install) and POSTs them to the control plane on harness boot. The control plane stores them encrypted under MFA_ENCRYPTION_KEY so the JWT mint path (LK.3 — POST /v1/agent-sessions/:id/livekit-token) can decrypt + sign without any RPC back to the Mac.' — pinned so the LK.2 anchor + per-Mac credential ownership + MFA_ENCRYPTION_KEY-shared envelope + LK.3 cross-reference + no-RPC-back-to-Mac contract all stay documented", () => {
    expect(body).toMatch(/\/\/ LK\.2 — POST \/v1\/mac-nodes\/register/);
    expect(body).toMatch(
      /\/\/ Each Mac mini in the fleet stores its own LiveKit API key \+ secret\s*\n?\s*\/\/ \(provisioned by Agent 1's launchd LiveKit Server install\) and\s*\n?\s*\/\/ POSTs them to the control plane on harness boot\. The control\s*\n?\s*\/\/ plane stores them encrypted under MFA_ENCRYPTION_KEY so the JWT\s*\n?\s*\/\/ mint path \(LK\.3 — POST \/v1\/agent-sessions\/:id\/livekit-token\) can\s*\n?\s*\/\/ decrypt \+ sign without any RPC back to the Mac\./,
    );
  });

  it("Admin scope auth posture framing pinned: 'admin scope. The Mac side is operator-provisioned via SSH for the foreseeable future; the eventual Mac-self-signs-via-Ed25519 path is a separate slice once the V-820 fleet handshake lands.' + app.requireScope('driftstack_internal_admin') — pinned so the v1.0 admin-only + future-Ed25519 + V-820-handshake contract stays documented (drift to dropping the admin scope would let any authenticated customer register Mac credentials)", () => {
    expect(body).toMatch(
      /\/\/ Auth posture \(v1\.0\): admin scope\. The Mac side is operator-\s*\n?\s*\/\/ provisioned via SSH for the foreseeable future; the eventual\s*\n?\s*\/\/ Mac-self-signs-via-Ed25519 path is a separate slice once the\s*\n?\s*\/\/ V-820 fleet handshake lands\./,
    );
    expect(body).toMatch(/app\.requireScope\('driftstack_internal_admin'\)/);
  });

  it("URL-surface-vs-table-name framing pinned: 'the URL surface uses /v1/mac-nodes/ matching the orchestrator-brief terminology; the underlying table is fleet_nodes (LK.1's note explains the alignment). The route validates the mac_node_id against the existing fleet_nodes row.' — pinned so the URL/table naming-difference + mac_node_id-must-match-fleet_nodes-row contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ Naming: the URL surface uses \/v1\/mac-nodes\/ matching the\s*\n?\s*\/\/ orchestrator-brief terminology; the underlying table is\s*\n?\s*\/\/ fleet_nodes \(LK\.1's note explains the alignment\)\. The route\s*\n?\s*\/\/ validates the mac_node_id against the existing fleet_nodes row\./,
    );
  });

  it("RegisterBodySchema 2-section shape pinned: mac_node_id UUID + livekit { api_key string min 1 max 256 + api_secret string min 1 max 1024 + ws_url url } + 'Wide URL bound — accepts wss://mac-NNN.driftstack.dev:8443 form per the orchestrator brief.' framing. Drift to dropping the api_secret max-1024 cap would let a customer POST a multi-MB string through; drift to dropping the UUID validator would break the fleet_nodes mac_node_id contract", () => {
    expect(body).toMatch(
      /mac_node_id: z\.string\(\)\.uuid\('mac_node_id must be a UUID matching an existing fleet_nodes row\.'\),/,
    );
    expect(body).toMatch(/api_key: z\.string\(\)\.min\(1\)\.max\(256\),/);
    expect(body).toMatch(/api_secret: z\.string\(\)\.min\(1\)\.max\(1024\),/);
    expect(body).toMatch(
      /\/\/ Wide URL bound — accepts wss:\/\/mac-NNN\.driftstack\.dev:8443\s*\n?\s*\/\/ form per the orchestrator brief\.\s*\n?\s*ws_url: z\.string\(\)\.url\(\),/,
    );
  });

  it("RegisterMacNodesRoutesDeps 5-field shape pinned: repo + encryptionKey + optional now() + optional adminAudit + optional metrics. + 'Secret material (api_key + api_secret) is NEVER payloaded into the audit row — only mac_node_id + ws_url, which are non-sensitive. Failures are swallowed so a metric/db hiccup doesn't break credential persistence.' framing — pinned so the audit-payload-never-secrets + best-effort-failures contract stays documented", () => {
    expect(body).toMatch(/export interface RegisterMacNodesRoutesDeps \{/);
    expect(body).toMatch(/repo: DrizzleFleetNodesRepo;/);
    expect(body).toMatch(
      /\/\*\* MFA_ENCRYPTION_KEY \(base64-encoded 32-byte AES-256 key\)\. \*\/\s*\n?\s*encryptionKey: string;/,
    );
    expect(body).toMatch(
      /\/\*\* Optional admin-audit emitter\. When wired, every successful\s*\n?\s*\*\s+registration writes an `mac_node\.livekit_registered` row\s*\n?\s*\*\s+attributing the operator\. Secret material \(api_key \+ api_secret\)\s*\n?\s*\*\s+is NEVER payloaded into the audit row — only mac_node_id \+\s*\n?\s*\*\s+ws_url, which are non-sensitive\. Failures are swallowed so a\s*\n?\s*\*\s+metric\/db hiccup doesn't break credential persistence\. \*\//,
    );
  });

  it("Arc 7 obs.16 metrics framing pinned: 'driftstack_mac_node_livekit_register_total{outcome}' + 'Outcome labels: ok / validation / encryption_error / not_found / unknown. Failures to .inc() are swallowed (best-effort).' — pinned so the 5-outcome bounded-cardinality contract stays documented (drift to a wider label space would create cardinality leaks)", () => {
    expect(body).toMatch(
      /\/\*\* Arc 7 obs\.16 — when wired, the route increments\s*\n?\s*\*\s+`driftstack_mac_node_livekit_register_total\{outcome\}` per call\.\s*\n?\s*\*\s+Outcome labels: ok \/ validation \/ encryption_error \/ not_found \/\s*\n?\s*\*\s+unknown\. Failures to \.inc\(\) are swallowed \(best-effort\)\. \*\//,
    );
    expect(body).toMatch(
      /deps\.metrics\?\.inc\(METRIC_NAMES\.macNodeLivekitRegisterTotal, \{ outcome \}\);/,
    );
  });

  it("encrypt-immediately-then-store framing pinned: 'Encrypt the plaintext secret immediately. The plaintext does NOT leave this scope — never written to logs, never echoed in the response.' + try/catch wrapping encryptLivekitSecret → BadRequestError on failure. Drift to logging the plaintext in a debug line would leak secrets through any access to the log aggregator", () => {
    expect(body).toMatch(
      /\/\/ Encrypt the plaintext secret immediately\. The plaintext does\s*\n?\s*\/\/ NOT leave this scope — never written to logs, never echoed\s*\n?\s*\/\/ in the response\./,
    );
    expect(body).toMatch(
      /ciphertextBase64 = encryptLivekitSecret\(body\.livekit\.api_secret, encryptionKey, \{\s*\n?\s*nodeId: body\.mac_node_id,\s*\n?\s*apiKey: body\.livekit\.api_key,\s*\n?\s*wsUrl: body\.livekit\.ws_url,\s*\n?\s*\}\);/,
    );
  });

  it("404 with V-820-provisioning-must-run-first detail pinned: 'Mac node ${body.mac_node_id} not found in fleet_nodes. The node must already be registered via the V-820 fleet-node provisioning path.' — pinned so the must-pre-exist + V-820 cross-reference operator-facing detail stays documented (drift to creating-on-not-found would let arbitrary UUIDs spawn fleet_nodes rows)", () => {
    expect(body).toMatch(
      /throw new NotFoundError\(\s*\n?\s*`Mac node \$\{body\.mac_node_id\} not found in fleet_nodes\. ` \+\s*\n?\s*'The node must already be registered via the V-820 fleet-node provisioning path\.',\s*\n?\s*\);/,
    );
  });

  it("Audit-payload non-sensitive-only framing pinned: 'The audit payload carries ONLY non-sensitive metadata (ws_url + mac_node_id); the api_key + api_secret never leave the encrypt scope above.' + action: 'mac_node.livekit_registered' + targetResourceId: `mac_node_${body.mac_node_id}` + inputPayload: { ws_url: body.livekit.ws_url } — pinned so the action-string + targetResourceId-prefix + ws_url-only-payload contract all stay documented (drift to including api_key in inputPayload would leak the key into the audit log)", () => {
    expect(body).toMatch(
      /The audit payload carries\s*\n?\s*\/\/ ONLY non-sensitive metadata \(ws_url \+ mac_node_id\); the\s*\n?\s*\/\/ api_key \+ api_secret never leave the encrypt scope above\./,
    );
    expect(body).toMatch(
      /action: 'mac_node\.livekit_registered',\s*\n?\s*targetResourceId: `mac_node_\$\{body\.mac_node_id\}`,\s*\n?\s*inputPayload: \{ ws_url: body\.livekit\.ws_url \},/,
    );
  });

  it("Response-3-field-no-api_key-echo framing pinned: 'Response is intentionally minimal — never echoes the api_key (treated as secret-equivalent per the orchestrator brief) and obviously never echoes the api_secret.' + { mac_node_id, livekit_registered_at, ws_url } — pinned so the api_key-treated-as-secret-equivalent + api_secret-never-echoed contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ Response is intentionally minimal — never echoes the api_key\s*\n?\s*\/\/ \(treated as secret-equivalent per the orchestrator brief\)\s*\n?\s*\/\/ and obviously never echoes the api_secret\./,
    );
    expect(body).toMatch(
      /return reply\.code\(200\)\.send\(\{\s*\n?\s*mac_node_id: updated\.id,\s*\n?\s*livekit_registered_at: updated\.livekit\?\.registeredAt\.toISOString\(\) \?\? now\(\)\.toISOString\(\),\s*\n?\s*ws_url: updated\.livekit\?\.wsUrl \?\? body\.livekit\.ws_url,\s*\n?\s*\}\);/,
    );
  });

  it("W628 GET /v1/mac-nodes operator-visibility endpoint: driftstack_internal_admin-gated, maps listActive() to a SECRET-SAFE DTO (has_livekit boolean, NOT the api_key/secret) + per-node connected (controlRegistry.get !== undefined, null when the registry isn't wired). Pinned so the read-only fleet window can't regress into leaking LiveKit credentials and keeps the connection-state field that makes worker bring-up debuggable", () => {
    // The endpoint exists, admin-gated.
    expect(body).toMatch(/app\.get\(\s*\n?\s*'\/v1\/mac-nodes',/);
    expect(body).toMatch(/app\.requireScope\('driftstack_internal_admin'\)/);
    // Secret-safe DTO: livekit collapsed to a boolean, never the credentials.
    expect(body).toMatch(/has_livekit: n\.livekit !== null,/);
    expect(body).not.toMatch(/api_secret: n\.|apiSecretCiphertextBase64: n\.|api_key: n\.livekit/);
    // connected derived from the control registry (keyed by the human node_id,
    // migration 0085), null when unwired. toContain fragments (prettier may wrap
    // the ternary; the key facts are the undefined-guard + the node_id lookup).
    expect(body).toContain('deps.controlRegistry === undefined');
    expect(body).toContain('deps.controlRegistry.get(n.nodeId) !== undefined');
    // controlRegistry is an optional dep (gated on FLEET_CONTROL_PLANE_ENABLED).
    expect(body).toMatch(/controlRegistry\?: FleetControlRegistry;/);
  });
});
