// EgressResource — typed methods for /v1/sessions/{id}/proxy +
// /v1/proxies (planning 133 / Wave 1119 EGRESS Phase 1 onwards).
//
// Two surfaces:
//   1. Per-session proxy attach — set the SOCKS5/OpenVPN/WireGuard
//      config that THIS session's browser routes through.
//   2. Saved proxy library — store reusable proxy configs by label
//      so the dashboard + SDK can attach them by id without
//      re-entering credentials each time.
//
// SECURITY: list/get responses return ONLY `{ id, label, type }`
// (or `{ type, safeguards }` for the per-session read) — the raw
// proxy secrets (SOCKS5 password / OpenVPN .ovpn / WireGuard
// private_key) are NEVER readable after save (planning 133 §
// "Cross-agent split" SECURITY note). Customers re-enter to update.
//
// Activation gate: the server registers these endpoints as 503
// FeatureUnavailable stubs until a concrete SOCKS5 backend lands
// (EG-API-1.6 propagation slice). The SDK surface is stable now so
// consumers can compile against it without waiting for the runtime
// backend.

import type { ProxyType, SavedProxyConfig, SessionEgressConfig } from '@driftstack/api-types';
import type { HttpClient } from '../http.js';

export interface SessionProxyAttachResponse {
  type: ProxyType;
  safeguards: {
    block_direct_internet: boolean;
    block_unproxied_dns: boolean;
    block_webrtc_stun_leakage: boolean;
  };
}

export interface SavedProxySummary {
  id: string;
  label: string;
  type: ProxyType;
}

export interface ListSavedProxiesResponse {
  data: ReadonlyArray<SavedProxySummary>;
}

export class EgressResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Attach a customer-configured proxy to an existing session.
   * Returns the public-safe envelope (type + safeguard flags only —
   * no echo of the raw config you sent).
   *
   * NB: the request body's `session_id` MUST match `sessionId` here;
   * the server rejects mismatched pairs with 400 BadRequest.
   */
  attachToSession(
    sessionId: string,
    config: SessionEgressConfig,
  ): Promise<SessionProxyAttachResponse> {
    return this.http.request<SessionProxyAttachResponse>({
      method: 'POST',
      path: `/v1/sessions/${encodeURIComponent(sessionId)}/proxy`,
      body: config,
    });
  }

  /**
   * Read the session's current proxy summary. Returns 404 if no
   * proxy has been attached yet — callers should treat that as
   * "the session is currently running unproxied" (the API-layer
   * safeguard refuses session-create without proxy when the backend
   * is wired, but pre-wire deployments don't enforce that).
   */
  getSessionProxy(sessionId: string): Promise<SessionProxyAttachResponse> {
    return this.http.request<SessionProxyAttachResponse>({
      method: 'GET',
      path: `/v1/sessions/${encodeURIComponent(sessionId)}/proxy`,
    });
  }

  /**
   * Save a reusable proxy config. Returns the saved summary —
   * `id` is the surrogate the dashboard + the future
   * `attachSavedToSession` slice will use to reference this config.
   */
  saveProxy(body: SavedProxyConfig): Promise<SavedProxySummary> {
    return this.http.request<SavedProxySummary>({
      method: 'POST',
      path: '/v1/proxies',
      body,
    });
  }

  /** List the calling account's saved proxy summaries. */
  listSavedProxies(): Promise<ListSavedProxiesResponse> {
    return this.http.request<ListSavedProxiesResponse>({
      method: 'GET',
      path: '/v1/proxies',
    });
  }

  /** Delete a saved proxy by id. Returns 204; throws on 404 / 503. */
  deleteSavedProxy(id: string): Promise<void> {
    return this.http.request<void>({
      method: 'DELETE',
      path: `/v1/proxies/${encodeURIComponent(id)}`,
    });
  }
}
