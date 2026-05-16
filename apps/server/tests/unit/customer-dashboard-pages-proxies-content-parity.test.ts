// EG-API-1.5 — drift guard for apps/customer-dashboard/src/pages/proxies.astro.
// Customer-facing /proxies page (saved-config library) per planning 133
// §"Cross-agent split" Agent 2 scope. Drift here either drops the SOCKS5
// UDP_ASSOCIATE default-on (would silently disable WebRTC routing in
// customer-saved configs) or breaks the activation-gate banner pattern
// (would surface a confusing error on a fresh customer's first visit
// before the EGRESS Phase 1 backend ships).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/proxies.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('EG-API-1.5 apps/customer-dashboard/src/pages/proxies.astro content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('Planning-133 framing pinned in source comment + Phase 1/2/3 roadmap reference', () => {
    expect(body).toMatch(/EG-API-1\.5 — customer-facing \/proxies page/);
    expect(body).toMatch(/per planning 133/);
    expect(body).toMatch(/Phase 1 surfaces[\s\S]*?only SOCKS5/);
  });

  it('resolveApiBaseUrl wired — no hardcoded prod URL (W192 single-source-of-truth pattern)', () => {
    expect(body).toMatch(/import \{ resolveApiBaseUrl \} from '\.\.\/lib\/api-base-url';/);
    expect(body).toMatch(/const apiBaseUrl = resolveApiBaseUrl\(\);/);
    expect(body).not.toMatch(/'https:\/\/api\.driftstack\.dev'/);
  });

  it('SOCKS5 create form: label + host + port + UDP ASSOCIATE checkbox default-checked + username/password optional inputs', () => {
    expect(body).toMatch(/<input\s+id="proxy-label"[^>]*maxlength="120"/);
    expect(body).toMatch(/<input\s+id="proxy-host"[^>]*maxlength="253"/);
    expect(body).toMatch(/<input\s+id="proxy-port"[^>]*type="number"[^>]*min="1"[^>]*max="65535"/);
    expect(body).toMatch(/<input\s+id="proxy-udp"\s+type="checkbox"\s+checked/);
    expect(body).toMatch(
      /<input\s+id="proxy-password"[^>]*type="password"[^>]*autocomplete="new-password"/,
    );
  });

  it('save-proxy handler POSTs to /v1/proxies with SavedProxyConfigSchema-shaped body { label, proxy: { type:"socks5", socks5:{host,port,udp_associate,?username,?password} } }', () => {
    expect(body).toMatch(/fetch\(apiBaseUrl \+ '\/v1\/proxies'/);
    expect(body).toMatch(/method: 'POST'/);
    expect(body).toMatch(/type: 'socks5',\s*\n?\s+socks5: \{/);
    expect(body).toMatch(/udp_associate,/);
  });

  it('503 handler surfaces planning-133-aware message ("Saved-proxy storage is not yet wired ... after the EGRESS Phase 1 backend ships") — pins the activation-gate UX so fresh customers do not see a bare HTTP-503 banner before the backend lands', () => {
    expect(body).toMatch(/if \(res\.status === 503\)/);
    expect(body).toMatch(/Saved-proxy storage is not yet wired/);
    expect(body).toMatch(/EGRESS Phase 1 backend ships/);
  });

  it('list fetch wires GET /v1/proxies with the web-session-token Bearer + renders { data: [] } empty state', () => {
    expect(body).toMatch(/await fetch\(apiBaseUrl \+ '\/v1\/proxies'/);
    expect(body).toMatch(/'No saved proxies yet\.'/);
  });

  it('delete handler wires DELETE /v1/proxies/<id> via delegated click + window.confirm guard', () => {
    expect(body).toMatch(/method: 'DELETE'/);
    expect(body).toMatch(/'\/v1\/proxies\/' \+ encodeURIComponent\(id\)/);
    expect(body).toMatch(/window\.confirm\('Delete this saved proxy\?'\)/);
  });

  it('Phase 2 OpenVPN + Phase 3 WireGuard placeholder cards pinned (planning 133 phased roadmap)', () => {
    expect(body).toMatch(/Phase 2[\s\S]*?OpenVPN/);
    expect(body).toMatch(/Phase 3[\s\S]*?WireGuard/);
    expect(body).toMatch(/Apple\s+Virtualization\.framework Lightweight VM/);
  });

  it("UDP ASSOCIATE hint text is the WebRTC rationale (not a stylistic note) — pins the planning-133 reason so a future copy-edit doesn't lose the signal that disabling UDP ASSOCIATE breaks WebRTC routing", () => {
    expect(body).toMatch(/Required for WebRTC/);
  });
});
