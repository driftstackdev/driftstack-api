package driftstack

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newServer(t *testing.T, handler http.HandlerFunc) (*httptest.Server, *Client) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	client := New("ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", WithBaseURL(srv.URL))
	t.Cleanup(func() { _ = client.Close() })
	return srv, client
}

func sessionFixture() Session {
	var label *string
	return Session{
		ID:        "ses_00000000-0000-4000-8000-000000000001",
		AccountID: "acc_00000000-0000-4000-8000-000000000001",
		APIKeyID:  "key_00000000-0000-4000-8000-000000000001",
		Status:    SessionReady,
		Archetype: "iphone16pro_ios18_7_safari26_4",
		Label:     label,
	}
}

func TestSessions_Create(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/v1/sessions" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") == "" {
			t.Error("missing Authorization header")
		}
		if !strings.HasPrefix(r.Header.Get("User-Agent"), "driftstack-sdk-go/") {
			t.Errorf("user-agent=%q", r.Header.Get("User-Agent"))
		}
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(201)
		_ = json.NewEncoder(w).Encode(sessionFixture())
	})

	got, err := client.Sessions.Create(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != sessionFixture().ID {
		t.Errorf("id=%q", got.ID)
	}
}

func TestSessions_List_PassesQueryParams(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("limit") != "50" {
			t.Errorf("limit=%q", r.URL.Query().Get("limit"))
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(SessionsListPage{
			Data:    []Session{sessionFixture()},
			HasMore: false,
		})
	})

	got, err := client.Sessions.List(context.Background(), &ListSessionsQuery{Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Data) != 1 || got.HasMore {
		t.Errorf("unexpected page: %+v", got)
	}
}

func TestSessions_Navigate_SerializesBody(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/sessions/ses_x/navigate" {
			t.Errorf("path=%q", r.URL.Path)
		}
		var body NavigateRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.URL != "https://example.com/" {
			t.Errorf("body.url=%q", body.URL)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(NavigateResponse{
			URL: body.URL, Status: 200, FinalURL: body.URL, DurationMS: 100,
		})
	})

	got, err := client.Sessions.Navigate(context.Background(), "ses_x", &NavigateRequest{
		URL: "https://example.com/",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != 200 {
		t.Errorf("status=%d", got.Status)
	}
}

func TestSessions_Destroy_204_ReturnsNil(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(204)
	})
	if err := client.Sessions.Destroy(context.Background(), "ses_x"); err != nil {
		t.Fatal(err)
	}
}

func TestSessions_PathEscaping(t *testing.T) {
	t.Parallel()
	calledRawPath := ""
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		// EscapedPath returns the wire form (with %XX escapes) — Path
		// is the decoded version.
		calledRawPath = r.URL.EscapedPath()
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(sessionFixture())
	})
	if _, err := client.Sessions.Get(context.Background(), "ses_with/slash"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(calledRawPath, "ses_with%2Fslash") {
		t.Errorf("escaped_path=%q (expected slash to be URL-encoded)", calledRawPath)
	}
}

func TestProblemJsonMapsToTypedError(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/problem+json")
		w.Header().Set("retry-after", "7")
		w.WriteHeader(429)
		_, _ = w.Write([]byte(`{"type":"https://errors.driftstack.dev/rate-limited","title":"Rate limited","status":429,"detail":"slow down"}`))
	})
	// Disable retry so we observe the error directly rather than the
	// loop swallowing it.
	client.retry = RetryConfig{Disabled: true}

	_, err := client.Sessions.Create(context.Background(), nil)
	var rl *RateLimitError
	if !errors.As(err, &rl) {
		t.Fatalf("expected RateLimitError, got %T (%v)", err, err)
	}
	if rl.RetryAfterSeconds != 7 {
		t.Errorf("retry_after=%d", rl.RetryAfterSeconds)
	}
}

func TestAPIKeys_CreateReturnsPlaintext(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/v1/api-keys" {
			t.Errorf("path=%q", r.URL.Path)
		}
		w.WriteHeader(201)
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id":         "key_00000000-0000-4000-8000-000000000001",
			"name":       "ci",
			"key_prefix": "ds_live_aaaa",
			"scopes":     []string{"read", "write"},
			"created_at": "2026-05-02T10:00:00Z",
			"plaintext":  "ds_live_secretsecretsecretsecretsecretsec",
		})
	})

	got, err := client.APIKeys.Create(context.Background(), &CreateAPIKeyRequest{
		Name: "ci", Scopes: []APIKeyScope{ScopeRead, ScopeWrite},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(got.Plaintext, "ds_live_") {
		t.Errorf("plaintext=%q", got.Plaintext)
	}
}

func TestUsage_CurrentPeriod(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"period_start": "2026-05-01T00:00:00Z",
			"period_end":   "2026-06-01T00:00:00Z",
			"tier":         "api_builder",
			"totals":       map[string]int{"navigate": 5},
			"quotas":       map[string]int{"navigate": 25000},
		})
	})

	got, err := client.Usage.CurrentPeriod(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got.Tier != TierAPIBuilder {
		t.Errorf("tier=%q", got.Tier)
	}
}

func TestWebhooks_CreateReturnsSecret(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(201)
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id":                   "whk_00000000-0000-4000-8000-000000000001",
			"url":                  "https://customer.test/hook",
			"secret_prefix":        "whsec_aaaa",
			"events":               []string{"session.completed"},
			"description":          nil,
			"active":               true,
			"consecutive_failures": 0,
			"last_success_at":      nil,
			"last_failure_at":      nil,
			"disabled_at":          nil,
			"created_at":           "2026-05-02T10:00:00Z",
			"secret":               "whsec_secretsecretsecretsecretsecretsec",
		})
	})

	got, err := client.Webhooks.Create(context.Background(), &CreateWebhookRequest{
		URL:    "https://customer.test/hook",
		Events: []WebhookEventType{EventSessionCompleted},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(got.Secret, "whsec_") {
		t.Errorf("secret=%q", got.Secret)
	}
}

func TestWebhooks_ListDeliveries_StatusFilter(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("status") != "delivered" {
			t.Errorf("status=%q", r.URL.Query().Get("status"))
		}
		if r.URL.Query().Get("limit") != "25" {
			t.Errorf("limit=%q", r.URL.Query().Get("limit"))
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(WebhookDeliveryListPage{Data: []WebhookDelivery{}})
	})

	_, err := client.Webhooks.ListDeliveries(context.Background(), "whk_x", &ListDeliveriesQuery{
		Status: DeliveryDelivered,
		Limit:  25,
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestRetryRecoversFromTransientNetworkBlip(t *testing.T) {
	t.Parallel()
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			// Force a connection-side failure on the first attempt by
			// hijacking + closing.
			hj, _ := w.(http.Hijacker)
			conn, _, _ := hj.Hijack()
			_ = conn.Close()
			return
		}
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(201)
		_ = json.NewEncoder(w).Encode(sessionFixture())
	}))
	t.Cleanup(srv.Close)

	client := New("ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		WithBaseURL(srv.URL),
		WithRetry(RetryConfig{MaxRetries: 2, InitialDelay: 1 * 1000 * 1000, MaxDelay: 2 * 1000 * 1000}),
	)
	t.Cleanup(func() { _ = client.Close() })

	got, err := client.Sessions.Create(context.Background(), nil)
	if err != nil {
		t.Fatalf("expected retry to succeed, got %v after %d calls", err, calls)
	}
	if got.ID == "" {
		t.Errorf("empty session")
	}
	if calls != 2 {
		t.Errorf("calls=%d, want 2 (one fail + one success)", calls)
	}
}
