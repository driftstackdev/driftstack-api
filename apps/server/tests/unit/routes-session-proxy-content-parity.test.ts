// Drift guard for apps/server/src/routes/session-proxy.ts. Pins
// EG-API-1.2 POST + GET /v1/sessions/{id}/proxy — per-session proxy
// config. Activation-gate matches saved-proxies (EG-API-1.3).
// SECURITY: proxy configs carry customer secrets (SOCKS5 password,
// OpenVPN .ovpn including embedded private keys, WireGuard private
// key). The route layer ONLY validates the shape + dispatches to the
// service; never echoes body fields in error responses.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/session-proxy.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('routes/session-proxy content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("EG-API-1.2 module-level framing pinned: 'POST /v1/sessions/{id}/proxy + GET /v1/sessions/{id}/proxy. Planning 133 §\"Cross-agent split\" Agent 2 scope: POST /v1/sessions/{id}/proxy — set proxy config for a session + GET /v1/sessions/{id}/proxy — fetch current session's proxy config.' — pinned so the EG-API-1.2 anchor + planning-133-cross-agent-split + 2-verb-roster all stay documented", () => {
    expect(body).toMatch(
      /\/\/ EG-API-1\.2 — POST \/v1\/sessions\/\{id\}\/proxy \+ GET \/v1\/sessions\/\{id\}\/proxy\./,
    );
    expect(body).toMatch(
      /\/\/\s+- POST \/v1\/sessions\/\{id\}\/proxy — set proxy config for a session\s*\n?\s*\/\/\s+- GET\s+\/v1\/sessions\/\{id\}\/proxy — fetch current session's proxy config/,
    );
  });

  it("Activation-gate framing pinned: 'routes register only when sessionEgressService is wired in AppDeps (i.e., a concrete SOCKS5/OpenVPN/WireGuard backend is configured). Until then registerSessionProxyDisabledRoutes registers 503 FeatureUnavailable stubs so the customer dashboard + SDK clients get a machine-readable signal instead of bare 404.' — pinned so the 3-backend-types + 503-vs-404 + machine-readable-signal contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Activation gate: routes register only when `sessionEgressService` is\s*\n?\s*\/\/ wired in AppDeps \(i\.e\., a concrete SOCKS5\/OpenVPN\/WireGuard backend\s*\n?\s*\/\/ is configured\)\. Until then `registerSessionProxyDisabledRoutes`\s*\n?\s*\/\/ registers 503 FeatureUnavailable stubs so the customer dashboard \+\s*\n?\s*\/\/ SDK clients get a machine-readable signal instead of bare 404\./,
    );
  });

  it("W495/W509 write:sessions gate pinned: POST /v1/sessions/:id/proxy carries app.requireScope('write:sessions') — granular, consistent with the sibling /v1/sessions/:id/* mutations (navigate/interact/capture). W495 wrongly used broad 'write' (a write:sessions CI key wouldn't satisfy it); W509 corrected to write:sessions.", () => {
    expect(body).toMatch(
      /'\/v1\/sessions\/:id\/proxy',[\s\S]*?\{ preHandler: \[app\.requireAuth, app\.requireScope\('write:sessions'\), app\.rateLimit\('global'\)\] \},/,
    );
  });

  it('GET and both disabled stubs preserve the matching granular scope boundary', () => {
    expect(body).toMatch(
      /app\.get<\{ Params: \{ id: string \} \}>\(\s*'\/v1\/sessions\/:id\/proxy',\s*\{ preHandler: \[app\.requireAuth, app\.requireScope\('read:sessions'\), app\.rateLimit\('global'\)\] \},/,
    );
    expect(body).toMatch(
      /app\.post\('\/v1\/sessions\/:id\/proxy', \{\s*preHandler: \[app\.requireAuth, app\.requireScope\('write:sessions'\), app\.rateLimit\('global'\)\],\s*handler: stub,/,
    );
    expect(body).toMatch(
      /app\.get\('\/v1\/sessions\/:id\/proxy', \{\s*preHandler: \[app\.requireAuth, app\.requireScope\('read:sessions'\), app\.rateLimit\('global'\)\],\s*handler: stub,/,
    );
  });

  it("Cross-agent contract body-shape framing pinned: '@driftstack/api-types/egress (EG-API-1.1)' + 3-field body shape (session_id matching URL :id + proxy + optional egress_safeguard defaulting safeguards-on). Drift to dropping the session_id-matches-URL check would let a body carry a different id than the URL and create an audit-log mismatch", () => {
    expect(body).toMatch(
      /\/\/ The route consumes the cross-agent contract schema from\s*\n?\s*\/\/ `@driftstack\/api-types\/egress` \(EG-API-1\.1\)\. Body shape:/,
    );
    expect(body).toMatch(/\/\/\s+"session_id": "ses_xxx",\s+\/\/ must match URL :id/);
    expect(body).toMatch(
      /\/\/\s+"egress_safeguard": \{ \.\.\. \}\s+\/\/ optional; defaults safeguards-on/,
    );
  });

  it("SECURITY framing pinned: 'proxy configs carry customer secrets (SOCKS5 password, OpenVPN .ovpn including embedded private keys, WireGuard private key). The service layer is responsible for: Storing on tmpfs only for the session lifetime + AES-256-GCM at-rest envelope + Hashing the config for the audit log (never raw) + Zeroing on session-end. This route layer ONLY validates the shape + dispatches to the service; do NOT echo body fields in error responses.' — pinned so the 4-layer-protection roster + route-layer-do-not-echo-body contract all stay documented (drift to letting body fields flow into ValidationError detail would leak SOCKS5 passwords / OpenVPN .ovpn / WireGuard private keys into client error responses + likely log aggregators)", () => {
    expect(body).toMatch(
      /\/\/ SECURITY: proxy configs carry customer secrets \(SOCKS5 password,\s*\n?\s*\/\/ OpenVPN \.ovpn including embedded private keys, WireGuard private\s*\n?\s*\/\/ key\)\. The service layer is responsible for:\s*\n?\s*\/\/\s+- Storing on tmpfs only for the session lifetime\s*\n?\s*\/\/\s+- AES-256-GCM at-rest envelope\s*\n?\s*\/\/\s+- Hashing the config for the audit log \(never raw\)\s*\n?\s*\/\/\s+- Zeroing on session-end\s*\n?\s*\/\/ This route layer ONLY validates the shape \+ dispatches to the\s*\n?\s*\/\/ service; do NOT echo body fields in error responses\./,
    );
  });

  it("Body-session_id-must-match-URL-id BadRequestError framing pinned: 'Body session_id must match the URL :id (cross-cutting body/URL mismatch).' + parsed.data.session_id !== id branch. Drift to dropping this check would let body+URL diverge and create audit-log mismatches between the URL'd session id and the proxy applied", () => {
    expect(body).toMatch(
      /if \(parsed\.data\.session_id !== id\) \{\s*\n?\s*throw new BadRequestError\(\s*\n?\s*'Body session_id must match the URL :id \(cross-cutting body\/URL mismatch\)\.',\s*\n?\s*\);/,
    );
  });

  it("POST 503-on-pre-EG-API-1.6 framing pinned: 'Session-egress backends (SOCKS5 / OpenVPN / WireGuard) are not yet wired on this server. EG-API-1.2 route surface is registered; EG-API-1.6 wires the per-session harness propagation. Tracking via planning 133.' + applyToSession EgressHandle harness-consumes framing + 202-Accepted-with-type+safeguard-summary contract — pinned so the route-vs-propagation separation + Phase-1-SOCKS5-target contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ For Phase 1 SOCKS5 wiring, EG-API-1\.6 will await this call\s*\n?\s*\/\/ and propagate the EgressHandle to the per-session harness\s*\n?\s*\/\/ launcher\. Until then the service is the only place that\s*\n?\s*\/\/ touches secrets; the route returns 202 Accepted with the\s*\n?\s*\/\/ type \+ safeguard summary\./,
    );
    expect(body).toMatch(
      /throw new FeatureUnavailableError\(\s*\n?\s*'Session-egress backends \(SOCKS5 \/ OpenVPN \/ WireGuard\) are not yet wired on this server\. ' \+\s*\n?\s*'EG-API-1\.2 route surface is registered; EG-API-1\.6 wires the per-session harness propagation\. ' \+\s*\n?\s*'Tracking via planning 133\.',\s*\n?\s*\);/,
    );
  });

  it("GET 404-no-proxy-config framing pinned: 'EG-API-1.6 backs this with a real read from session-egress state (config_hash + type + safeguard flags only — never raw config). For now the route surfaces 404 because no session has a proxy applied (no backend wired); same activation-gate logic as POST.' + NotFoundError('No proxy config for this session.') — pinned so the config_hash-only + never-raw-config + same-as-POST activation-gate contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ EG-API-1\.6 backs this with a real read from session-egress\s*\n?\s*\/\/ state \(config_hash \+ type \+ safeguard flags only — never raw\s*\n?\s*\/\/ config\)\. For now the route surfaces 404 because no session\s*\n?\s*\/\/ has a proxy applied \(no backend wired\); same activation-gate\s*\n?\s*\/\/ logic as POST\./,
    );
    expect(body).toMatch(/throw new NotFoundError\('No proxy config for this session\.'\);/);
  });

  it("Disabled-stub customer-facing detail framing pinned: 'Customer-configurable egress (SOCKS5 / OpenVPN / WireGuard) is not yet shipped. Phase 1 SOCKS5 support is on the roadmap; until then sessions route through Driftstack's default egress.' + symmetric-with-saved-proxies framing — pinned so the customer-readable-roadmap (not internal planning-133 jargon) + symmetric-disabled-stub-detail contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ Customer-facing detail\. "planning file 133" is internal\s*\n?\s*\/\/ nomenclature; customers don't have access\. Drop the internal\s*\n?\s*\/\/ reference and surface the Phase 1 SOCKS5 roadmap framing in\s*\n?\s*\/\/ customer-readable terms\. Matches the symmetric saved-proxies\s*\n?\s*\/\/ disabled-stub detail\./,
    );
  });

  it("Schema re-export framing pinned: 'Re-export the ProxyConfigSchema for testability — consumers that want to validate a proxy body without the SessionEgressConfig envelope can use this directly. Marked here rather than in egress.ts because the schema's location is API-package, not route-package.' + export { ProxyConfigSchema } — pinned so the route-package-re-export-for-testability + schema-lives-in-api-package contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ Re-export the ProxyConfigSchema for testability — consumers that\s*\n?\s*\/\/ want to validate a proxy body without the SessionEgressConfig\s*\n?\s*\/\/ envelope can use this directly\. Marked here rather than in egress\.ts\s*\n?\s*\/\/ because the schema's location is API-package, not route-package\./,
    );
    expect(body).toMatch(/export \{ ProxyConfigSchema \};/);
  });
});
