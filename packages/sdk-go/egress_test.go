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

func TestEgress_SaveProxy(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/proxies" || r.Method != "POST" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(SavedProxySummary{ID: "proxy_1", Label: "team", Type: "socks5"})
	})
	got, err := client.Egress.SaveProxy(context.Background(), &SavedProxyConfig{
		Label: "team",
		Proxy: map[string]any{"type": "socks5"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "proxy_1" || got.Label != "team" {
		t.Errorf("summary=%+v", got)
	}
}

func TestEgress_ListSavedProxies_EmptyList(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/proxies" || r.Method != "GET" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(ListSavedProxiesResponse{Data: []SavedProxySummary{}})
	})
	got, err := client.Egress.ListSavedProxies(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Data) != 0 {
		t.Errorf("expected empty list, got %d", len(got.Data))
	}
}

func TestEgress_DeleteSavedProxy(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/proxies/proxy_1" || r.Method != "DELETE" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	})
	if err := client.Egress.DeleteSavedProxy(context.Background(), "proxy_1"); err != nil {
		t.Fatal(err)
	}
}
