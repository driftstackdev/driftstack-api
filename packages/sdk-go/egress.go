package driftstack

import (
	"context"
	"net/url"
)

// EgressResource handles /v1/sessions/{id}/proxy + /v1/proxies
// (planning 133 EGRESS Phase 1+). Mirrors the TypeScript +
// Python SDK egress resources.
//
// Server registers these endpoints as 503 FeatureUnavailable stubs
// until a concrete SOCKS5 backend is wired. The SDK surface is
// stable so consumers can compile ahead of time.
//
// SECURITY: list/get responses NEVER echo raw secret material
// (SOCKS5 password, OpenVPN .ovpn body, WireGuard private_key);
// re-enter to update.
type EgressResource struct {
	client *Client
}

// SessionEgressConfig is the body shape for AttachToSession.
// Use map[string]any for nested shapes — keeping the type loose
// matches the existing SDK pattern for non-billing surfaces and
// avoids over-eager binding before EG-API-1.6 lands.
type SessionEgressConfig struct {
	SessionID       string                 `json:"session_id"`
	Proxy           map[string]any         `json:"proxy"`
	EgressSafeguard map[string]bool        `json:"egress_safeguard"`
}

// SavedProxyConfig is the body shape for SaveProxy.
type SavedProxyConfig struct {
	Label string         `json:"label"`
	Proxy map[string]any `json:"proxy"`
}

// SessionProxyAttachResponse is the public-safe envelope returned
// by AttachToSession + GetSessionProxy. Carries only the proxy type
// + safeguard flags — never raw secret material.
type SessionProxyAttachResponse struct {
	Type       string          `json:"type"`
	Safeguards map[string]bool `json:"safeguards"`
}

// SavedProxySummary is the public-safe envelope returned by SaveProxy
// + ListSavedProxies items.
type SavedProxySummary struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Type  string `json:"type"`
}

// ListSavedProxiesResponse is the GET /v1/proxies envelope.
type ListSavedProxiesResponse struct {
	Data []SavedProxySummary `json:"data"`
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

// SaveProxy stores a reusable proxy config and returns its summary.
// The raw secret material is NEVER readable after save — re-enter
// to update.
func (r *EgressResource) SaveProxy(ctx context.Context, body *SavedProxyConfig) (*SavedProxySummary, error) {
	var out SavedProxySummary
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/proxies",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListSavedProxies returns the calling account's saved proxy
// summaries. Stays 200 + empty-list across postures (matches the
// TS + Python SDK behavior — read-only listing exempt from the
// activation-gate stub pattern).
func (r *EgressResource) ListSavedProxies(ctx context.Context) (*ListSavedProxiesResponse, error) {
	var out ListSavedProxiesResponse
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/proxies",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteSavedProxy removes a saved proxy by id.
func (r *EgressResource) DeleteSavedProxy(ctx context.Context, proxyID string) error {
	return r.client.do(ctx, requestOptions{
		method: "DELETE",
		path:   "/v1/proxies/" + url.PathEscape(proxyID),
	})
}
