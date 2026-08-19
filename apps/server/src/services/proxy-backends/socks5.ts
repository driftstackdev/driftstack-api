// EG-API-1.6 — concrete SocksProxyBackend implementing
// SessionEgressService. Phase 1 SOCKS5 is the v1.0 launch path
// per the founder verdict 2026-05-16; OpenVPN and WireGuard
// remain 503-stubbed at this backend until their Phase 2/3 host-
// side harness work lands.
//
// What this slice does:
//   - Validate the customer-supplied SOCKS5 config (host + port
//     present, port in range, optional auth credentials).
//   - TCP-probe the host:port with a short timeout before
//     returning the EgressHandle (planning 133 §"Phase 1 §5 —
//     fail-fast on session create"), so an unreachable SOCKS5
//     host fails at configure time rather than once the WebKit
//     fork tries to connect.
//
//     V-1054 — no customer sees that yet, and this bullet used to
//     say they did. applyToSession has no caller; the probe
//     rejects with a plain Error rather than a Problem; and
//     egress-tunnel-unreachable is not in PROBLEM_TYPES. Wiring
//     the session-create edge needs all three, or the fail-fast
//     arrives as a 500 internal that no SDK maps.
//   - Return an EgressHandle whose envOverrides the harness
//     reads when spawning the WebKit fork — DRIFTSTACK_SOCKS5_*
//     env vars per planning 133's per-WebContent SOCKS5 config
//     contract.
//   - releaseFromSession is a no-op for SOCKS5: env vars are
//     process-scoped to the WebKit child; cleanup happens when
//     the browser process exits.
//
// Out of scope for this slice (planned follow-ups):
//   - OpenVPN + WireGuard backends — return 503 at this layer
//     until the harness-side macOS-VM-namespace work lands
//     (planning 133 §"Phase 2" + §"Phase 3").
//   - SOCKS5 handshake probe (vs raw TCP connect) — actual SOCKS5
//     greeting verification. The TCP probe today catches
//     "wrong host / wrong port / firewall blocks" but doesn't
//     verify the server is actually SOCKS5.

import { connect, type Socket } from 'node:net';
import type { EgressHandle, SessionEgressConfig, SessionEgressService } from '../session-egress.js';
import { classifyUnsafeHost } from '../../lib/webhook-target-guard.js';

const DEFAULT_PROBE_TIMEOUT_MS = 3_000;

export interface SocksProxyBackendDeps {
  /**
   * Injectable TCP probe — tests pass a deterministic stub so we
   * don't actually open sockets during unit tests. Default uses
   * node:net's connect() with a short timeout.
   */
  tcpProbe?: (host: string, port: number, timeoutMs: number) => Promise<void>;
  /** Probe deadline in ms; default 3000. */
  probeTimeoutMs?: number;
}

export function defaultTcpProbe(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect({ host, port }, () => {
      clearTimeout(timer);
      // §4.17 SSRF — connection-time DNS-rebind layer. The literal-host guard
      // (classifyUnsafeHost in createForSession) only rejects literal internal
      // IPs / numeric encodings; a customer host that is a DOMAIN resolving to a
      // private / loopback / link-local / metadata IP slips past it. The connected
      // socket's peer address is the ACTUAL resolved IP — reject it here so a
      // domain→internal-IP host fails session-create cleanly, instead of the
      // probe (and the fork's later dial) reaching Driftstack's internal network.
      // (The fork re-resolves the hostname independently; pinning the validated IP
      // into the fork's dial is the remaining defense-in-depth layer — A1/go-live.)
      const peer = socket.remoteAddress;
      if (peer !== undefined && classifyUnsafeHost(peer) !== null) {
        socket.destroy();
        reject(
          new Error(
            `egress-proxy-host-not-allowed: socks5.host '${host}' resolved to internal address ${peer} — the egress proxy must be a public host (SSRF guard).`,
          ),
        );
        return;
      }
      socket.end();
      resolve();
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`egress-tunnel-unreachable: timed out connecting to ${host}:${port}`));
    }, timeoutMs);
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`egress-tunnel-unreachable: ${err.message}`));
    });
  });
}

export class SocksProxyBackend implements SessionEgressService {
  private readonly tcpProbe: (host: string, port: number, timeoutMs: number) => Promise<void>;
  private readonly probeTimeoutMs: number;

  constructor(deps: SocksProxyBackendDeps = {}) {
    this.tcpProbe = deps.tcpProbe ?? defaultTcpProbe;
    this.probeTimeoutMs = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  }

