// EG-API-1.6 — concrete SocksProxyBackend implementing
// SessionEgressService. Phase 1 SOCKS5 is the v1.0 launch path
// per the founder verdict 2026-05-16; OpenVPN and WireGuard
// remain 503-stubbed at this backend until their Phase 2/3 host-
// side harness work lands.
//
// What this slice does:
//   - Validate the customer-supplied SOCKS5 config (host + port
//     present, port in range, optional auth credentials).
//   - Return an EgressHandle whose envOverrides the harness
//     reads when spawning the WebKit fork — DRIFTSTACK_SOCKS5_*
//     env vars per planning 133's per-WebContent SOCKS5 config
//     contract.
//   - releaseFromSession is a no-op for SOCKS5: env vars are
//     process-scoped to the WebKit child; cleanup happens when
//     the browser process exits.
//
// Out of scope for this slice (planned follow-ups):
//   - Tunnel-reachability TCP probe before returning the handle
//     (planning 133 §"Phase 1 §5 — fail-fast on session create").
//     Until that lands, customers whose SOCKS5 host is unreachable
//     get a delayed failure when the WebKit fork tries to connect.
//   - OpenVPN + WireGuard backends — return 503 at this layer
//     until the harness-side macOS-VM-namespace work lands
//     (planning 133 §"Phase 2" + §"Phase 3").

import type { EgressHandle, SessionEgressConfig, SessionEgressService } from '../session-egress.js';

export class SocksProxyBackend implements SessionEgressService {
  applyToSession({ config }: { config: SessionEgressConfig }): Promise<EgressHandle> {
    const { session_id, proxy } = config;
    if (proxy.type !== 'socks5') {
      // OpenVPN + WireGuard backends are not yet wired at this
      // backend. Surface a typed error that the route layer maps
      // to 503 FeatureUnavailable — the customer sees a clean
      // "Phase X protocol not yet shipped" message instead of a
      // generic 500.
      return Promise.reject(
        new Error(
          `SocksProxyBackend does not handle proxy.type='${proxy.type}'; ` +
            `OpenVPN + WireGuard are Phase 2/3 per planning 133 and ship ` +
            `with the harness-side macOS VM namespace work.`,
        ),
      );
    }

    const { host, port, username, password, udp_associate } = proxy.socks5;
    if (host.trim().length === 0) {
      return Promise.reject(new Error('socks5.host must be non-empty'));
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return Promise.reject(new Error(`socks5.port must be in [1, 65535]; got ${port}`));
    }
    if (username !== undefined && password === undefined) {
      return Promise.reject(new Error('socks5 requires both username + password, or neither'));
    }
    if (password !== undefined && username === undefined) {
      return Promise.reject(new Error('socks5 requires both username + password, or neither'));
    }

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
    };
    if (username !== undefined && password !== undefined) {
      envOverrides.DRIFTSTACK_SOCKS5_PROXY_USERNAME = username;
      envOverrides.DRIFTSTACK_SOCKS5_PROXY_PASSWORD = password;
    }

    return Promise.resolve({
      sessionId: session_id,
      type: 'socks5',
      cleanup: { envOverrides },
    });
  }

  releaseFromSession(_handle: EgressHandle): Promise<void> {
    // SOCKS5 env vars are scoped to the WebKit child process;
    // cleanup is process-exit. No-op at the backend layer.
    return Promise.resolve();
  }
}
