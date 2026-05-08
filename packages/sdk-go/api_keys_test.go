package driftstack

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

// V-296 — APIKeysResource.Rotate test.
func TestAPIKeys_Rotate(t *testing.T) {
	t.Parallel()
	graceEnd := time.Now().Add(24 * time.Hour).UTC().Truncate(time.Second)
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/api-keys/key_old/rotate" || r.Method != "POST" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		var body RotateAPIKeyRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Name != "production-2025" {
			t.Errorf("name=%q", body.Name)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(RotateAPIKeyResponse{
			CreateAPIKeyResponse: CreateAPIKeyResponse{
				APIKey: APIKey{
					ID:        "key_new",
					Name:      "production-2025",
					KeyPrefix: "ds_live_NEWKEY",
					Scopes:    []APIKeyScope{ScopeRead, ScopeWrite},
					CreatedAt: time.Now().UTC().Truncate(time.Second),
				},
				Plaintext: "ds_live_NEWKEYsecretsecretsecretsecretsecre",
			},
			RotatedFrom:       "key_old",
			GracePeriodEndsAt: graceEnd,
		})
	})

	got, err := client.APIKeys.Rotate(
		context.Background(),
		"key_old",
		&RotateAPIKeyRequest{Name: "production-2025"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if got.RotatedFrom != "key_old" {
		t.Errorf("rotated_from=%q", got.RotatedFrom)
	}
	if got.Plaintext == "" {
		t.Error("plaintext empty")
	}
	if !got.GracePeriodEndsAt.Equal(graceEnd) {
		t.Errorf("grace_period_ends_at=%v", got.GracePeriodEndsAt)
	}
}

// V-296 — Rotate with nil body uses default empty request.
func TestAPIKeys_Rotate_NilBody(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		var body RotateAPIKeyRequest
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Name != "" {
			t.Errorf("expected empty name, got %q", body.Name)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(RotateAPIKeyResponse{
			CreateAPIKeyResponse: CreateAPIKeyResponse{
				APIKey:    APIKey{ID: "key_new", CreatedAt: time.Now().UTC()},
				Plaintext: "p",
			},
			RotatedFrom:       "key_old",
			GracePeriodEndsAt: time.Now().UTC().Add(24 * time.Hour),
		})
	})
	if _, err := client.APIKeys.Rotate(context.Background(), "key_old", nil); err != nil {
		t.Fatal(err)
	}
}
