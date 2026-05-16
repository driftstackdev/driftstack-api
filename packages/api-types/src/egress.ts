// EG-API-1.1 — per-session customer-configurable egress schema (Phase 1).
//
// Source of truth: docs/planning/133-egress-architecture-cross-agent.md
// in the driftstack repo (`/Users/john/code/driftstack/.claude/worktrees/
// busy-satoshi-5fc161/docs/planning/133-egress-architecture-cross-agent.md`
// pending merge). The planning file LOCKED this schema as binding cross-
// agent contract on 2026-05-16; Agent 1 (WebKit fork) + Agent 2 (this
// repo / API + dashboard) + harness (Mac fleet session manager) all
// read/write per this shape.
//
// Why this lives in @driftstack/api-types (not apps/server/src/schemas):
//   - Customer dashboard reads + writes this shape.
//   - SDK consumers (TS / Python / Go) deserialize it when fetching
//     POST /v1/sessions/{id}/proxy.
//   - Cross-agent contract requires a single Zod source — server-internal
//     shapes would diverge from harness/WebKit consumption.
//
// Versioning: any breaking change here is a breaking change to the
// cross-agent contract — coordinate with Agent 1 + harness AND update
// planning file 133 in the SAME PR (per CLAUDE.md "specifications drive
// code"; planning 133 is the spec for this schema).
//
// SUPERSEDES the earlier `apps/server/src/services/session-egress.ts`
// SessionProxyConfig discriminated union (commit f7bab517, design doc
// docs/internal/customer-configurable-egress-design.md). The earlier
// shape used a single `url: socks5://host:port` field; planning 133
// requires the host / port / username / password / udp_associate fields
// to be addressable independently (so the dashboard editor can validate
// each + the harness can perform a per-field proxy-connectivity check
// per planning 133 Tier-3 verdict #5 fail-fast).

import { z } from 'zod';

// ───────────────────────────────────────────────────────────────────────────
// Proxy-type discriminator
// ───────────────────────────────────────────────────────────────────────────

export const ProxyTypeSchema = z.enum(['socks5', 'openvpn', 'wireguard']);
export type ProxyType = z.infer<typeof ProxyTypeSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Per-protocol config shapes
// ───────────────────────────────────────────────────────────────────────────

/**
 * SOCKS5 proxy config (Phase 1).
 *
 * `udp_associate: true` is the planning-133 default — UDP ASSOCIATE
 * support is required for WebRTC to route through the proxy (per
 * planning 133 §"Cross-agent split" Agent 1 scope: "for SOCKS5: standard
 * SOCKS5 supports UDP via UDP ASSOCIATE; WebRTC traffic uses ASSOCIATE
 * path"). Customers whose proxy lacks UDP ASSOCIATE will see ICE-
 * candidate gathering fail; the harness rejects the session-create with
 * a clear error at the proxy connectivity check step.
 */
export const SocksProxyConfigSchema = z.object({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1).max(256).optional(),
  password: z.string().min(1).max(256).optional(),
  udp_associate: z.boolean().default(true),
});
export type SocksProxyConfig = z.infer<typeof SocksProxyConfigSchema>;

/**
 * OpenVPN proxy config (Phase 2).
 *
 * `config_blob` is the full .ovpn file contents (uploaded by the
 * customer; the dashboard does NOT introspect it server-side beyond
 * a syntactic well-formedness check). The harness materializes the
 * blob into a tmpfs file inside the per-session Lightweight VM and
 * invokes OpenVPN client against it (per planning 133 Phase 2
 * "Apple Virtualization.framework Lightweight VMs per session").
 *
 * Max blob size 256 KB — large enough for any realistic .ovpn
 * (typical 5-20 KB; inline certificates push to ~100 KB) and small
 * enough to prevent abuse.
 */
export const OpenVpnProxyConfigSchema = z.object({
  config_blob: z
    .string()
    .min(1)
    .max(256 * 1024),
  username: z.string().min(1).max(256).optional(),
  password: z.string().min(1).max(256).optional(),
});
export type OpenVpnProxyConfig = z.infer<typeof OpenVpnProxyConfigSchema>;

