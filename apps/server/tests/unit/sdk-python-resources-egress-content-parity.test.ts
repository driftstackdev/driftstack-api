// Drift guard for packages/sdk-python/src/driftstack/resources/egress.py.
// Pins the planning 133 EGRESS Python surface — sync/async mirror +
// the 'raw secrets NEVER readable after save' SECURITY contract +
// 5-method shape + cross-SDK uniformity with TS commit 041ef7a9.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/egress.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('sdk-python resources/egress content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("Module-level docstring planning 133 anchor framing pinned: 'Egress resource — /v1/sessions/{id}/proxy + /v1/proxies (planning 133). Customer-configurable egress (SOCKS5 / OpenVPN / WireGuard). Mirrors the TypeScript EgressResource (commit 041ef7a9).' — pinned so the planning 133 anchor + 3-proxy-type taxonomy + TS-commit-mirror reference all survive", () => {
    expect(body).toMatch(
      /"""Egress resource — \/v1\/sessions\/\{id\}\/proxy \+ \/v1\/proxies \(planning 133\)\.\s*\n?\s*Customer-configurable egress \(SOCKS5 \/ OpenVPN \/ WireGuard\)\. Mirrors\s*\n?\s*the TypeScript ``EgressResource`` \(commit 041ef7a9\)\./,
    );
  });

  it("503 activation-gate framing pinned: 'Activation gate on the server returns 503 FeatureUnavailable until a concrete backend is wired; the SDK surface is stable so consumers compile ahead of time.' — pinned so the stable-now-stub-mode contract stays uniform across all 3 SDKs", () => {
    expect(body).toMatch(
      /Activation gate\s*\n?\s*on the server returns 503 ``FeatureUnavailable`` until a concrete\s*\n?\s*backend is wired; the SDK surface is stable so consumers compile\s*\n?\s*ahead of time\./,
    );
  });

  it("SECURITY 'raw secrets NEVER echoed' framing pinned: 'list/get responses NEVER echo raw secret material (SOCKS5 password, OpenVPN .ovpn body, WireGuard private_key); re-enter to update.' — pinned so the write-only secret contract stays explicit on the Python side. Drift on one SDK would silently diverge the documented privacy contract from its peers (TS + Go) and open a path to inconsistent server enforcement", () => {
    expect(body).toMatch(
      /SECURITY: list\/get responses NEVER echo raw secret material\s*\n?\s*\(SOCKS5 password, OpenVPN \.ovpn body, WireGuard private_key\);\s*\n?\s*re-enter to update\./,
    );
  });

  it('attach_to_session SessionEgressConfig + session_id-MUST-match framing pinned: \'config MUST conform to SessionEgressConfig: {"session_id": "...", "proxy": {"type": "...", ...}, "egress_safeguard": {...}}. The body\'s session_id MUST match the URL session_id or the server rejects with 400.\' — pinned so the 3-key config shape + the match-or-400 contract stay explicit (drift to a different config shape would mismatch the server validation)', () => {
    expect(body).toMatch(
      /``config`` MUST conform to ``SessionEgressConfig``:\s*\n?\s*``\{"session_id": "\.\.\.", "proxy": \{"type": "\.\.\.", \.\.\.\},\s*\n?\s*"egress_safeguard": \{\.\.\.\}\}``\. The body's ``session_id`` MUST\s*\n?\s*match the URL ``session_id`` or the server rejects with 400\./,
    );
  });

  it("save_proxy 'reusable proxy config' framing pinned + 2-key body shape ({label, proxy}). Drift to dropping label would break the dashboard's saved-proxy list (no human-meaningful identifier)", () => {
    expect(body).toMatch(
      /Save a reusable proxy config\.\s*\n?\s*\s*\n?\s*Body shape: ``\{"label": "\.\.\.", "proxy": \{\.\.\.\}\}``\./,
    );
  });

  it('Sync EgressResource 5-method surface pinned: attach_to_session + get_session_proxy + save_proxy + list_saved_proxies + delete_saved_proxy. Drift to dropping a method would break Python customers; drift to adding get_saved_proxy(id) would re-introduce the raw-secret-leak path that the SECURITY note forbids', () => {
    expect(body).toMatch(/class EgressResource:/);
    expect(body).toMatch(
      /def attach_to_session\(self, session_id: str, config: dict\[str, Any\]\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(/def get_session_proxy\(self, session_id: str\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/def save_proxy\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/def list_saved_proxies\(self\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/def delete_saved_proxy\(self, proxy_id: str\) -> None:/);
  });

  it('Async AsyncEgressResource 5-method mirror pinned. Drift would break asyncio/FastAPI consumers OR break the sync/async parity', () => {
    expect(body).toMatch(/class AsyncEgressResource:/);
    expect(body).toMatch(/async def attach_to_session\(/);
    expect(body).toMatch(/async def get_session_proxy\(/);
    expect(body).toMatch(/async def save_proxy\(/);
    expect(body).toMatch(/async def list_saved_proxies\(self\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/async def delete_saved_proxy\(self, proxy_id: str\) -> None:/);
  });

  it("quote(...,safe='') on all id-bearing routes for BOTH sync + async (attach_to_session/get_session_proxy/delete_saved_proxy). Parity with TS encodeURIComponent + Go url.PathEscape", () => {
    expect(body).toMatch(/f"\/v1\/sessions\/\{quote\(session_id, safe=''\)\}\/proxy"/);
    expect(body).toMatch(/f"\/v1\/proxies\/\{quote\(proxy_id, safe=''\)\}"/);
  });

  it('coerce_body() on all non-empty bodies (attach_to_session config + save_proxy body) for sync + async. Drift would break the cross-SDK Decimal/datetime handling helper', () => {
    expect(body).toMatch(/json_body=coerce_body\(config\)/);
    expect(body).toMatch(/json_body=coerce_body\(body\)/);
  });
});
