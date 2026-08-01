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
  /**
   * EG-WK-1.9 (founder verdict 2026-05-17 ~20:15 UTC) — when `true`,
   * the harness uses SOCKS5 ATYP DOMAINNAME (0x03) so DNS lookups
   * resolve through the proxy's resolver instead of the local host's.
   *
   * Security hardening — DEFAULTS TO `true` (remote resolution). A SOCKS5
   * session whose DNS resolves on the fleet node's LOCAL resolver leaks a
   * lookup from the node's real IP on every navigation, deanonymizing the
   * session even though all TCP/UDP rides the customer's proxy (a classic
   * DNS leak that defeats the proxy's IP-hiding purpose). The customer must
   * not be able to opt into that by omitting the flag, so the secure mode
   * is the default; the saved-proxy path (account-proxies) already forces
   * it on. Set explicitly to `false` ONLY for a local/loopback proxy where
   * there is no real egress to leak (e.g. the fleet-demo gost at 127.0.0.1).
   *
   * If `true` but the proxy doesn't support DOMAINNAME, the harness emits
   * the warning code `dns_remote_resolve_unsupported_by_proxy` and falls
   * back per safeguard policy. The actual mode used is reported back in
   * `egress_capabilities.dns_remote_resolve`.
   */
  require_remote_dns: z.boolean().default(true),
});
export type SocksProxyConfig = z.infer<typeof SocksProxyConfigSchema>;

/**
 * OpenVPN proxy config (Phase 2 — founder priority focus area
 * 2026-05-16 per planning 133 + ORCHESTRATOR-STATE Tier-3 verdicts).
 *
 * `config_blob` is the full .ovpn file contents (uploaded by the
 * customer; the dashboard does NOT introspect it server-side beyond
 * a syntactic well-formedness check). The harness materializes the
 * blob into a tmpfs file inside the per-session Lightweight VM and
 * invokes OpenVPN client against it.
 *
 * Max blob size 256 KB — large enough for any realistic .ovpn
 * (typical 5-20 KB; inline certificates push to ~100 KB) and small
 * enough to prevent abuse.
 *
 * Required-directive heuristic: a real .ovpn always declares
 * `client` (we're the client, not a server) and `remote <host> <port>`.
 * Without either, the OpenVPN client inside the per-session VM rejects
 * the config — so we may as well 400 at the API boundary with a clear
 * message instead of letting it fail at session-create. This is
 * defence-in-depth: the harness owns the real .ovpn parse; this is a
 * shape-only sanity check so customers fix typos before they get a
 * mysterious VM-start failure.
 *
 * Comments + blank lines are allowed everywhere in .ovpn so the regex
 * tolerates surrounding whitespace + comment lines starting with `#`
 * or `;`.
 */
