// Drift guard for apps/server/src/routes/saved-proxies.ts. Pins
// EG-API-1.3 POST + GET + DELETE /v1/proxies (saved reusable
// customer proxy configs). Activation-gate matches per-session proxy
// routes (EG-API-1.2). SECURITY: saved configs carry the same secret
// material as per-session configs — never logged, never echoed back,
// customer can't re-read their own raw key after save.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/saved-proxies.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('routes/saved-proxies content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("EG-API-1.3 module-level framing pinned: 'POST + GET + DELETE /v1/proxies (saved reusable customer proxy configs). Planning 133 §\"Cross-agent split\" Agent 2 scope: POST /v1/proxies — store reusable proxy config + GET /v1/proxies — list caller's saved configs + DELETE /v1/proxies/{id} — remove a saved config.' — pinned so the EG-API-1.3 anchor + planning-133-cross-agent-split + 3-verb-roster all stay documented", () => {
    expect(body).toMatch(
      /\/\/ EG-API-1\.3 — POST \+ GET \+ DELETE \/v1\/proxies \(saved reusable\s*\n?\s*\/\/ customer proxy configs\)\./,
    );
    expect(body).toMatch(
      /\/\/\s+- POST\s+\/v1\/proxies\s+— store reusable proxy config\s*\n?\s*\/\/\s+- GET\s+\/v1\/proxies\s+— list caller's saved configs/,
    );
    expect(body).toMatch(/\/\/\s+- DELETE \/v1\/proxies\/\{id\}\s+— remove a saved config/);
  });

  it("EG-API-1.7 reachability-test verb pinned: POST /v1/proxies/{id}/test runs a Mac-fleet reachability + UDP-ASSOCIATE check, 503 FeatureUnavailable until the fleet-side runner lands — pinned so the test verb stays documented + the pre-runner 503 contract (dashboard surfaces 'scheduled, runs from a Mac node' rather than a 404) doesn't silently drift", () => {
    expect(body).toMatch(/EG-API-1\.7 adds the reachability-test verb\./);
    expect(body).toMatch(
      /\/\/\s+- POST\s+\/v1\/proxies\/\{id\}\/test — reachability \+ UDP-ASSOCIATE check/,
    );
    expect(body).toMatch(/'\/v1\/proxies\/:id\/test'/);
    expect(body).toMatch(
      /throw new FeatureUnavailableError\(\s*\n?\s*'Proxy reachability testing is not yet wired on this server\./,
    );
  });

  it("Activation-gate framing pinned: 'Activation gate matches the per-session proxy routes (EG-API-1.2): sessionEgressService undefined → registerSavedProxiesDisabledRoutes registers 503 FeatureUnavailable stubs. When a backend lands the service-layer storage shape is the SavedProxyConfigSchema envelope (label + proxy) from @driftstack/api-types (EG-API-1.1).' — pinned so the EG-API-1.2 cross-reference + SavedProxyConfigSchema envelope contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ Activation gate matches the per-session proxy routes \(EG-API-1\.2\):\s*\n?\s*\/\/ `sessionEgressService` undefined → `registerSavedProxiesDisabledRoutes`\s*\n?\s*\/\/ registers 503 FeatureUnavailable stubs\. When a backend lands the\s*\n?\s*\/\/ service-layer storage shape is the SavedProxyConfigSchema envelope\s*\n?\s*\/\/ \(label \+ proxy\) from @driftstack\/api-types \(EG-API-1\.1\)\./,
    );
  });

  it("SECURITY framing pinned: 'saved configs carry the same secret material as per-session configs (SOCKS5 password, OpenVPN .ovpn, WireGuard private key). The storage layer must apply the same protections as session-egress: AES-256-GCM at-rest envelope, never logged, never echoed back in list/get responses (only label + type + masked summary surfaces to the dashboard; the customer can't re-read their own raw key after save — they have to re-enter to update).' — pinned so the AES-256-GCM-envelope + never-logged + never-echoed + customer-can't-re-read contract all stay documented (drift to letting list responses include raw secrets would break the no-re-read promise that protects against session-hijack-leaks-stored-secrets)", () => {
    expect(body).toMatch(
      /\/\/ SECURITY: saved configs carry the same secret material as per-session\s*\n?\s*\/\/ configs \(SOCKS5 password, OpenVPN \.ovpn, WireGuard private key\)\. The\s*\n?\s*\/\/ storage layer must apply the same protections as session-egress:\s*\n?\s*\/\/ AES-256-GCM at-rest envelope, never logged, never echoed back in\s*\n?\s*\/\/ list\/get responses \(only label \+ type \+ masked summary surfaces to\s*\n?\s*\/\/ the dashboard; the customer can't re-read their own raw key after\s*\n?\s*\/\/ save — they have to re-enter to update\)\./,
    );
  });

  it("POST /v1/proxies EG-API-1.6-wires-backend 503 framing pinned: 'Saved-proxy storage is not yet wired on this server. EG-API-1.6 wires the backend.' + SavedProxyConfigSchema.safeParse(req.body) + ValidationError on parse failure. Drift to dropping the SavedProxyConfigSchema validation would let unvalidated body shapes through to the storage backend", () => {
    expect(body).toMatch(
      /const parsed = SavedProxyConfigSchema\.safeParse\(req\.body\);\s*\n?\s*if \(!parsed\.success\) throw new ValidationError\(parsed\.error\.flatten\(\)\);/,
    );
    expect(body).toMatch(
      /throw new FeatureUnavailableError\(\s*\n?\s*'Saved-proxy storage is not yet wired on this server\. EG-API-1\.6 wires the backend\.',\s*\n?\s*\);/,
    );
  });

  it("W491 write-scope gate pinned on all 3 mutations — POST /v1/proxies, POST /v1/proxies/:id/test, DELETE /v1/proxies/:id each carry app.requireScope('write') in preHandler. A read-only API key is blocked (403) before the handler; drift to dropping it lets a read-only key mutate proxies (least-privilege hole).", () => {
    const gated = body.match(
      /preHandler: \[app\.requireAuth, app\.requireScope\('write'\), app\.rateLimit\('global'\)\]/g,
    );
    expect(gated?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("GET /v1/proxies 200-empty-pre-backend framing pinned: 'List returns 200 with empty data even pre-backend so the dashboard's \"no saved proxies yet\" empty state renders the same as a customer with no saved configs. This avoids a confusing 503 on what's a read-only listing.' + { data: [] as Array<{ id: string; label: string; type: string }> } — pinned so the empty-state-vs-503 UX contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ List returns 200 with empty data even pre-backend so the\s*\n?\s*\/\/ dashboard's "no saved proxies yet" empty state renders the\s*\n?\s*\/\/ same as a customer with no saved configs\. This avoids a\s*\n?\s*\/\/ confusing 503 on what's a read-only listing\./,
    );
    expect(body).toMatch(
      /return \{ data: \[\] as Array<\{ id: string; label: string; type: string \}> \};/,
    );
  });

  it("DELETE /v1/proxies/:id 404-every-id framing pinned: 'No saved proxies exist yet → every id is 404.' + NotFoundError(`Saved proxy ${req.params.id} not found.`) — pinned so the always-404 pre-backend contract stays documented", () => {
    expect(body).toMatch(/\/\/ No saved proxies exist yet → every id is 404\./);
    expect(body).toMatch(
      /throw new NotFoundError\(`Saved proxy \$\{req\.params\.id\} not found\.`\);/,
    );
  });

  it("Disabled-stub customer-facing detail framing pinned: 'Customer-configurable egress (SOCKS5 / OpenVPN / WireGuard) is not yet shipped. Phase 1 SOCKS5 support is on the roadmap; until then sessions route through Driftstack's default egress.' — pinned so the customer-readable-roadmap (not internal planning-133 jargon) contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ Customer-facing detail\. "planning file 133" is internal\s*\n?\s*\/\/ nomenclature; customers don't have access\. Drop the internal\s*\n?\s*\/\/ reference and surface the Phase 1 SOCKS5 roadmap framing in\s*\n?\s*\/\/ customer-readable terms\./,
    );
    expect(body).toMatch(
      /'Customer-configurable egress \(SOCKS5 \/ OpenVPN \/ WireGuard\) is not yet ' \+\s*\n?\s*'shipped\. Phase 1 SOCKS5 support is on the roadmap; until then sessions ' \+\s*\n?\s*"route through Driftstack's default egress\.";/,
    );
  });

  it('Disabled-stub variant 3-verb registration pinned: app.post("/v1/proxies", stub) + app.get("/v1/proxies", () => ({ data: [] })) + app.delete("/v1/proxies/:id", stub). The GET-returns-empty-200 even in disabled mode is the same UX contract as the wired-mode GET', () => {
    expect(body).toMatch(/app\.post\('\/v1\/proxies', stub\);/);
    expect(body).toMatch(
      /app\.get\('\/v1\/proxies', \(\) => \(\{\s*\n?\s*data: \[\] as Array<\{ id: string; label: string; type: string \}>,\s*\n?\s*\}\)\);/,
    );
    expect(body).toMatch(/app\.delete\('\/v1\/proxies\/:id', stub\);/);
  });
});
