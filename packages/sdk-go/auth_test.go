package driftstack

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

func TestAuth_Signup(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/auth/signup" || r.Method != "POST" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(SignupResponse{
			AccountID:       "acc_00000000-0000-4000-8000-000000000001",
			VerifyEmailSent: true,
		})
	})
	got, err := client.Auth.Signup(context.Background(), &SignupRequest{
		Email:    "tester@driftstack.local",
		Password: "supersecret",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !got.VerifyEmailSent || got.AccountID == "" {
		t.Errorf("unexpected response: %+v", got)
	}
}

func TestAuth_Login(t *testing.T) {
	t.Parallel()
	expiresAt := time.Now().Add(7 * 24 * time.Hour).UTC().Truncate(time.Second)
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/auth/login" {
			t.Errorf("path=%q", r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(LoginResponse{
			AccountID:    "acc_00000000-0000-4000-8000-000000000001",
			SessionToken: "ds_web_abc123",
			ExpiresAt:    expiresAt,
		})
	})
	got, err := client.Auth.Login(context.Background(), &LoginRequest{
		Email:    "tester@driftstack.local",
		Password: "supersecret",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.SessionToken != "ds_web_abc123" {
		t.Errorf("session_token=%q", got.SessionToken)
	}
	if !got.ExpiresAt.Equal(expiresAt) {
		t.Errorf("expires_at=%v", got.ExpiresAt)
	}
}

func TestAuth_RequestMagicLink(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/auth/magic-link/request" {
			t.Errorf("path=%q", r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(MagicLinkRequestResponse{Sent: true})
	})
	got, err := client.Auth.RequestMagicLink(context.Background(), &MagicLinkRequest{Email: "x@y.z"})
	if err != nil || !got.Sent {
		t.Errorf("err=%v got=%+v", err, got)
	}
}

func TestAuth_Logout(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/auth/logout" {
			t.Errorf("path=%q", r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(LogoutResponse{OK: true})
	})
	got, err := client.Auth.Logout(context.Background(), &LogoutRequest{SessionToken: "ds_web_abc"})
	if err != nil || !got.OK {
		t.Errorf("err=%v got=%+v", err, got)
	}
}