  async applyToSession({ config }: { config: SessionEgressConfig }): Promise<EgressHandle> {
    const { session_id, proxy } = config;
    if (proxy.type !== 'socks5') {
      // OpenVPN + WireGuard backends are not yet wired at this
      // backend. Surface a typed error that the route layer maps
      // to 503 FeatureUnavailable — the customer sees a clean
      // "Phase X protocol not yet shipped" message instead of a
      // generic 500.
      throw new Error(
        `SocksProxyBackend does not handle proxy.type='${proxy.type}'; ` +
          `OpenVPN + WireGuard are Phase 2/3 per planning 133 and ship ` +
          `with the harness-side macOS VM namespace work.`,
      );
    }

    const {
      host: rawHost,
      port,
      username,
      password,
      udp_associate,
      require_remote_dns,
    } = proxy.socks5;
    // Trim once and use the trimmed value everywhere downstream (probe +
    // env var). Validating `rawHost.trim()` but then propagating the
    // untrimmed host would let " proxy.example.com " pass validation, then
    // fail the TCP probe — and reach the WebKit fork's
    // DRIFTSTACK_SOCKS5_PROXY_HOST env var — with stray whitespace, a
    // confusing self-inflicted egress-tunnel-unreachable for a customer who
    // merely added a space.
    const host = rawHost.trim();
    if (host.length === 0) {
      throw new Error('socks5.host must be non-empty');
    }
    // §4.17 SSRF guard — the egress backend TCP-connects to (and the fork dials)
    // this customer-supplied host. A private/loopback/link-local/metadata address
    // (or a numeric-IP-encoding smuggling it) would reach Driftstack's internal
    // network — the proxy must be a public host. Reuses the vetted webhook
    // SSRF block list. (A legitimately-public proxy is unaffected; a private host
    // wouldn't be reachable from our infra anyway except as the SSRF target.)
    const unsafeHostKind = classifyUnsafeHost(host);
    if (unsafeHostKind !== null) {
      const what =
        unsafeHostKind === 'localhost'
          ? 'localhost'
          : unsafeHostKind === 'numeric-encoding'
            ? 'a non-standard numeric IP encoding'
            : 'a private, loopback, or reserved';
      throw new Error(
        `egress-proxy-host-not-allowed: socks5.host '${host}' is ${what} address — ` +
          `the egress proxy must be a public host (SSRF guard).`,
      );
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`socks5.port must be in [1, 65535]; got ${port}`);
    }
    if (username !== undefined && password === undefined) {
      throw new Error('socks5 requires both username + password, or neither');
    }
    if (password !== undefined && username === undefined) {
      throw new Error('socks5 requires both username + password, or neither');
    }

    // Q.0.b — TCP-probe the customer's SOCKS5 host:port before
    // returning the handle. Catches "wrong host / wrong port /
    // firewall blocks" at session-create time so the customer
    // sees a 4xx egress-tunnel-unreachable immediately rather
    // than a delayed failure once the WebKit fork tries to
    // connect (which surfaces 30+ seconds later with a less
    // helpful error).
    await this.tcpProbe(host, port, this.probeTimeoutMs);

    // env-var contract per planning 133 §"Phase 1 §1.2 — per-
    // WebContent SOCKS5 config". The harness spawns the WebKit
    // fork with these vars; the fork's WebContent process
    // initializes its NetworkSession against them.
    //
    // UDP-ASSOCIATE defaults true so QUIC + HTTP/3 work
    // end-to-end through the customer's proxy. If the customer's
    // SOCKS5 server doesn't support UDP-ASSOCIATE, they pass
    // `udp_associate: false` and lose QUIC/HTTP/3 (TCP-only
    // egress remains).
    const envOverrides: Record<string, string> = {
      DRIFTSTACK_SOCKS5_PROXY_HOST: host,
      DRIFTSTACK_SOCKS5_PROXY_PORT: String(port),
      DRIFTSTACK_SOCKS5_UDP_ASSOCIATE: udp_associate ? '1' : '0',
      // EG-WK-1.9 (founder verdict 2026-05-17 ~20:15 UTC) — when
      // `require_remote_dns` is true, the WebKit fork uses SOCKS5
      // ATYP DOMAINNAME (0x03) so DNS lookups resolve through the
      // proxy's resolver rather than the host's. Without propagating
      // the schema flag through here, the WebKit fork has no way of
      // knowing the customer asked for remote DNS — silent fallback
      // to local resolution would leak the host's resolver behind
      // the proxy.
      DRIFTSTACK_SOCKS5_REQUIRE_REMOTE_DNS: require_remote_dns ? '1' : '0',
    };
    if (username !== undefined && password !== undefined) {
      envOverrides.DRIFTSTACK_SOCKS5_PROXY_USERNAME = username;
      envOverrides.DRIFTSTACK_SOCKS5_PROXY_PASSWORD = password;
    }

    return {
      sessionId: session_id,
      type: 'socks5',
      cleanup: { envOverrides },
    };
  }

  releaseFromSession(_handle: EgressHandle): Promise<void> {
    // SOCKS5 env vars are scoped to the WebKit child process;
    // cleanup is process-exit. No-op at the backend layer.
    return Promise.resolve();
  }
}
