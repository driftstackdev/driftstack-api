// Drift guard for packages/sdk-typescript/src/resources/egress.ts.
// Pins the planning 133 / EGRESS Phase 1 surface — per-session proxy
// attach + saved proxy library + the load-bearing 'raw secrets never
// returned after save' contract.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/egress.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('sdk-typescript resources/egress content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('Module-level EgressResource framing pinned: planning 133 / Wave 1119 EGRESS Phase 1 anchor + 2-surface taxonomy (per-session proxy attach + saved proxy library). Drift to dropping the planning 133 anchor would orphan the cross-agent contract reference; drift to dropping the 2-surface split would conflate per-session vs. saved-library state', () => {
    expect(body).toMatch(
      /\/\/ EgressResource — typed methods for \/v1\/sessions\/\{id\}\/proxy \+\s*\n?\s*\/\/ \/v1\/proxies \(planning 133 \/ Wave 1119 EGRESS Phase 1 onwards\)\./,
    );
    expect(body).toMatch(
      /\/\/ {3}1\. Per-session proxy attach — set the SOCKS5\/OpenVPN\/WireGuard\s*\n?\s*\/\/ {6}config that THIS session's browser routes through\./,
    );
    expect(body).toMatch(/\/\/ {3}2\. Saved proxy library — store reusable proxy configs by label/);
  });

  it("SECURITY 'raw secrets never readable after save' contract pinned: 'list/get responses return ONLY { id, label, type } (or { type, safeguards } for the per-session read) — the raw proxy secrets (SOCKS5 password / OpenVPN .ovpn / WireGuard private_key) are NEVER readable after save (planning 133 § Cross-agent split SECURITY note). Customers re-enter to update.' — pinned so the write-only secret contract (no echo back, no get-by-id) survives. Drift to returning raw secrets in list/get responses would leak customer credentials via the standard read path", () => {
    expect(body).toMatch(
      /\/\/ SECURITY: list\/get responses return ONLY `\{ id, label, type \}`\s*\n?\s*\/\/ \(or `\{ type, safeguards \}` for the per-session read\) — the raw\s*\n?\s*\/\/ proxy secrets \(SOCKS5 password \/ OpenVPN \.ovpn \/ WireGuard\s*\n?\s*\/\/ private_key\) are NEVER readable after save \(planning 133 §\s*\n?\s*\/\/ "Cross-agent split" SECURITY note\)\. Customers re-enter to update\./,
    );
  });

  it("Activation-gate framing pinned: '503 FeatureUnavailable stubs until a concrete SOCKS5 backend lands (EG-API-1.6 propagation slice). The SDK surface is stable now so consumers can compile against it without waiting for the runtime backend.' — pinned so the EG-API-1.6 dependency + the stable-now-stub-mode contract stays explicit (drift to dropping the activation-gate caveat would mislead SDK consumers about 503 expectations)", () => {
    expect(body).toMatch(
      /\/\/ Activation gate: the server registers these endpoints as 503\s*\n?\s*\/\/ FeatureUnavailable stubs until a concrete SOCKS5 backend lands\s*\n?\s*\/\/ \(EG-API-1\.6 propagation slice\)\./,
    );
  });

  it("SessionProxyAttachResponse 3-safeguard catalog pinned: block_direct_internet + block_unproxied_dns + block_webrtc_stun_leakage (all bool). Drift to dropping a safeguard flag would break the dashboard's safeguard-summary widget; drift to weakening to optional would let the server return undefined and the dashboard render falsy as 'safeguard off' even when the server enforces it", () => {
    expect(body).toMatch(
      /export interface SessionProxyAttachResponse \{\s*\n?\s*type: ProxyType;\s*\n?\s*safeguards: \{\s*\n?\s*block_direct_internet: boolean;\s*\n?\s*block_unproxied_dns: boolean;\s*\n?\s*block_webrtc_stun_leakage: boolean;\s*\n?\s*\};\s*\n?\s*\}/,
    );
  });

  it('SavedProxySummary 3-field surface: id + label + type. Drift to including the raw config in the summary would re-introduce the write-only secret leak; drift to dropping label would force the dashboard to render saved proxies as just an id', () => {
    expect(body).toMatch(
      /export interface SavedProxySummary \{\s*\n?\s*id: string;\s*\n?\s*label: string;\s*\n?\s*type: ProxyType;\s*\n?\s*\}/,
    );
  });

  it('ListSavedProxiesResponse envelope shape pinned: { data: ReadonlyArray<SavedProxySummary> }. Drift to a bare array (no data wrapper) would diverge from the cross-resource list-envelope convention + break openapi-derived clients', () => {
    expect(body).toMatch(
      /export interface ListSavedProxiesResponse \{\s*\n?\s*data: ReadonlyArray<SavedProxySummary>;\s*\n?\s*\}/,
    );
  });

  it('Cross-package import of ProxyType / SavedProxyConfig / SessionEgressConfig from @driftstack/api-types pinned: single source of truth for the proxy-config shapes shared across server + dashboard + SDK. Drift to a local-only type would let the SDK shape diverge from the server enforcement', () => {
    expect(body).toMatch(
      /import type \{ ProxyType, SavedProxyConfig, SessionEgressConfig \} from '@driftstack\/api-types';/,
    );
  });

  it("EgressResource 5-method surface: attachToSession + getSessionProxy + saveProxy + listSavedProxies + deleteSavedProxy. Drift to dropping a method would break dashboard wiring; drift to adding a 'getSavedProxy(id)' would re-introduce the raw-secret-leak path the SECURITY note explicitly forbids", () => {
    expect(body).toMatch(/export class EgressResource \{/);
    expect(body).toMatch(
      /attachToSession\(\s*\n?\s*sessionId: string,\s*\n?\s*config: SessionEgressConfig,\s*\n?\s*\): Promise<SessionProxyAttachResponse>/,
    );
    expect(body).toMatch(
      /getSessionProxy\(sessionId: string\): Promise<SessionProxyAttachResponse>/,
    );
    expect(body).toMatch(/saveProxy\(body: SavedProxyConfig\): Promise<SavedProxySummary>/);
    expect(body).toMatch(/listSavedProxies\(\): Promise<ListSavedProxiesResponse>/);
    expect(body).toMatch(/deleteSavedProxy\(id: string\): Promise<void>/);
  });

  it("attachToSession 'session_id MUST match sessionId, server rejects mismatched pairs with 400 BadRequest' framing pinned. Drift to dropping the match-or-reject framing would let customers waste time debugging why mismatched body.session_id + URL sessionId calls don't work", () => {
    expect(body).toMatch(
      /NB: the request body's `session_id` MUST match `sessionId` here;\s*\n?\s*\*\s+the server rejects mismatched pairs with 400 BadRequest\./,
    );
  });

  it("getSessionProxy 404 → 'running unproxied' framing pinned: 'Returns 404 if no proxy has been attached yet — callers should treat that as the session is currently running unproxied (the API-layer safeguard refuses session-create without proxy when the backend is wired, but pre-wire deployments don't enforce that).' — pinned so the 404-is-not-an-error semantic + the wire-status-determines-enforcement caveat stay explicit (drift to throwing on 404 would break the dashboard's 'no proxy attached' rendering)", () => {
    expect(body).toMatch(
      /Returns 404 if no\s*\n?\s*\*\s+proxy has been attached yet — callers should treat that as\s*\n?\s*\*\s+"the session is currently running unproxied"/,
    );
  });

  it('Path encodeURIComponent pinned on all id-bearing routes (attachToSession + getSessionProxy + deleteSavedProxy). Drift to dropping encodeURIComponent would break customers whose ids contain reserved URI chars', () => {
    expect(body).toMatch(/`\/v1\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/proxy`/);
    expect(body).toMatch(/`\/v1\/proxies\/\$\{encodeURIComponent\(id\)\}`/);
  });
});
