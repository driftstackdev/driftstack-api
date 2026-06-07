package driftstack

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Security invariant: the API key must NEVER appear in a returned error.
// Errors are built from the response (problem body / status) or the transport
// failure (which wraps net/url errors carrying the URL + cause, never the
// request headers where `Authorization: Bearer <apiKey>` lives). If a refactor
// ever wrapped the request/headers into an error, the customer's key would leak
// into THEIR logs. These guard both error paths.
const secretKeyNoLeak = "ds_live_DO_NOT_LEAK_abcdefghijklmnop"

func assertNoKeyLeak(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	// err.Error() of a %w-wrapped chain includes every wrapped error's text,
	// so a single Contains check covers the whole cause chain.
	if strings.Contains(err.Error(), secretKeyNoLeak) {
		t.Errorf("API key leaked into error: %v", err)
	}
}

func TestErrors_APIKeyNotLeakedOnProblemResponse(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/problem+json")
		w.WriteHeader(404)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"type":   "https://errors.driftstack.dev/not-found",
			"title":  "Not Found",
			"status": 404,
		})
	}))
	t.Cleanup(srv.Close)
	client := New(secretKeyNoLeak, WithBaseURL(srv.URL), WithRetry(RetryConfig{MaxRetries: 0}))
	t.Cleanup(func() { _ = client.Close() })

	_, err := client.APIKeys.List(context.Background())
	assertNoKeyLeak(t, err)
}

func TestErrors_APIKeyNotLeakedOnNetworkFailure(t *testing.T) {
	t.Parallel()
	// 127.0.0.1:1 refuses connections → transport error path.
	client := New(secretKeyNoLeak, WithBaseURL("http://127.0.0.1:1"), WithRetry(RetryConfig{MaxRetries: 0}))
	t.Cleanup(func() { _ = client.Close() })

	_, err := client.APIKeys.List(context.Background())
	assertNoKeyLeak(t, err)
}