const OVPN_CLIENT_DIRECTIVE_RE = /^[ \t]*client[ \t]*(?:[#;].*)?$/m;
const OVPN_REMOTE_DIRECTIVE_RE = /^[ \t]*remote\s+\S+/m;
export const OpenVpnProxyConfigSchema = z.object({
  config_blob: z
    .string()
    .min(1)
    .max(256 * 1024)
    .refine((blob) => OVPN_CLIENT_DIRECTIVE_RE.test(blob), {
      message: 'OpenVPN config must contain a `client` directive (received a non-client .ovpn).',
    })
    .refine((blob) => OVPN_REMOTE_DIRECTIVE_RE.test(blob), {
      message: 'OpenVPN config must contain a `remote <host> <port>` directive.',
    }),
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
// Host part intentionally allows `:` (see planning 133 discussion) so this
// pattern only anchors the overall host:port *shape*; the trailing numeric
// group is separately bounded to the valid TCP/UDP port range (1-65535)
// below — `[0-9]{1,5}` alone also matches syntactically-invalid ports like
// `0` or `99999`.
const WG_ENDPOINT_RE = /^([A-Za-z0-9.\-:_]+):([0-9]{1,5})$/;
/**
 * WireGuard value shapes, enforced because these three fields are the only ones
 * in the config that carried no format check — `private_key`, `peer_public_key`
 * and `endpoint` are each regex-validated, and these were length-capped only.
 *
 * Every one of them is written as the right-hand side of a `wg0.conf` line
 * (`AllowedIPs = …`, `Address = …`, `DNS = …`). A value containing a NEWLINE
 * therefore adds a line to that file, and WireGuard's `PostUp` / `PreUp` /
 * `PostDown` / `PreDown` run shell commands. The config is assembled outside
 * this repository, so what happens to a newline downstream is not something
 * this package can see — which is the reason to make one impossible at ingress
 * rather than to assume the consumer is careful.
 *
 * `[ \t]` rather than `\s` is deliberate and was the bug in the first draft:
 * `\s` matches `\n`, so `^\s*…\s*$` accepts `'0.0.0.0/0\n'` and any newline
 * sitting between list entries. Verified against both forms before shipping.
 *
 * The address halves stay permissive (`[0-9A-Fa-f:.]+`) so unusual but valid
 * IPv6 spellings are not rejected; the SHAPE is what carries the safety, and
 * being stricter about address validity would risk refusing legitimate configs
 * without adding to it.
 */
const WG_CIDR_LIST_RE =
  /^[ \t]*[0-9A-Fa-f:.]+\/\d{1,3}(?:[ \t]*,[ \t]*[0-9A-Fa-f:.]+\/\d{1,3})*[ \t]*$/;
const WG_IP_LIST_RE = /^[ \t]*[0-9A-Fa-f:.]+(?:[ \t]*,[ \t]*[0-9A-Fa-f:.]+)*[ \t]*$/;

export const WireGuardProxyConfigSchema = z.object({
  private_key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, {
    message: 'private_key must be a 44-char base64 curve25519 key',
  }),
  peer_public_key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, {
    message: 'peer_public_key must be a 44-char base64 curve25519 key',
  }),
  endpoint: z
    .string()
    .regex(WG_ENDPOINT_RE, {
      message: 'endpoint must be host:port (port 1-65535)',
    })
    .refine(
      (val) => {
        const match = WG_ENDPOINT_RE.exec(val);
        if (!match) return false;
        const port = Number(match[2]);
        return port >= 1 && port <= 65535;
      },
      { message: 'endpoint must be host:port (port 1-65535)' },
    ),
  allowed_ips: z
    .string()
    .max(1024)
    .regex(WG_CIDR_LIST_RE, {
      message: 'allowed_ips must be a comma-separated list of CIDRs (no newlines)',
    })
    .default('0.0.0.0/0'),
  // [Interface] Address (e.g. 10.7.0.2/32) — the harness userspace WireGuard
  // ifconfig needs it to bring up the tunnel (A3 W2109). Optional in the schema
  // for back-compat; the GUI's wg0.conf parser requires it before create.
  address: z
    .string()
    .max(128)
    .regex(WG_CIDR_LIST_RE, {
      message: 'address must be a comma-separated list of CIDRs (no newlines)',
    })
    .optional(),
  dns: z
    .string()
    .max(256)
    .regex(WG_IP_LIST_RE, {
      message: 'dns must be a comma-separated list of IP addresses (no newlines)',
    })
    .optional(),
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
// Inline VPN dispatch wire (FLAT) — what serializeSessionAssign base64-JSONs
// into `inlineProxyConfig` for a VPN session. A3 (W2163/W2164) code-verified the
// harness `parseVPNProxyConfig` reads `obj["type"]` then the VPN fields as DIRECT
// SIBLINGS of `type` — NOT nested under obj["openvpn"]/obj["wireguard"] (a nested
// payload fails closed at provision). socks5 keeps its existing SocksProxyConfig
// wire (no `type`), so only the VPN types need this flat shape.
// ───────────────────────────────────────────────────────────────────────────
export const InlineOpenVpnWireSchema = z.object({
  type: z.literal('openvpn'),
  config_blob: z.string().min(1),
  username: z.string().optional(),
  password: z.string().optional(),
});
export const InlineWireGuardWireSchema = z.object({
  type: z.literal('wireguard'),
  private_key: z.string().min(1),
  peer_public_key: z.string().min(1),
  endpoint: z.string().min(1),
  allowed_ips: z.string().min(1),
  address: z.string().min(1),
  dns: z.string().optional(),
});
export const InlineVpnProxyWireSchema = z.discriminatedUnion('type', [
  InlineOpenVpnWireSchema,
  InlineWireGuardWireSchema,
]);
export type InlineVpnProxyWire = z.infer<typeof InlineVpnProxyWireSchema>;

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

// ───────────────────────────────────────────────────────────────────────────
// Egress capabilities (cross-agent contract commit 7d5992d9)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Capability report emitted by the harness control-websocket after a
 * SOCKS5 proxy is wired up. The control plane persists the report on
 * `sessions.egress_capabilities` (migration 0045) and surfaces it on
 * GET /v1/sessions/{id}.
 *
 * Shape locked by the cross-agent contract — fields are NOT optional in
 * the wire payload, only the column itself is nullable (pre-migration
 * rows + non-SOCKS5 sessions + async-report-not-yet-arrived).
 *
 * - `udp_associate` — does the customer's SOCKS5 proxy support the
 *   UDP ASSOCIATE command per RFC 1928 §6? Drives QUIC-over-proxy
 *   feasibility.
 * - `quic_route` — how QUIC traffic is being handled for this session:
 *   `proxy` (UDP-tunneled through SOCKS5), `direct` (proxy refuses UDP,
 *   QUIC bypasses safeguard — only reachable in opt-out configs;
 *   default safeguard blocks this), or `disabled` (QUIC support turned
 *   off, all traffic falls back to HTTP/2 over TCP).
 * - `dns_remote_resolve` — added by founder verdict EG-WK-1.9 2026-05-17
 *   ~20:15 UTC ("proxy-only DNS"). Whether DNS lookups are being
 *   resolved THROUGH the SOCKS5 proxy server (`true`) or via the local
 *   host's resolver (`false`). When the session's
 *   `proxy.require_remote_dns` flag is set, the harness verifies the
 *   proxy supports SOCKS5 ATYP DOMAINNAME (0x03) and reports here;
 *   if the proxy can't, the harness emits warning
 *   `dns_remote_resolve_unsupported_by_proxy` and falls back to local
 *   resolution (or refuses to wire egress, depending on safeguard
 *   policy).
 * - `warnings` — string codes from a closed enum the harness may report
 *   alongside the capability result. Known codes:
 *     - `udp_unsupported_by_proxy` (SOCKS5 server returned a non-success
 *       reply to UDP ASSOCIATE)
 *     - `quic_disabled_fallback_http2` (QUIC was disabled at session
 *       create time; emitted for parity with `udp_unsupported_by_proxy`
 *       so dashboards can render a uniform "why no QUIC?" hint)
 *     - `dns_remote_resolve_unsupported_by_proxy` (proxy returned a
 *       non-success reply for an ATYP DOMAINNAME request, falling
 *       back to local resolution per EG-WK-1.9)
 *
 * Unknown warning codes are passed through verbatim — the SDK does not
 * narrow to a Zod enum so the harness can ship new codes without an
 * SDK release. Dashboard treats unknown codes as opaque strings.
 */
export const EgressCapabilitiesSchema = z.object({
  udp_associate: z.boolean(),
  quic_route: z.enum(['proxy', 'direct', 'disabled']),
  dns_remote_resolve: z.boolean(),
  warnings: z.array(z.string()).default([]),
});
export type EgressCapabilities = z.infer<typeof EgressCapabilitiesSchema>;
