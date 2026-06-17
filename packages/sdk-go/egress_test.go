package driftstack

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func TestEgress_AttachToSession(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/sessions/ses_xyz/proxy" || r.Method != "POST" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["session_id"] != "ses_xyz" {
			t.Errorf("session_id=%v", body["session_id"])
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(SessionProxyAttachResponse{
			Type: "socks5",
			Safeguards: map[string]bool{
				"block_direct_internet":     true,
				"block_unproxied_dns":       true,
				"block_webrtc_stun_leakage": true,
			},
		})
	})
	got, err := client.Egress.AttachToSession(context.Background(), "ses_xyz", &SessionEgressConfig{
		SessionID: "ses_xyz",
		Proxy: map[string]any{
			"type":   "socks5",
			"socks5": map[string]any{"host": "p.example", "port": 1080, "udp_associate": true},
		},
		EgressSafeguard: map[string]bool{
			"block_direct_internet":     true,
			"block_unproxied_dns":       true,
			"block_webrtc_stun_leakage": true,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.Type != "socks5" {
		t.Errorf("type=%q", got.Type)
	}
}

func TestEgress_AttachToSession_URLEscapesSessionID(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		// EscapedPath returns the URL-encoded form (preserves %20);
		// r.URL.Path is the decoded form.
		if r.URL.EscapedPath() != "/v1/sessions/ses%20with%20space/proxy" {
			t.Errorf("escaped path=%q", r.URL.EscapedPath())
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(SessionProxyAttachResponse{Type: "socks5"})
	})
	_, err := client.Egress.AttachToSession(context.Background(), "ses with space", &SessionEgressConfig{
		SessionID: "ses with space",
		Proxy:     map[string]any{"type": "socks5"},
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestEgress_GetSessionProxy(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/sessions/ses_xyz/proxy" || r.Method != "GET" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(SessionProxyAttachResponse{Type: "socks5"})
	})
	got, err := client.Egress.GetSessionProxy(context.Background(), "ses_xyz")
	if err != nil {
		t.Fatal(err)
	}
	if got.Type != "socks5" {
		t.Errorf("type=%q", got.Type)
	}
}

func TestEgress_CreateProxy(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/account/me/proxies" || r.Method != "POST" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(AccountProxyMetadata{ID: "apx_1", Label: "team", Scheme: "socks5"})
	})
	got, err := client.Egress.CreateProxy(context.Background(), &AccountProxyInput{
		Label:  "team",
		Scheme: "socks5",
		Host:   "x.example",
		Port:   1080,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "apx_1" || got.Label != "team" {
		t.Errorf("metadata=%+v", got)
	}
}

func TestEgress_ListProxies_EmptyList(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/account/me/proxies" || r.Method != "GET" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(AccountProxyList{Data: []AccountProxyMetadata{}})
	})
	got, err := client.Egress.ListProxies(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Data) != 0 {
		t.Errorf("expected empty list, got %d", len(got.Data))
	}
}

func TestEgress_UpdateProxy(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/account/me/proxies/apx_1" || r.Method != "PUT" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(AccountProxyMetadata{ID: "apx_1", Label: "renamed"})
	})
	got, err := client.Egress.UpdateProxy(context.Background(), "apx_1", map[string]any{"label": "renamed"})
	if err != nil {
		t.Fatal(err)
	}
	if got.Label != "renamed" {
		t.Errorf("metadata=%+v", got)
	}
}

func TestEgress_DeleteProxy(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/account/me/proxies/apx_1" || r.Method != "DELETE" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	})
	if err := client.Egress.DeleteProxy(context.Background(), "apx_1"); err != nil {
		t.Fatal(err)
	}
}

func TestEgress_TestProxy(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/account/me/proxies/apx_1/test" || r.Method != "POST" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(AccountProxyTestResult{Ok: true, LatencyMs: 42})
	})
	got, err := client.Egress.TestProxy(context.Background(), "apx_1")
	if err != nil {
		t.Fatal(err)
	}
	if !got.Ok || got.LatencyMs != 42 {
		t.Errorf("result=%+v", got)
	}
}