/**
 * WireGuard proxy config (Phase 3).
 *
 * Per planning 133 §"Per-session config schema" — the keys + endpoint +
 * allowed_ips + dns are addressable as separate fields rather than as a
 * single wg-quick(8) blob, because the dashboard's WireGuard editor
 * validates each field independently and the harness re-assembles them
 * into a wg-quick(8) config inside the per-session VM.
 *
 * `private_key` + `peer_public_key` are base64-encoded WireGuard 32-byte
 * curve25519 keys (44 chars after b64 with padding).
 */
export const WireGuardProxyConfigSchema = z.object({
  private_key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, {
    message: 'private_key must be a 44-char base64 curve25519 key',
  }),
  peer_public_key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, {
    message: 'peer_public_key must be a 44-char base64 curve25519 key',
  }),
  endpoint: z.string().regex(/^[A-Za-z0-9.\-:_]+:[0-9]{1,5}$/, {
    message: 'endpoint must be host:port (port 1-65535)',
  }),
  allowed_ips: z.string().default('0.0.0.0/0'),
  dns: z.string().optional(),
});
export type WireGuardProxyConfig = z.infer<typeof WireGuardProxyConfigSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Discriminated proxy envelope
// ───────────────────────────────────────────────────────────────────────────

/**
 * Discriminated union: `type` selects which sibling field carries the
 * real config. The non-matching siblings MUST be omitted (Zod
 * discriminatedUnion enforces this — passing `{type:'socks5', openvpn:
 * {...}}` rejects). This mirrors planning 133's JSON example where
 * each request carries exactly one of socks5 / openvpn / wireguard.
 */
export const ProxyConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('socks5'), socks5: SocksProxyConfigSchema }),
  z.object({ type: z.literal('openvpn'), openvpn: OpenVpnProxyConfigSchema }),
  z.object({ type: z.literal('wireguard'), wireguard: WireGuardProxyConfigSchema }),
]);
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Egress safeguard
// ───────────────────────────────────────────────────────────────────────────

/**
 * Per planning 133 §"Egress safeguard enforcement" — defense-in-depth
 * configuration. The defaults match planning 133's locked example: all
 * three checks ON. Customers can NOT relax any of these for v1 launch
 * (CLAUDE.md "Egress safeguards enforce: sessions cannot egress without
 * proxy" is non-negotiable); the fields exist in the schema so future
 * enterprise customers with audited proxy infrastructure can selectively
 * opt out (Tier-3 founder verdict required before any opt-out is
 * implemented).
 */
export const EgressSafeguardSchema = z.object({
  block_direct_internet: z.boolean().default(true),
  block_unproxied_dns: z.boolean().default(true),
  block_webrtc_stun_leakage: z.boolean().default(true),
});
export type EgressSafeguard = z.infer<typeof EgressSafeguardSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Per-session config (binding cross-agent contract)
// ───────────────────────────────────────────────────────────────────────────

/**
 * The canonical per-session egress config — what flows from the API
 * through the harness to the WebKit fork. Planning 133 §"Per-session
 * config schema" specifies this exact shape; Agent 1 + Agent 2 +
 * harness all consume `SessionEgressConfig` (the inferred type) from
 * this single Zod source.
 *
 * `session_id` is repeated here (it's also in the URL on POST
 * /v1/sessions/{id}/proxy) so the payload is self-contained for the
 * harness — the harness gets the payload via stdin / IPC, not via the
 * HTTP URL, so the body must carry the id.
 */
export const SessionEgressConfigSchema = z.object({
  session_id: z.string().min(1),
  proxy: ProxyConfigSchema,
  egress_safeguard: EgressSafeguardSchema.default({
    block_direct_internet: true,
    block_unproxied_dns: true,
    block_webrtc_stun_leakage: true,
  }),
});
export type SessionEgressConfig = z.infer<typeof SessionEgressConfigSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Reusable proxy config (POST /v1/proxies)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Customers can save reusable proxy configs (per planning 133
 * §"Cross-agent split" Agent 2 scope: "POST /v1/proxies — store
 * reusable customer proxy config"). The save-payload shape mirrors
 * `proxy: ProxyConfigSchema` plus a customer-visible label.
 */
export const SavedProxyConfigSchema = z.object({
  label: z.string().min(1).max(120),
  proxy: ProxyConfigSchema,
});
export type SavedProxyConfig = z.infer<typeof SavedProxyConfigSchema>;
