// EG-API-1.1 — per-session customer-configurable egress schema (Phase 1).
//
// Source of truth: docs/planning/133-egress-architecture-cross-agent.md
// in the driftstack repo. The planning file LOCKED this schema as binding
// cross-agent contract on 2026-05-16; Agent 1 (WebKit fork) + Agent 2 (this
// repo / API + dashboard) + harness (Mac fleet session manager) all
// read/write per this shape.
//
// ⛔ 2026-09-20 — an absolute path to a working copy of the PRIVATE repo used
// to be quoted above, naming a machine, a home directory and a worktree. This
// file is compiled into `@driftstack/api-types`, whose dist carries its
// comments verbatim, and that package is published to npm. Nothing in here is
// private by default: write it as if a customer will read it, because one can.
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
 * SOCKS5 proxy settings for a session.
 *
 * `udp_associate` defaults to `true` because WebRTC can only travel through
 * a SOCKS5 proxy that supports the UDP ASSOCIATE command. If your proxy does
 * not support it, ICE candidate gathering fails; the session is refused at
 * the proxy connectivity check with an error naming the cause, rather than
 * starting and failing later.
 */
export const SocksProxyConfigSchema = z.object({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1).max(256).optional(),
  password: z.string().min(1).max(256).optional(),
  udp_associate: z.boolean().default(true),
  /**
   * Resolve host names through the proxy instead of locally. Defaults to
   * `true`, which asks the proxy for SOCKS5 ATYP DOMAINNAME (0x03) so every
   * lookup is performed by the proxy's own resolver.
   *
   * This is the secure mode and it is the default on purpose. Resolving
   * locally sends a DNS lookup from the session's own address on every
   * navigation, which identifies the session even though all of its other
   * traffic rides your proxy. Omitting the field must not opt you into that,
   * so it defaults to on, and a saved proxy always uses it.
   *
   * Set it to `false` only for a loopback or local proxy, where there is no
   * real egress to leak.
   *
   * ⚠️ THIS SETTING IS APPLIED, BUT NOT YET VERIFIED OR REPORTED BACK. It
   * changes how the session's proxy chain is configured — asking for remote
   * resolution really does change what the session does. What it does not
   * yet do is confirm the result: `egress_capabilities.dns_remote_resolve`
   * always reads `true` for a SOCKS5 session today, regardless of this
   * setting and regardless of whether your proxy actually accepted and
   * resolved a name. If your proxy cannot resolve names on its side, no
   * warning is reported for it — read `dns_remote_resolve` as "remote
   * resolution was requested for this session", not as a confirmed outcome,
   * until it becomes a real per-proxy measurement.
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
/**
 * OpenVPN settings for a session.
 *
 * `config_blob` is the full text of your `.ovpn` file, up to 256 KB. It must
 * be a client configuration: it needs a `client` line and a `remote` line
 * naming the server, or the request is refused with a message saying which
 * one is missing. Comments and blank lines are fine. `username` and
 * `password` are for configurations that use `auth-user-pass`.
 */
export const OpenVpnProxyConfigSchema = z.object({
  config_blob: z
    .string()
    .min(1)
    .max(256 * 1024)
    .refine((blob) => OVPN_CLIENT_DIRECTIVE_RE.test(blob), {
      message: 'This OpenVPN file must be a client configuration: it needs a `client` line.',
    })
    .refine((blob) => OVPN_REMOTE_DIRECTIVE_RE.test(blob), {
      message: 'This OpenVPN file needs a `remote` line with the server address.',
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
//
// The host group is an alternation because wg-quick(8) writes an IPv6 endpoint
// BRACKETED (`Endpoint = [2001:db8::1]:51820`) — the only unambiguous way to put
// a port after an IPv6 literal. The first draft had no `[` in its class, so a
// real wg0.conf pasted into the GUI (whose parser accepts the brackets) showed
// a green check and then the save came back 400. The bracket alternative keeps
// the port in group 2, so the numeric bound below reads the same group either
// way. The server's SSRF classifier strips the brackets itself
// (`vpnEndpointHost` in apps/server webhook-target-guard.ts), so what it
// classifies is the address, not the punctuation.
const WG_ENDPOINT_RE = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.\-:_]+):([0-9]{1,5})$/;
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

/**
 * WireGuard settings for a session, given as the individual values of a
 * `wg0.conf` rather than as one blob, so each can be checked and reported on
 * its own.
 *
 * `private_key`, `peer_public_key` and the optional `preshared_key` are
 * base64 WireGuard keys (44 characters). `endpoint` is `host:port`, with an
 * IPv6 literal bracketed as wg-quick writes it (`[2001:db8::1]:51820`).
 * `address` is the `[Interface] Address` line and is required — without it a
 * session cannot bring the tunnel up. `allowed_ips` defaults to `0.0.0.0/0`,
 * and `dns` is optional. Keys and the preshared key are stored encrypted and
 * never returned.
 */
export const WireGuardProxyConfigSchema = z.object({
  private_key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, {
    message: 'private_key must be a valid WireGuard key (44 characters, base64)',
  }),
  peer_public_key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, {
    message: 'peer_public_key must be a valid WireGuard key (44 characters, base64)',
  }),
  // [Peer] PresharedKey — the optional post-quantum symmetric key wg(8) mixes
  // into the handshake. A provider that issues one REQUIRES it: a peer
  // configured with a PSK refuses a handshake that omits it, so a config that
  // dropped this line would save clean and never come up. Same 32-byte base64
  // shape as the keys above. It is a SECRET like `private_key`: the server
  // wraps it under the account key and never echoes it.
  preshared_key: z
    .string()
    .regex(/^[A-Za-z0-9+/]{43}=$/, {
      message: 'preshared_key must be a 44-char base64 key',
    })
    .optional(),
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
      message: 'allowed_ips must be a comma-separated list of IP ranges, such as 0.0.0.0/0',
    })
    .default('0.0.0.0/0'),
  // [Interface] Address (e.g. 10.7.0.2/32) — the harness userspace WireGuard
  // ifconfig needs it to bring up the tunnel (A3 W2109). REQUIRED: the dispatch
  // wire (`InlineWireGuardWireSchema` below) has always required it, so a row
  // saved without one passed this schema and then failed closed at EVERY
  // dispatch — the session simply ran without its proxy and nothing told the
  // customer why. Refusing it here moves that failure to the save, where the
  // message can name the missing line. `required_error` because zod's default
  // for an absent key is the bare word "Required", which the create route
  // returns verbatim as the 400 detail.
  address: z
    .string({
      required_error:
        'address is required — the [Interface] Address line of the wg0.conf (e.g. 10.7.0.2/32)',
    })
    .max(128)
    .regex(WG_CIDR_LIST_RE, {
      message: 'address must be a comma-separated list of IP ranges, such as 10.7.0.2/32',
    }),
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
 * {...}}` rejects). Each request carries exactly one of socks5 / openvpn /
 * wireguard.
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
  // Present only when the stored row carries one; the server unwraps it at
  // dispatch (it is stored encrypted, like private_key). The shape is checked
  // again here because a zod object STRIPS keys it does not declare — an
  // undeclared preshared_key would be silently dropped from the wire and the
  // peer would refuse the handshake with nothing in any log naming the cause.
  preshared_key: z
    .string()
    .regex(/^[A-Za-z0-9+/]{43}=$/, {
      message: 'preshared_key must be a 44-char base64 key',
    })
    .optional(),
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
 * Defence-in-depth checks on a session's egress. All three are on by
 * default, and a session cannot reach the internet outside the proxy you
 * configured: sessions do not egress without one.
 *
 * Relaxing a safeguard is not available today — the fields are part of the
 * shape so that an audited opt-out can be offered later without a breaking
 * change.
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
 * The egress configuration for one session: which proxy it uses and which
 * safeguards apply. Sent to POST /v1/sessions/{id}/proxy and returned on
 * GET /v1/sessions/{id}.
 *
 * `session_id` is repeated in the body even though it is already in the URL,
 * so the payload identifies its own session wherever it is stored, logged or
 * replayed.
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
 * A reusable proxy configuration stored on your account with
 * POST /v1/proxies, so you do not have to repeat it on every session.
 * `proxy` has the same shape it has on a session; `label` is the name you
 * give it.
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
 * ⛔ THIS TEXT IS A PUBLISHED SURFACE, not a comment. It becomes the OpenAPI
 * `description` for `egress_capabilities.warnings` (the spec is generated from
 * this schema), so it reaches the rendered API reference, the committed
 * `packages/sdk-python/openapi.json` and the Pydantic field description
 * generated from that.
 *
 * It is held in agreement with the mapping function's vocabulary by
 * `apps/server/tests/unit/a-public-egress-warning-cannot-ship-undocumented.test.ts`:
 * a new public code fails that guard until it appears here, in the doc comment
 * above and on the customer docs page. A vocabulary documented in one of the
 * three places is a vocabulary that has already drifted.
 */
const EGRESS_WARNINGS_DESCRIPTION =
  'Codes naming anything that did not work as asked for this session. ' +
  'Read them as opaque strings: a code you do not recognise is ignored rather than fatal, ' +
  'and a new code can appear without an SDK upgrade. ' +
  'Published vocabulary, with what you can do about each: ' +
  '`udp_unsupported_by_proxy` (the proxy refused UDP, so QUIC cannot travel through it — use a UDP-capable proxy if you need HTTP/3); ' +
  '`quic_unavailable` (QUIC was asked for but could not be used, and traffic fell back to HTTP/2 — retry on a new session if HTTP/3 matters); ' +
  '`dead_proxy` (the proxy stopped answering mid-session — check it is reachable before starting another); ' +
  '`streaming_blank` (the live view produced no picture; the session itself kept running — reopen the view); ' +
  '`streaming_failed` (the live view stopped — start a new session if you need to watch it); ' +
  '`safeguards_unverified` (we could not confirm every egress safeguard ran — treat the egress as unverified and start a new session if that matters); ' +
  '`safeguard_failed` (an egress safeguard did not pass — stop relying on the session and contact support with the session id); ' +
  '`safeguard_failed:direct_internet_block` (the check that nothing leaves outside your proxy did not pass — contact support with the session id); ' +
  '`safeguard_failed:browser_integrity` (the check that the session ran the expected browser build did not pass — contact support with the session id); ' +
  '`safeguard_failed:proxy_egress_verification` (the check that traffic actually left through your proxy did not pass — confirm your proxy and contact support with the session id); ' +
  '`safeguard_failed:live_view_capture` (the live view could not be captured; the session’s own browsing is unaffected).';

/**
 * What your proxy turned out to support, reported once a SOCKS5 proxy has
 * been wired up for the session and returned on GET /v1/sessions/{id}.
 *
 * The whole object is null until that report arrives, and for sessions that
 * do not use SOCKS5. Once it is present, every field in it is filled in.
 *
 * - `udp_associate` — whether your SOCKS5 proxy supports the UDP ASSOCIATE
 *   command (RFC 1928 §6). This decides whether QUIC can travel through it.
 * - `quic_route` — how QUIC traffic is handled for this session: `proxy`
 *   (tunnelled over SOCKS5 UDP), `direct` (the proxy refused UDP and QUIC
 *   goes around the tunnel — reachable only where a safeguard has been
 *   relaxed; the default safeguards block it), or `disabled` (QUIC is off
 *   for this session and traffic falls back to HTTP/2 over TCP).
 * - `dns_remote_resolve` — for a SOCKS5 session, always `true` today. It
 *   states that the session's proxy chain was CONFIGURED to hand host names
 *   to the proxy rather than resolve them locally — which is what
 *   `proxy.require_remote_dns` asks for — and it is NOT YET a measurement of
 *   whether your particular proxy accepted and resolved them: there is
 *   currently no check of that, and no warning reported when a proxy cannot.
 *   Read it as "remote resolution was requested for this session", not as a
 *   confirmed outcome, until it becomes a real per-proxy measurement.
 * - `warnings` — codes naming anything that did not work as asked for this
 *   session. The full published vocabulary, each with what you can do about
 *   it:
 *     - `udp_unsupported_by_proxy` — the proxy answered UDP ASSOCIATE with
 *       a non-success reply, so QUIC cannot travel through it. Use a proxy
 *       that supports UDP if you need HTTP/3.
 *     - `quic_unavailable` — QUIC was asked for but could not be used for
 *       this session, and traffic fell back to HTTP/2 over TCP. Retry on a
 *       new session if HTTP/3 matters to you.
 *     - `dead_proxy` — the proxy stopped answering while the session was
 *       running. Check that it is reachable before starting another session.
 *     - `streaming_blank` — the live view of the session produced no
 *       picture. The session itself kept running; reopen the view, or read
 *       the session's results without it.
 *     - `streaming_failed` — the live view of the session stopped. Start a
 *       new session if you need to watch it.
 *     - `safeguards_unverified` — we could not confirm that every egress
 *       safeguard ran for this session. Treat the session's egress as
 *       unverified and start a new session if that matters to you.
 *     - `safeguard_failed` — an egress safeguard did not pass. Stop relying
 *       on the session's egress and contact support with the session id.
 *     - `safeguard_failed:direct_internet_block` — the check that nothing
 *       leaves the session outside your proxy did not pass. Stop relying on
 *       the session's egress and contact support with the session id.
 *     - `safeguard_failed:browser_integrity` — the check that the session
 *       ran the expected browser build did not pass. Contact support with
 *       the session id.
 *     - `safeguard_failed:proxy_egress_verification` — the check that the
 *       session's traffic actually left through your proxy did not pass.
 *       Confirm your proxy is working and contact support with the session
 *       id.
 *     - `safeguard_failed:live_view_capture` — the live view of the session
 *       could not be captured. The session's own browsing is unaffected.
 *
 * Read `warnings` as opaque strings: a code you do not recognise is passed
 * through verbatim rather than rejected, so a new one can appear without an
 * SDK upgrade. The array's type does not change when a code is added.
 *
 * The list above is the whole published vocabulary: a code outside it is not
 * sent at all rather than passed along, so you will not receive a string this
 * page does not describe unless the list itself grows. Match on the exact
 * string, or on the `safeguard_failed:` prefix if you want every safeguard
 * failure in one branch.
 */
export const EgressCapabilitiesSchema = z.object({
  udp_associate: z.boolean(),
  quic_route: z.enum(['proxy', 'direct', 'disabled']),
  dns_remote_resolve: z.boolean(),
  warnings: z.array(z.string()).default([]).describe(EGRESS_WARNINGS_DESCRIPTION),
});
export type EgressCapabilities = z.infer<typeof EgressCapabilitiesSchema>;
