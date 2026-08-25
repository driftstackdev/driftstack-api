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
  EgressCapabilitiesSchema,
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
      /any breaking change here is a breaking change to the\s*\/\/ cross-agent contract/,
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
    // Valid minimal .ovpn — has both `client` + `remote` directives.
    expect(
      OpenVpnProxyConfigSchema.safeParse({ config_blob: 'client\nremote x.y.z 1194' }).success,
    ).toBe(true);
    expect(OpenVpnProxyConfigSchema.safeParse({ config_blob: '' }).success).toBe(false);
    expect(
      OpenVpnProxyConfigSchema.safeParse({ config_blob: 'a'.repeat(256 * 1024 + 1) }).success,
    ).toBe(false);
    // A 256KB blob that lacks the required directives still rejects on
    // shape (the refines run after the .max). Use a near-max-size
    // blob that carries the required directives.
    const padded = 'client\nremote x.y.z 1194\n' + '#'.padEnd(256 * 1024 - 100, '#');
    expect(OpenVpnProxyConfigSchema.safeParse({ config_blob: padded }).success).toBe(true);
  });

  it('OpenVpnProxyConfig directive validation (founder priority focus area): `client` + `remote <host> <port>` required, blob without either rejects with a clear-shape message', () => {
    // No `client` directive → reject.
    const noClient = OpenVpnProxyConfigSchema.safeParse({
      config_blob: 'remote vpn.example.com 1194\ndev tun\n',
    });
    expect(noClient.success).toBe(false);
    if (!noClient.success) {
      expect(noClient.error.issues.some((i) => /client/i.test(i.message))).toBe(true);
    }

    // No `remote` directive → reject.
    const noRemote = OpenVpnProxyConfigSchema.safeParse({
      config_blob: 'client\ndev tun\n',
    });
    expect(noRemote.success).toBe(false);
    if (!noRemote.success) {
      expect(noRemote.error.issues.some((i) => /remote/i.test(i.message))).toBe(true);
    }

    // Leading whitespace + comment lines tolerated (real .ovpn files
    // routinely have these). Both `client` + `remote` indented +
    // surrounded by # comments → still passes.
    const withComments =
      '# This is a generated config\n;another style of comment\n  client\nremote vpn.example.com 1194\n';
    expect(OpenVpnProxyConfigSchema.safeParse({ config_blob: withComments }).success).toBe(true);

    // The word `client` appearing in a comment line MUST NOT count —
    // only the directive form (start-of-line + word-boundary).
    const clientOnlyInComment =
      '# this references the client directive but is just a comment\nremote vpn.example.com 1194\n';
    expect(OpenVpnProxyConfigSchema.safeParse({ config_blob: clientOnlyInComment }).success).toBe(
      false,
    );

    // A `client-*`/`client_*` prefixed directive (real OpenVPN
    // directives like `client-nat`/`client-to-client`/
    // `client-config-dir`/`client-cert-not-required`) MUST NOT satisfy
    // the bare `client` requirement — a word-boundary-only regex
    // incorrectly matched these, letting a non-client .ovpn through
    // the API boundary (regression guard).
    const clientPrefixedDirectiveOnly =
      'client-nat snat 192.168.1.0/24 10.8.0.0/24 255.255.255.0\nremote vpn.example.com 1194\n';
    expect(
      OpenVpnProxyConfigSchema.safeParse({ config_blob: clientPrefixedDirectiveOnly }).success,
    ).toBe(false);

    // A bare `client` line with trailing whitespace or an inline
    // comment must still pass (real .ovpn files sometimes have
    // trailing whitespace/comments after a directive).
    expect(
      OpenVpnProxyConfigSchema.safeParse({
        config_blob: 'client \nremote vpn.example.com 1194\n',
      }).success,
    ).toBe(true);
    expect(
      OpenVpnProxyConfigSchema.safeParse({
        config_blob: 'client # we are the client\nremote vpn.example.com 1194\n',
      }).success,
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

  it('WireGuardProxyConfig.endpoint port bound: regression guard — a 1-5 digit port regex alone accepts out-of-range ports (0, 65536, 99999); the schema must numerically bound the port to 1-65535 like every other port field in this file', () => {
    const validKey = 'A'.repeat(43) + '=';
    const base = { private_key: validKey, peer_public_key: validKey };
    // Out-of-range ports that a bare `[0-9]{1,5}` regex would wrongly
    // accept — MUST reject.
    expect(
      WireGuardProxyConfigSchema.safeParse({ ...base, endpoint: 'vpn.example.com:0' }).success,
    ).toBe(false);
    expect(
      WireGuardProxyConfigSchema.safeParse({ ...base, endpoint: 'vpn.example.com:99999' }).success,
    ).toBe(false);
    expect(
      WireGuardProxyConfigSchema.safeParse({ ...base, endpoint: 'vpn.example.com:65536' }).success,
    ).toBe(false);
    // Boundary values of the valid range must still pass.
    expect(
      WireGuardProxyConfigSchema.safeParse({ ...base, endpoint: 'vpn.example.com:1' }).success,
    ).toBe(true);
    expect(
      WireGuardProxyConfigSchema.safeParse({ ...base, endpoint: 'vpn.example.com:65535' }).success,
    ).toBe(true);
    // Ordinary valid endpoint still passes end-to-end.
    const parsed = WireGuardProxyConfigSchema.parse({ ...base, endpoint: 'wg.example.com:51820' });
    expect(parsed.endpoint).toBe('wg.example.com:51820');
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

  it('EgressCapabilities: harness-reported per-session SOCKS5 capability shape (cross-agent contract 7d5992d9 + EG-WK-1.9 dns_remote_resolve extension, migration 0045) — udp_associate boolean + quic_route 3-enum (proxy|direct|disabled) + dns_remote_resolve boolean + warnings string-array default []', () => {
    const parsed = EgressCapabilitiesSchema.parse({
      udp_associate: true,
      quic_route: 'proxy',
      dns_remote_resolve: true,
    });
    expect(parsed.udp_associate).toBe(true);
    expect(parsed.quic_route).toBe('proxy');
    expect(parsed.dns_remote_resolve).toBe(true);
    expect(parsed.warnings).toEqual([]);
    // quic_route enum.
    expect(
      EgressCapabilitiesSchema.safeParse({
        udp_associate: false,
        quic_route: 'direct',
        dns_remote_resolve: false,
      }).success,
    ).toBe(true);
    expect(
      EgressCapabilitiesSchema.safeParse({
        udp_associate: false,
        quic_route: 'disabled',
        dns_remote_resolve: false,
      }).success,
    ).toBe(true);
    expect(
      EgressCapabilitiesSchema.safeParse({
        udp_associate: false,
        quic_route: 'bogus',
        dns_remote_resolve: false,
      }).success,
    ).toBe(false);
    // warnings as opaque string array — unknown codes pass through.
    const withWarnings = EgressCapabilitiesSchema.parse({
      udp_associate: false,
      quic_route: 'disabled',
      dns_remote_resolve: false,
      warnings: [
        'udp_unsupported_by_proxy',
        'quic_disabled_fallback_http2',
        'dns_remote_resolve_unsupported_by_proxy',
        'novel_code_xyz',
      ],
    });
    expect(withWarnings.warnings).toHaveLength(4);
    // udp_associate + quic_route + dns_remote_resolve all required.
    expect(
      EgressCapabilitiesSchema.safeParse({
        quic_route: 'proxy',
        dns_remote_resolve: true,
      }).success,
    ).toBe(false);
    expect(
      EgressCapabilitiesSchema.safeParse({ udp_associate: true, dns_remote_resolve: true }).success,
    ).toBe(false);
    expect(
      EgressCapabilitiesSchema.safeParse({ udp_associate: true, quic_route: 'proxy' }).success,
    ).toBe(false);
  });

  it('SocksProxyConfig: EG-WK-1.9 require_remote_dns boolean (default TRUE — security: omitting it must not leak DNS via the local resolver) — when true the harness routes DNS via SOCKS5 ATYP DOMAINNAME and reports actual mode in EgressCapabilities.dns_remote_resolve', () => {
    // Security hardening — the default is `true` so a customer who omits the
    // flag gets remote (proxy-side) DNS resolution, not a DNS leak from the
    // fleet node's real IP. Opting OUT requires an explicit `false`.
    const defaulted = SocksProxyConfigSchema.parse({ host: 'proxy.example.com', port: 1080 });
    expect(defaulted.require_remote_dns).toBe(true);
    const optedOut = SocksProxyConfigSchema.parse({
      host: 'proxy.example.com',
      port: 1080,
      require_remote_dns: false,
    });
    expect(optedOut.require_remote_dns).toBe(false);
  });

  it("imports z from 'zod' only (no cross-package leakage)", () => {
    expect(body).toMatch(/^import \{ z \} from 'zod';$/m);
  });

  it('exported from packages/api-types index.ts barrel', () => {
    const indexBody = readFileSync(resolve(REPO_ROOT, 'packages/api-types/src/index.ts'), 'utf8');
    expect(indexBody).toMatch(/export \* from '\.\/egress\.js';/);
  });
});
