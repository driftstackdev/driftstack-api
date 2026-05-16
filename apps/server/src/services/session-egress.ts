// V-540.E — Customer-configurable egress (SOCKS5 / WireGuard /
// OpenVPN). E1 slice = interface + types scaffold; concrete
// backends land in follow-up slices (E2 SOCKS5, E3 WireGuard,
// E4 OpenVPN).
//
// Design doc: docs/internal/customer-configurable-egress-design.md
//
// Activation pattern follows the same all-or-nothing posture as
// Postmark / LiveKit / OAuth-client — bootstrap wires
// `sessionEgressService` into AppDeps only when all backends are
// reachable; until then the `proxy` body field on POST /v1/sessions
// is silently stripped by the schema (the field isn't yet in the
// public sessions-schema discriminated union; lands in E6).
//
// Schema-side: tokens `socks5` / `wireguard` / `openvpn` and the
// interface name `SessionEgressService` are intentionally surfaced
// in source so the marketing-egress-claim parity sweep
// (apps/server/tests/unit/marketing-egress-claim-sweep.test.ts)
// can detect the impl-in-progress state and start to relax the
// "must say roadmap" assertion as backends land.

/**
 * Per-session proxy configuration the customer passes on
 * POST /v1/sessions. Discriminated union by `type`; each variant
 * carries the credentials shape required by its corresponding
 * backend.
 *
 * SECURITY: every variant carries customer secrets. Configs live
 * on tmpfs (V-353b AES-256-GCM at-rest envelope) for the lifetime
 * of the session and are zeroed at session-end. Driftstack staff
 * never see the cleartext — config_hash (sha256 of the config) is
 * what lands in session_egress_log for audit (E5).
 */
export type SessionProxyConfig =
  | {
      type: 'socks5';
      /** Proxy URL — `socks5://user:pass@host:port` or
       *  `socks5h://...` for remote DNS. */
      url: string;
      /** Optional auth (alternative to baking credentials into url). */
      username?: string;
      password?: string;
    }
  | {
      type: 'wireguard';
      /** Full wg-quick(8) config file contents. Includes
       *  [Interface] + [Peer] sections, customer's PrivateKey,
       *  PublicKey of remote peer, allowed IPs, endpoint. */
      wg_quick_config: string;
    }
  | {
      type: 'openvpn';
      /** Full .ovpn config file contents. */
      ovpn_config: string;
      /** Optional username + password for auth-user-pass setups. */
      auth_user?: string;
      auth_pass?: string;
    };

/**
 * Returned by `applyToSession`; opaque to callers. Carries the
 * per-session resources the backend created (env-var dict for
 * SOCKS5, network-namespace name for WireGuard / OpenVPN) so
 * `releaseFromSession` can tear them down in one call.
 */
export interface EgressHandle {
  sessionId: string;
  type: SessionProxyConfig['type'];
  /** Backend-specific cleanup payload. Consumers MUST treat this
   *  as opaque and hand it back to releaseFromSession verbatim. */
  cleanup: {
    /** tmpfs path to the config file (zeroed on release). */
    configPath?: string;
    /** Network namespace name for wireguard / openvpn variants. */
    netnsName?: string;
    /** Env-var overrides for socks5 variant (passed to browser spawn). */
    envOverrides?: Readonly<Record<string, string>>;
  };
}

/**
 * Service interface; implementations land in E2 (SOCKS5) +
 * E3 (WireGuard) + E4 (OpenVPN). Bootstrap wires the
 * orchestrating concrete class once all three are ready (E8).
 */
export interface SessionEgressService {
  /**
   * Configure customer-supplied egress for the given session.
   * Called by the session-create path AFTER reservation + BEFORE
   * the browser process spawns. Throws on tunnel-unreachable /
   * config-parse-error so the session-create call surfaces a
   * clean 4xx with problem-type
   * `https://errors.driftstack.dev/egress-tunnel-unreachable` or
   * `…/egress-config-invalid`.
   */
  applyToSession(args: { sessionId: string; proxy: SessionProxyConfig }): Promise<EgressHandle>;

  /**
   * Tear down the per-session egress resources. Called by
   * session-end (`/v1/sessions/:id/destroy`, idle timeout, or
   * fatal session error). Idempotent — releasing a handle that
   * was never applied or has already been released is a no-op.
   */
  releaseFromSession(handle: EgressHandle): Promise<void>;
}
