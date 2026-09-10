package driftstack

import (
	"context"
	"net/url"
)

// EgressResource handles the customer egress surface:
//  1. Per-session proxy attach (/v1/sessions/{id}/proxy).
//  2. Saved proxy library — CRUD + a reachability test over the
//     account's reusable proxy configs (/v1/account/me/proxies). This
//     is the LIVE account-proxies API (shipped) — the same backend the
//     desktop app + dashboard use, replacing the older /v1/proxies stub.
//
// Mirrors the TypeScript + Python SDK egress resources.
//
// SECURITY: the secret-bearing fields (SOCKS5 password, OpenVPN
// config_blob, WireGuard private_key and preshared_key) are write-only — wrapped
// server-side under the account key, never echoed back. List/get return
// metadata only (+ HasPassword / HasSecret).
type EgressResource struct {
	client *Client
}

// SessionEgressConfig is the body shape for AttachToSession.
// Use map[string]any for nested shapes — keeping the type loose
// matches the existing SDK pattern for non-billing surfaces.
type SessionEgressConfig struct {
	SessionID       string          `json:"session_id"`
	Proxy           map[string]any  `json:"proxy"`
	EgressSafeguard map[string]bool `json:"egress_safeguard"`
}

// SessionProxyAttachResponse is the public-safe envelope returned
// by AttachToSession + GetSessionProxy. Carries only the proxy type
// + safeguard flags — never raw secret material.
type SessionProxyAttachResponse struct {
	Type       string          `json:"type"`
	Safeguards map[string]bool `json:"safeguards"`
}

// AccountProxyInput is the flat create body for CreateProxy. Password +
// the VPN blocks carry write-only secret material (wrapped server-side).
type AccountProxyInput struct {
	Label     string         `json:"label"`
	Scheme    string         `json:"scheme,omitempty"` // empty omitted → server default (socks5); "" would fail the enum
	Host      string         `json:"host"`
	Port      int            `json:"port"`
	Username  *string        `json:"username,omitempty"`
	Password  *string        `json:"password,omitempty"`
	OpenVPN   map[string]any `json:"openvpn,omitempty"`
	WireGuard map[string]any `json:"wireguard,omitempty"`
}

// AccountProxyMetadata is the public-safe envelope returned by
// CreateProxy / UpdateProxy + ListProxies items. The secret itself is
// never returned — HasPassword / HasSecret signal whether one is stored.
type AccountProxyMetadata struct {
	ID          string  `json:"id"`
	Label       string  `json:"label"`
	Scheme      string  `json:"scheme"`
	Host        string  `json:"host"`
	Port        int     `json:"port"`
	Username    *string `json:"username"`
	HasPassword bool    `json:"has_password"`
	HasSecret   bool    `json:"has_secret"`
	CreatedAt   string  `json:"created_at"`
	UpdatedAt   string  `json:"updated_at"`
	// QuicMeasured is 'h3' or 'h2-only' once a live session through this proxy
	// reported its transport, or null when never measured. QuicMeasuredAt is
	// when that measurement was taken (RFC 3339), or null.
	QuicMeasured   *string `json:"quic_measured"`
	QuicMeasuredAt *string `json:"quic_measured_at"`
	// ExitObserved is the last exit identity observed THROUGH this proxy — by a
	// live session (observed_via "session") or by the fleet-vantage test
	// ("probe"), latest wins — or nil when never observed. For an OpenVPN /
	// WireGuard proxy this is the only source of its location and timezone
	// short of running a test. Nil is "not observed", never a placeholder.
	ExitObserved *AccountProxyExitObserved `json:"exit_observed"`
}

// AccountProxyExitObserved is the stored exit identity on AccountProxyMetadata.
// Country and Timezone are nil when the observer could not resolve them;
// ObservedAt is when the observation was recorded (RFC 3339), or nil.
type AccountProxyExitObserved struct {
	IP          string  `json:"ip"`
	Country     *string `json:"country"`
	Timezone    *string `json:"timezone"`
	ObservedVia string  `json:"observed_via"`
	ObservedAt  *string `json:"observed_at"`
}

// AccountProxyList is the GET /v1/account/me/proxies envelope.
type AccountProxyList struct {
	Data []AccountProxyMetadata `json:"data"`
}

// AccountProxyTestResult is the POST :id/test result. Ok=true carries
// LatencyMs; Ok=false carries Reason. 200 either way.
//
// NotRun is set when NOTHING RAN, so an Ok=false result is not a verdict
// about the proxy: "live_session" (a fleet-vantage test of a VPN proxy was
// refused because a live session holds the tunnel), "node_busy" or
// "node_error" (the fleet node could not run the probe). Branch on it —
// never on the Reason prose — before treating Ok=false as a failed proxy.
type AccountProxyTestResult struct {
	Ok        bool   `json:"ok"`
	LatencyMs int    `json:"latency_ms,omitempty"`
	Reason    string `json:"reason,omitempty"`
	NotRun    string `json:"not_run,omitempty"`
}

// AttachToSession sets the proxy config for a session. The body's
// SessionID MUST match the URL sessionID or the server rejects with
// 400.
func (r *EgressResource) AttachToSession(ctx context.Context, sessionID string, config *SessionEgressConfig) (*SessionProxyAttachResponse, error) {
	var out SessionProxyAttachResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/sessions/" + url.PathEscape(sessionID) + "/proxy",
		body:   config,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetSessionProxy reads the session's current proxy summary.
// Returns NotFound (404) if no proxy has been attached.
func (r *EgressResource) GetSessionProxy(ctx context.Context, sessionID string) (*SessionProxyAttachResponse, error) {
	var out SessionProxyAttachResponse
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/sessions/" + url.PathEscape(sessionID) + "/proxy",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListProxies returns the calling account's saved proxies (metadata only).
func (r *EgressResource) ListProxies(ctx context.Context) (*AccountProxyList, error) {
	var out AccountProxyList
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/account/me/proxies",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateProxy stores a reusable proxy config and returns its metadata.
// password / the VPN config_blob / private_key are write-only — wrapped
// server-side, never echoed back.
func (r *EgressResource) CreateProxy(ctx context.Context, body *AccountProxyInput) (*AccountProxyMetadata, error) {
	var out AccountProxyMetadata
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/account/me/proxies",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// UpdateProxy patches a saved proxy. The body is a loose map so callers
// preserve the omit-vs-null secret semantics (omit a field to keep it, a
// null password to clear it, a string to (re)wrap it).
func (r *EgressResource) UpdateProxy(ctx context.Context, proxyID string, body map[string]any) (*AccountProxyMetadata, error) {
	var out AccountProxyMetadata
	if err := r.client.do(ctx, requestOptions{
		method: "PUT",
		path:   "/v1/account/me/proxies/" + url.PathEscape(proxyID),
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteProxy removes a saved proxy by id.
func (r *EgressResource) DeleteProxy(ctx context.Context, proxyID string) error {
	return r.client.do(ctx, requestOptions{
		method: "DELETE",
		path:   "/v1/account/me/proxies/" + url.PathEscape(proxyID),
	})
}

// TestProxy runs a server-side reachability probe (SSRF-guarded) of a
// saved proxy's host:port. 200 either way: Ok=true+LatencyMs when
// reachable, Ok=false+Reason when not.
func (r *EgressResource) TestProxy(ctx context.Context, proxyID string) (*AccountProxyTestResult, error) {
	var out AccountProxyTestResult
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/account/me/proxies/" + url.PathEscape(proxyID) + "/test",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}
