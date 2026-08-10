// EgressResource — typed methods for the customer egress surface:
//   1. Per-session proxy attach — set the proxy config THIS session's
//      browser routes through (/v1/sessions/{id}/proxy).
//   2. Saved proxy library — CRUD + a reachability test over the
//      account's reusable proxy configs (/v1/account/me/proxies). This
//      is the LIVE account-proxies API (shipped) — the same backend the
//      desktop app + dashboard use, replacing the older /v1/proxies stub.
//
// SECURITY: the secret-bearing fields (SOCKS5 `password`, OpenVPN
// `config_blob`, WireGuard `private_key`) are WRITE-ONLY — wrapped
// server-side under the account key, never echoed back. List/get
// responses return only metadata (+ `has_password` / `has_secret`
// flags). Re-send to update a secret.

import type {
  AccountProxyCreate,
  AccountProxyList,
  AccountProxyMetadata,
  AccountProxyTestResult,
  AccountProxyUpdate,
  ProxyType,
  SessionEgressConfig,
} from '@driftstack/api-types';
import type { HttpClient } from '../http.js';

export interface SessionProxyAttachResponse {
  type: ProxyType;
  safeguards: {
    block_direct_internet: boolean;
    block_unproxied_dns: boolean;
    block_webrtc_stun_leakage: boolean;
  };
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
   *
   * ⚠️ CAPABILITY-GATED, AND CURRENTLY UNAVAILABLE EVERYWHERE. `POST
   * /v1/sessions/:id/proxy` throws `FeatureUnavailableError` (503) on every
   * deployment today — `routes/session-proxy.ts` discards the injected service
   * and both registration branches throw, so there is no configuration in which
   * this succeeds. The 400-on-mismatch above is a real check, but you will not
   * reach it. `getSessionProxy` likewise 404s unconditionally. Treat these two as
   * declared-but-unshipped; the reusable proxy CRUD methods on this resource are
   * unaffected.
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
   * "the session is currently running unproxied".
   */
  getSessionProxy(sessionId: string): Promise<SessionProxyAttachResponse> {
    return this.http.request<SessionProxyAttachResponse>({
      method: 'GET',
      path: `/v1/sessions/${encodeURIComponent(sessionId)}/proxy`,
    });
  }

  /** List the calling account's saved proxies (metadata only). */
  listProxies(): Promise<AccountProxyList> {
    return this.http.request<AccountProxyList>({
      method: 'GET',
      path: '/v1/account/me/proxies',
    });
  }

  /**
   * Create a saved proxy. `password` / the VPN `config_blob` /
   * `private_key` are write-only — wrapped server-side, never echoed.
   * Returns the stored metadata (with `has_password` / `has_secret`).
   */
  createProxy(body: AccountProxyCreate): Promise<AccountProxyMetadata> {
    return this.http.request<AccountProxyMetadata>({
      method: 'POST',
      path: '/v1/account/me/proxies',
      body,
    });
  }

  /**
   * Update a saved proxy. Omitted fields stay unchanged; a secret field
   * set to `null` clears it, a string (re)wraps it.
   */
  updateProxy(id: string, body: AccountProxyUpdate): Promise<AccountProxyMetadata> {
    return this.http.request<AccountProxyMetadata>({
      method: 'PUT',
      path: `/v1/account/me/proxies/${encodeURIComponent(id)}`,
      body,
    });
  }

  /** Delete a saved proxy by id. Returns 204; throws on 404. */
  deleteProxy(id: string): Promise<void> {
    return this.http.request<void>({
      method: 'DELETE',
      path: `/v1/account/me/proxies/${encodeURIComponent(id)}`,
    });
  }

  /**
   * Server-side reachability probe of a saved proxy's host:port
   * (SSRF-guarded). 200 either way: `{ ok: true, latency_ms }` when
   * reachable, `{ ok: false, reason }` when not.
   */
  testProxy(id: string): Promise<AccountProxyTestResult> {
    return this.http.request<AccountProxyTestResult>({
      method: 'POST',
      path: `/v1/account/me/proxies/${encodeURIComponent(id)}/test`,
    });
  }
}
