// EG-API-1.1 — drift guard for packages/api-types/src/egress.ts.
// Customer-configurable egress per-session config schema. The shape
// here is the binding cross-agent contract per
// `docs/planning/133-egress-architecture-cross-agent.md` in the
// driftstack repo (LOCKED by founder verdict 2026-05-16).
//
// Drift here either changes the per-protocol field shape (Agent 1 +
// harness would deserialize incompatibly) or relaxes the egress
// safeguard defaults (would let sessions egress without proxy, breaking
// CLAUDE.md "Egress safeguards enforce: sessions cannot egress without
// proxy" non-negotiable). Cross-agent contract changes require a
// concurrent update to planning file 133 in the same PR.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EgressSafeguardSchema,
  OpenVpnProxyConfigSchema,
  ProxyConfigSchema,
  ProxyTypeSchema,
  SavedProxyConfigSchema,
  SessionEgressConfigSchema,
  SocksProxyConfigSchema,
  WireGuardProxyConfigSchema,
} from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/api-types/src/egress.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('EG-API-1.1 packages/api-types/src/egress.ts content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('Planning-133 source-of-truth framing pinned + supersession note for the f7bab517 session-egress.ts scaffold + cross-agent-contract change-coordination rule', () => {
    expect(body).toMatch(
      /Source of truth: docs\/planning\/133-egress-architecture-cross-agent\.md/,
    );
    expect(body).toMatch(
      /SUPERSEDES the earlier `apps\/server\/src\/services\/session-egress\.ts`/,
    );
    expect(body).toMatch(
      /any breaking change here is a breaking change to the\s*\n?\s*\/\/ cross-agent contract/,
    );
  });

  it('ProxyType enum: 3 values (socks5/openvpn/wireguard) — matches planning 133 §"Phased implementation roadmap"', () => {
    expect(ProxyTypeSchema.options).toEqual(['socks5', 'openvpn', 'wireguard']);
  });

  it('SocksProxyConfig fields: host string / port int 1-65535 / username + password optional / udp_associate boolean default true (planning 133 §"Cross-agent split" requires UDP ASSOCIATE for WebRTC)', () => {
    const parsed = SocksProxyConfigSchema.parse({ host: 'proxy.example.com', port: 1080 });
    expect(parsed.host).toBe('proxy.example.com');
    expect(parsed.port).toBe(1080);
    expect(parsed.udp_associate).toBe(true);
    // Port range enforced.
    expect(SocksProxyConfigSchema.safeParse({ host: 'x', port: 0 }).success).toBe(false);
    expect(SocksProxyConfigSchema.safeParse({ host: 'x', port: 65536 }).success).toBe(false);
    expect(SocksProxyConfigSchema.safeParse({ host: 'x', port: 1 }).success).toBe(true);
    expect(SocksProxyConfigSchema.safeParse({ host: 'x', port: 65535 }).success).toBe(true);
    // Username/password optional.
    expect(
      SocksProxyConfigSchema.safeParse({ host: 'x', port: 8080, username: 'u', password: 'p' })
        .success,
    ).toBe(true);
  });

  it('OpenVpnProxyConfig fields: config_blob string min 1 max 256KB (per planning 133 abuse cap) / username + password optional auth-user-pass', () => {
    expect(
      OpenVpnProxyConfigSchema.safeParse({ config_blob: 'client\nremote x.y.z 1194' }).success,
    ).toBe(true);
    expect(OpenVpnProxyConfigSchema.safeParse({ config_blob: '' }).success).toBe(false);
    expect(
      OpenVpnProxyConfigSchema.safeParse({ config_blob: 'a'.repeat(256 * 1024 + 1) }).success,
    ).toBe(false);
    expect(
      OpenVpnProxyConfigSchema.safeParse({ config_blob: 'a'.repeat(256 * 1024) }).success,
    ).toBe(true);
  });

  it('WireGuardProxyConfig fields: private_key + peer_public_key 44-char base64 curve25519 / endpoint host:port / allowed_ips default 0.0.0.0/0 / dns optional', () => {
    const validKey = 'A'.repeat(43) + '=';
    const parsed = WireGuardProxyConfigSchema.parse({
      private_key: validKey,
      peer_public_key: validKey,
      endpoint: 'wg.example.com:51820',
    });
    expect(parsed.allowed_ips).toBe('0.0.0.0/0');
    expect(parsed.dns).toBeUndefined();
    // Key length validation.
    expect(
      WireGuardProxyConfigSchema.safeParse({
        private_key: 'short',
        peer_public_key: validKey,
        endpoint: 'wg.example.com:51820',
      }).success,
    ).toBe(false);
    // Endpoint format validation.
    expect(
      WireGuardProxyConfigSchema.safeParse({
        private_key: validKey,
        peer_public_key: validKey,
        endpoint: 'no-port',
      }).success,
    ).toBe(false);
  });

  it('ProxyConfig discriminated union by type: passing sibling fields for non-matching type rejects (zod discriminatedUnion enforcement)', () => {
    // Valid SOCKS5.
    expect(
      ProxyConfigSchema.safeParse({ type: 'socks5', socks5: { host: 'x', port: 1080 } }).success,
    ).toBe(true);
    // Mismatched discriminator field rejects.
    expect(
      ProxyConfigSchema.safeParse({
        type: 'socks5',
        openvpn: { config_blob: 'client' },
      }).success,
    ).toBe(false);
  });

  it('EgressSafeguard fields: 3 booleans (block_direct_internet / block_unproxied_dns / block_webrtc_stun_leakage) ALL default true (CLAUDE.md "Egress safeguards enforce: sessions cannot egress without proxy" non-negotiable)', () => {
    const parsed = EgressSafeguardSchema.parse({});
    expect(parsed.block_direct_internet).toBe(true);
    expect(parsed.block_unproxied_dns).toBe(true);
    expect(parsed.block_webrtc_stun_leakage).toBe(true);
  });

  it('SessionEgressConfig: session_id non-empty + proxy ProxyConfig + egress_safeguard with safeguards-on defaults (planning 133 §"Per-session config schema" binding contract)', () => {
    const parsed = SessionEgressConfigSchema.parse({
      session_id: 'ses_xxx',
      proxy: { type: 'socks5', socks5: { host: 'x', port: 1080 } },
    });
    expect(parsed.session_id).toBe('ses_xxx');
    expect(parsed.proxy.type).toBe('socks5');
    expect(parsed.egress_safeguard.block_direct_internet).toBe(true);
    expect(parsed.egress_safeguard.block_unproxied_dns).toBe(true);
    expect(parsed.egress_safeguard.block_webrtc_stun_leakage).toBe(true);
    // session_id required + non-empty.
    expect(
      SessionEgressConfigSchema.safeParse({ session_id: '', proxy: parsed.proxy }).success,
    ).toBe(false);
  });

  it('SavedProxyConfig: label 1-120 chars + proxy ProxyConfig (planning 133 §"Cross-agent split" Agent 2 scope POST /v1/proxies reusable config endpoint)', () => {
    expect(
      SavedProxyConfigSchema.parse({
        label: 'team SOCKS5 — london',
        proxy: { type: 'socks5', socks5: { host: 'x', port: 1080 } },
      }).label,
    ).toBe('team SOCKS5 — london');
    expect(
      SavedProxyConfigSchema.safeParse({
        label: '',
        proxy: { type: 'socks5', socks5: { host: 'x', port: 1080 } },
      }).success,
    ).toBe(false);
    expect(
      SavedProxyConfigSchema.safeParse({
        label: 'x'.repeat(121),
        proxy: { type: 'socks5', socks5: { host: 'x', port: 1080 } },
      }).success,
    ).toBe(false);
  });

  it("imports z from 'zod' only (no cross-package leakage)", () => {
    expect(body).toMatch(/^import \{ z \} from 'zod';$/m);
  });

  it('exported from packages/api-types index.ts barrel', () => {
    const indexBody = readFileSync(resolve(REPO_ROOT, 'packages/api-types/src/index.ts'), 'utf8');
    expect(indexBody).toMatch(/export \* from '\.\/egress\.js';/);
  });
});
