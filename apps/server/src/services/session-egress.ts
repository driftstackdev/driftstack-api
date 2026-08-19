// V-540.E — Customer-configurable egress (SOCKS5 / WireGuard /
// OpenVPN). E1 slice = interface + types scaffold; concrete
// backends land in follow-up slices (EG-API-1.6 SOCKS5 propagation,
// later phases for OpenVPN + WireGuard per planning 133).
//
// Design source of truth: `docs/planning/133-egress-architecture-
// cross-agent.md` in the driftstack repo (founder-locked 2026-05-16).
// The earlier `docs/internal/customer-configurable-egress-design.md`
// was SUPERSEDED by planning 133 (~56h Agent-2-only estimate was
// undersized; real cross-agent + harness scope is 7-12 weeks per
// planning 133).
//
// Activation pattern follows the same all-or-nothing posture as
// Postmark / LiveKit / OAuth-client — bootstrap wires
// `sessionEgressService` into AppDeps only when a concrete backend
// is reachable; until then the routes registered by
// `registerSessionProxyDisabledRoutes` (EG-API-1.2) return 503
// FeatureUnavailable.
//
// Schema-side: the proxy-config DISCRIMINATED UNION + per-protocol
// shapes live in `@driftstack/api-types/egress` (EG-API-1.1, commit
// 555d8001). This file no longer redeclares them — it re-exports
// `SessionEgressConfig` + `ProxyConfig` for legacy callers and types
// `EgressHandle` against `ProxyType` from api-types so the cross-
// agent contract has one source of truth.

import type { ProxyType, SessionEgressConfig } from '@driftstack/api-types';

// Re-export so the consumers that imported these from this file
// before EG-API-1.1 keep working without touching their imports.
export type { ProxyType, SessionEgressConfig } from '@driftstack/api-types';

/**
 * Returned by `applyToSession`; opaque to callers. Carries the
 * per-session resources the backend created (env-var dict for
 * SOCKS5, network-namespace name for WireGuard / OpenVPN) so
 * `releaseFromSession` can tear them down in one call.
 *
 * `type` mirrors the discriminator from the canonical
 * `ProxyConfig` schema in `@driftstack/api-types/egress`.
 */
export interface EgressHandle {
  sessionId: string;
  type: ProxyType;
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
 * Service interface; impl lands in EG-API-1.6 propagation slice
 * (concrete SocksProxyBackend implements SessionEgressService +
 * bootstrap wiring + storage layer). Bootstrap wires the
 * orchestrating concrete class once Phase 1 SOCKS5 is reachable.
 *
 * Args shape matches the cross-agent contract from planning 133's
 * §"Per-session config schema" — a SessionEgressConfig envelope with
 * session_id + proxy discriminator + egress_safeguard.
 */
export interface SessionEgressService {
  /**
   * Configure customer-supplied egress for the given session.
   *
   * INTENDED lifecycle: called by the session-create path AFTER
   * reservation + BEFORE the browser process spawns, throwing on
   * tunnel-unreachable / config-parse-error so session-create fails
   * fast rather than after the browser is already up.
   *
   * V-1054 — that lifecycle is a contract, not current behaviour, and
   * this comment used to state it as fact. Nothing calls this method:
   * bootstrap instantiates SocksProxyBackend, routes/session-proxy.ts
   * holds the service without calling it, and applyToSession has no
   * caller anywhere, so no customer request reaches any of it.
   *
   * Two further gaps to close when planning-133 wires the edge, both
   * measured rather than assumed. The implementation rejects with a
   * plain Error, not a Problem. And neither egress-tunnel-unreachable
   * nor egress-config-invalid is in PROBLEM_TYPES — so as written the
   * failure would surface as 500 internal, and no SDK would map it to
   * a typed error a customer could catch.
   */
  applyToSession(args: { config: SessionEgressConfig }): Promise<EgressHandle>;

  /**
   * Tear down the per-session egress resources. Called by
   * session-end (`/v1/sessions/:id/destroy`, idle timeout, or
   * fatal session error). Idempotent — releasing a handle that
   * was never applied or has already been released is a no-op.
   */
  releaseFromSession(handle: EgressHandle): Promise<void>;
}
